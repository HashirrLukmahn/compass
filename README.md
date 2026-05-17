# Compass

**A Notion-native marketing intelligence agent for early-stage startups.**

Early-stage startups fly blind on marketing decisions — which events to sponsor,
which conferences to attend, which channels to invest in. There's no feedback
loop connecting spend to outcomes. Compass fixes this by living entirely inside
Notion.

You drop a marketing opportunity into a Notion database — or paste an event link
into the Compass agent and chat with it. Compass autonomously researches the
opportunity, scores it against your ICP and past bets, checks your remaining
budget, and writes a clear Decision Brief — in about 20 seconds. When you mark it
Approved, it deducts the budget and logs the decision. When you reject one, it
finds 3 real alternative events that fit your budget. Two weeks after the event,
it checks your GitHub stars delta and closes the feedback loop.

Over time, Compass builds the proprietary dataset your gut can't.

## Architecture

There is no separate backend or frontend. Notion is the entire UI. A single
[Notion Worker](https://developers.notion.com/workers/get-started/overview)
(TypeScript) is the only runtime. An optional Notion **custom agent** sits on
top as a conversational interface that orchestrates the worker's tools.

```
            ┌─ Notion custom agent (conversational) ─┐
            │  paste a link / "evaluate this" / etc.  │
            └───────────────┬────────────────────────┘
                            │ calls worker tools
Opportunity Inbox (Notion DB)
        │  page added / Status→New  →  automation  →  webhook: onNewOpportunity
        ▼
  research.ts ── Exa web search ──┐
  decisions.ts ── past bets ──────┤──→ Claude (claude-sonnet-4-6) ──→ Decision Brief page
  budget.ts ── remaining budget ──┘                                  + Agent Summary field
        │  Status → Approved/Rejected  →  automation  →  webhook: onDecisionMade
        ▼
  Approved: budget.ts (deduct + ledger line)  +  decisions.ts (log)
  Rejected: decisions.ts (log)  +  alternatives.ts (3 real events via Exa)
        │  ≥2 weeks post-event  →  tool: collectOutcomes
        ▼
  outcome.ts ── GitHub stars delta ──→ Decision Log
```

Worker capabilities:

- `webhook onNewOpportunity` — research + Decision Brief + Agent Summary
- `webhook onDecisionMade` — Approved: budget deduction + ledger + log. Rejected: log
- `tool addOpportunityFromUrl` — parse an event URL into structured fields (creates nothing; reports missing fields like cost)
- `tool createOpportunity` — create an Opportunity row and run the full research pipeline
- `tool decideOpportunity` — approve/reject an opportunity by name
- `tool findAlternatives` — on reject, return 3 real budget-fit alternative events
- `tool collectOutcomes` — post-event GitHub stars delta
- `tool runResearch` / `tool runDecision` — internal manual fallbacks (by page ID)

The `addOpportunityFromUrl` / `createOpportunity` / `decideOpportunity` /
`findAlternatives` tools are designed for the conversational agent and identify
opportunities by **name or URL** — never raw page IDs.

## Notion databases

Three databases, each shared with the integration via the **•••  → Connections**
menu. Property names below are what the code expects:

**Opportunity Inbox** — `Name` (title), `Cost` (number),
`Event Start Date` / `Event End Date` (date),
`Category` (multi-select: Conference / Sponsorship / Meetup / Newsletter /
Demo Night / Founder/VC Meeting / Others),
`Status` (select: New / Researching / Decision Ready / Approved / Rejected),
`Brief Page` (url), `Notes` (text), `Agent Summary` (text — written by the
worker so the agent can surface highlights without opening the brief).

**Decision Log** — `Opportunity Name` (title), `Decision` (select:
Approved/Rejected), `Amount Spent` (number), `Category` (multi-select),
`Event Start Date` (date), `Decision Date` (date), `Outcome Score` (number),
`GitHub Stars Delta` (number), `Outcome Notes` (text), `Brief Page` (url).

**Budget Tracker** — `Label` (title), `Total Budget` (number), `Spent`
(number), `Remaining` (formula: `prop("Total Budget") - prop("Spent")`),
`Period` (select: Q1/Q2/Q3/Q4). Approved decisions also append a transaction
line to this page's body, linking back to the opportunity.

> The code reads only the properties it needs and tolerates Category being
> single- or multi-select. Extra columns (e.g. an auto-increment ID) are ignored.

## Setup

Requires Node.js 22+ and the [Notion CLI](https://developers.notion.com/cli/get-started/overview)
(`ntn`). On Windows, `ntn` has no native build — run it from WSL (Ubuntu).

> **Windows/WSL notes:**
> - Authenticate with `NOTION_KEYRING=0 ntn login` (file-based auth, no
>   browser/keychain needed) and prefix **every** `ntn` command with
>   `NOTION_KEYRING=0` so auth persists across shells.
> - Do **not** run `ntn workers deploy` from a OneDrive / `drvfs`-mounted path —
>   the bundler reads corrupt bytes. Keep your source anywhere, but copy it to a
>   native ext4 path (e.g. `~/compass-worker`) and deploy from there.

```bash
NOTION_KEYRING=0 ntn login          # prints a URL; approve, it auto-continues

# Deploy the worker (from a native Linux filesystem path)
cd notion-worker
npm install
NOTION_KEYRING=0 ntn workers deploy --name compass --no-git   # first deploy only
# subsequent deploys: NOTION_KEYRING=0 ntn workers deploy --no-git

# Set worker secrets. NOTE: env var names cannot start with NOTION_ (reserved)
# EXCEPT the special NOTION_API_TOKEN, which authenticates the worker's client.
NOTION_KEYRING=0 ntn workers env set \
  NOTION_API_TOKEN=ntn_... ANTHROPIC_API_KEY=sk-ant-... EXA_API_KEY=... \
  OPPORTUNITY_DB_ID=... DECISION_LOG_DB_ID=... BUDGET_DB_ID=... \
  GITHUB_REPO_OWNER=... GITHUB_REPO_NAME=...

# Seed demo data into the Decision Log
cd ../scripts
cp ../.env.example ../.env     # fill NOTION_API_KEY + NOTION_DECISION_LOG_DB_ID
npm install
npx tsx seed-demo-data.ts
```

Database IDs are the 32-char hex in each database's URL. `NOTION_API_TOKEN`,
`OPPORTUNITY_DB_ID`, `DECISION_LOG_DB_ID`, and `BUDGET_DB_ID` are all required.
`GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME` power the post-event stars signal.

### Wire the Notion automations (event-driven path)

Get the webhook URLs:

```bash
cd notion-worker && NOTION_KEYRING=0 ntn workers webhooks list
```

In Notion, on the **Opportunity Inbox** database, add two automations
(••• → Automations):

1. **When** `Status` is edited **and** `Status` is `New` → **Then** Send webhook
   → paste the `onNewOpportunity` URL.
2. **When** `Status` is edited → **Then** Send webhook → paste the
   `onDecisionMade` URL.

> Use the `Status is New` **condition** on automation #1 — without it, the
> worker's own `New → Researching → Decision Ready` edits re-trigger research and
> create duplicate briefs. The worker is also idempotent (it skips if a Brief
> Page already exists), but the condition keeps things clean.
>
> Notion automations generally fire on **manual** edits, not integration/API
> edits. The conversational agent path below drives everything through worker
> tools and does not depend on automations firing.

### Set up the Compass agent (conversational path)

In Notion → **Notion AI → Agents → New agent**, name it `Compass`:

1. **System prompt:** paste the full contents of
   [`notion-worker/notion-agent/system-prompt.md`](notion-worker/notion-agent/system-prompt.md).
2. **Connect databases:** add `Opportunity Inbox` (read + write),
   `Decision Log` (read), `Budget Tracker` (read).
3. **Connect the Compass worker** so the agent can call its tools. You should
   see the worker's tools listed (Parse Opportunity From URL, Create And
   Evaluate Opportunity, Approve Or Reject Opportunity, Find Alternative
   Opportunities, etc.).
4. **Model:** if offered a choice, use `claude-sonnet-4-6`.
5. Leave web access **off** — the worker does all web research via Exa; the
   agent only orchestrates.

> If you redeploy and change a tool's input schema, the agent caches the old
> schema. Disconnect and reconnect the worker in the agent settings (close the
> settings fully in between) to force a schema refresh.

## Demo

**Conversational (recommended):**

1. Paste an event link to the Compass agent: *"Evaluate this for us:
   https://luma.com/..."*
2. The agent calls `addOpportunityFromUrl`. Ticket/sponsorship price is rarely
   on the page, so it asks: *"Are you attending or sponsoring, and at what
   cost?"* (It never fabricates a budget figure.)
3. You answer (e.g. *"$3,000 community sponsorship"*). The agent calls
   `createOpportunity` → row created, research runs, Decision Brief + Agent
   Summary generated (~20s).
4. The agent reads `Agent Summary` and gives the recommendation with
   audience-fit score, budget impact %, comparable past bet, and confidence.
5. You say *"reject it"* → `decideOpportunity` logs it → the agent calls
   `findAlternatives` and surfaces 3 real budget-fit events with links.
6. Pick one → the agent calls `createOpportunity` again → loop.

**Database-driven (no agent):**

1. Add a row to Opportunity Inbox: name, cost, an event date, a category,
   Status `New`.
2. Decision Brief sub-page auto-generates in ~20s.
3. Set Status to `Approved` → Budget Tracker `Spent` updates, a transaction
   line is appended to the budget page, and the decision is logged.
4. Post-event: `NOTION_KEYRING=0 ntn workers exec collectOutcomes` writes the
   GitHub stars delta back to the Decision Log.

**Manual fallback (by page ID):**

```bash
NOTION_KEYRING=0 ntn workers exec runResearch -d '{"pageId":"<id>"}'
NOTION_KEYRING=0 ntn workers exec runDecision -d '{"pageId":"<id>"}'
```

## Outcome collector scheduling

The Workers runtime has no native cron. `collectOutcomes` is a tool: run it
manually via `ntn workers exec collectOutcomes`, or wire it to a Notion
scheduled automation. It only processes Approved decisions whose event was
≥2 weeks ago and that have no stars delta yet.

## License

MIT — see [LICENSE](LICENSE).
