# Compass

**A Notion-native marketing intelligence agent for early-stage startups.**

Early-stage startups fly blind on marketing decisions — which events to sponsor,
which conferences to attend, which channels to invest in. There's no feedback
loop connecting spend to outcomes. Compass fixes this by living entirely inside
Notion.

You drop a marketing opportunity into a Notion database. Compass autonomously
researches it, scores it against your ICP and past bets, checks your remaining
budget, and writes a clear Decision Brief — in about 20 seconds. When you mark it
Approved, it deducts the budget and logs the decision. Two weeks after the event,
it checks your GitHub stars delta and closes the feedback loop.

Over time, Compass builds the proprietary dataset your gut can't.

## Architecture

There is no separate backend or frontend. Notion is the entire UI. A single
[Notion Worker](https://developers.notion.com/workers/get-started/overview)
(TypeScript) is the only runtime.

```
Opportunity Inbox (Notion DB)
        │  page added  →  Notion automation "Send webhook"  →  webhook: onNewOpportunity
        ▼
  research.ts ── Exa web search ──┐
  decisions.ts ── past bets ──────┤──→ Claude (claude-sonnet-4-6) ──→ Decision Brief page
  budget.ts ── remaining budget ──┘
        │  Status → Approved/Rejected  →  Notion automation  →  webhook: onDecisionMade
        ▼
  budget.ts (deduct)  +  decisions.ts (log to Decision Log)
        │  ≥2 weeks post-event  →  tool: collectOutcomes
        ▼
  outcome.ts ── GitHub stars delta ──→ Decision Log
```

Worker capabilities:
- `webhook onNewOpportunity` — research + Decision Brief
- `webhook onDecisionMade` — budget deduction + decision logging
- `tool collectOutcomes` — post-event GitHub stars delta
- `tool runResearch` / `tool runDecision` — manual fallbacks (run the same
  pipelines by page ID via `ntn workers exec`, no automation needed)

## Notion databases

Three databases, each shared with the integration via the **•••  → Connections**
menu. Property names below are what the code expects:

**Opportunity Inbox** — `Name` (title), `Cost` (number),
`Event Start Date` / `Event End Date` (date),
`Category` (multi-select), `Status` (select: New/Researching/Decision Ready/
Approved/Rejected), `Brief Page/Event Page` (url), `Notes` (text).

**Decision Log** — `Opportunity Name` (title), `Decision` (select:
Approved/Rejected), `Amount Spent` (number), `Category` (multi-select),
`Event Start Date` (date), `Decision Date` (date), `Outcome Score` (number),
`GitHub Stars Delta` (number), `Outcome Notes` (text), `Brief Page` (url).

**Budget Tracker** — `Label` (title), `Total Budget` (number), `Spent`
(number), `Remaning` (formula: `prop("Total Budget") - prop("Spent")`),
`Period` (select: Q1/Q2/Q3/Q4).

> The code reads only the properties it needs and tolerates Category being
> single- or multi-select. Extra columns (e.g. an auto-increment ID) are ignored.

## Setup

Requires Node.js 22+ and the [Notion CLI](https://developers.notion.com/cli/get-started/overview)
(`ntn`). On Windows, run `ntn` from WSL (it has no native Windows build yet).

```bash
ntn login

# Deploy the worker
cd notion-worker
npm install
ntn workers deploy --name compass --no-git    # --no-git: bundle via filesystem walk

# Set worker secrets (NOTION_API_TOKEN is the integration token)
ntn workers env set \
  NOTION_API_TOKEN=ntn_... ANTHROPIC_API_KEY=sk-ant-... EXA_API_KEY=... \
  OPPORTUNITY_DB_ID=... DECISION_LOG_DB_ID=... BUDGET_DB_ID=... \
  GITHUB_REPO_OWNER=... GITHUB_REPO_NAME=...

# Seed demo data into the Decision Log
cd ../scripts
cp ../.env.example ../.env     # fill NOTION_API_KEY + NOTION_DECISION_LOG_DB_ID
npm install
npx tsx seed-demo-data.ts
```

### Wire the Notion automations

Get the webhook URLs:

```bash
cd notion-worker && ntn workers webhooks list
```

In Notion, on the **Opportunity Inbox** database, add two automations
(••• → Automations, or the ⚡ menu):

1. **When** a page is added → **Then** Send webhook → paste the
   `onNewOpportunity` URL.
2. **When** `Status` is edited → **Then** Send webhook → paste the
   `onDecisionMade` URL.

The worker fetches canonical page data by ID, so the exact webhook body shape
doesn't matter.

## Demo

1. Add a row to Opportunity Inbox: `Pragma Conf 2025`, `$4,000`, an event date,
   `Conference`, Status `New`.
2. Decision Brief sub-page auto-generates in ~20s: event research, audience-fit
   score, budget impact, similar past bets, recommendation + reasoning.
3. Set Status to `Approved` → Budget Tracker `Spent` updates live and the
   decision is logged to the Decision Log.
4. Post-event: `ntn workers exec collectOutcomes` writes the GitHub stars delta
   back to the Decision Log.

**Manual fallback (no automations needed):**

```bash
ntn workers exec runResearch -d '{"pageId":"<opportunity-page-id>"}'
ntn workers exec runDecision -d '{"pageId":"<opportunity-page-id>"}'
```

## Outcome collector scheduling

The Workers runtime has no native cron. `collectOutcomes` is a tool: run it
manually via `ntn workers exec collectOutcomes`, or wire it to a Notion
scheduled automation for hands-off operation. It only processes Approved
decisions whose event was ≥2 weeks ago and that have no stars delta yet.

## License

MIT — see [LICENSE](LICENSE).
