import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import type { Client } from "@notionhq/client";
import { getTitle, getSelect, getCategory, getNumber, getDate, getRichText, getUrl } from "./notion-utils.js";
import type { Props } from "./notion-utils.js";
import { listPastDecisions, createDecisionEntry } from "./decisions.js";
import { getActiveBudget, deductFromBudget } from "./budget.js";
import { researchOpportunity } from "./research.js";
import { createDecisionBrief } from "./brief.js";
import { collectOutcomes } from "./outcome.js";
import { buildAgentSummary, writeAgentSummary } from "./agent-summary.js";
import { findAlternatives, findAlternativesForOpportunity } from "./alternatives.js";
import { parseOpportunityUrl, createOpportunityRow, resolveOpportunityByName } from "./intake.js";

const worker = new Worker();
export default worker;

/**
 * Notion's database-automation "Send webhook" payload shape isn't strictly
 * guaranteed, so we defensively dig out the triggering page ID from every
 * place Notion is known to put it, then fetch canonical page data via the API.
 */
function extractPageId(body: Record<string, unknown>): string | null {
	const candidates: Array<unknown> = [
		(body.data as Record<string, unknown> | undefined)?.id,
		(body.entity as Record<string, unknown> | undefined)?.id,
		(body.page as Record<string, unknown> | undefined)?.id,
		(body.source as Record<string, unknown> | undefined)?.entity_id,
		body.pageId,
		body.page_id,
		body.id,
	];
	for (const c of candidates) {
		if (typeof c === "string" && c.length >= 32) return c;
	}
	return null;
}

async function loadPageProps(
	notion: Client,
	body: Record<string, unknown>,
): Promise<{ pageId: string; props: Props } | null> {
	// Always fetch canonical page data by ID. Notion automation webhook payloads
	// may embed a non-canonical / pre-edit properties snapshot in `body.data`,
	// so trusting it caused the decision webhook to read a stale Status.
	const pageId = extractPageId(body);
	if (!pageId) {
		console.log("[Compass] Could not find page ID in webhook body. Keys:", Object.keys(body));
		return null;
	}

	const page = (await notion.pages.retrieve({ page_id: pageId })) as unknown as {
		id: string;
		properties?: Props;
	};
	if (!page.properties) {
		console.log("[Compass] Retrieved page has no properties:", pageId);
		return null;
	}
	return { pageId: page.id, props: page.properties };
}

async function researchAndBrief(
	notion: Client,
	pageId: string,
	props: Props,
): Promise<string> {
	const opportunityName = getTitle(props, "Name");
	const cost = getNumber(props, "Cost") ?? 0;
	const category = getCategory(props, "Category");
	const notes = getRichText(props, "Notes");
	const status = getSelect(props, "Status");

	if (!opportunityName) {
		return "No opportunity name found, skipping.";
	}
	if (status && status !== "New") {
		return `Skipping "${opportunityName}" — status is "${status}".`;
	}
	// Idempotency: a brief already exists, so a prior run handled this row.
	// Notion automations can fire more than once for one logical change.
	if (getUrl(props, "Brief Page")) {
		return `Skipping "${opportunityName}" — a Decision Brief already exists.`;
	}

	await notion.pages.update({
		page_id: pageId,
		properties: { Status: { select: { name: "Researching" } } },
	});
	console.log(`[Compass] Researching: ${opportunityName} ($${cost})`);

	const [pastDecisions, budget] = await Promise.all([
		listPastDecisions(notion),
		getActiveBudget(notion),
	]);

	const briefData = await researchOpportunity(
		opportunityName,
		cost,
		category,
		notes,
		pastDecisions,
		budget,
	);

	const briefUrl = await createDecisionBrief(
		notion,
		pageId,
		opportunityName,
		briefData,
		cost,
		pageId,
	);

	try {
		await writeAgentSummary(notion, pageId, buildAgentSummary(briefData, cost, budget));
	} catch (err) {
		console.log("[Compass] Could not write Agent Summary — continuing.", err);
	}

	const summary = `${briefData.recommendation} (${briefData.confidence}) — ${briefUrl}`;
	console.log(`[Compass] Brief ready: ${summary}`);
	return summary;
}

// Wire in Notion: Opportunity Inbox → automation "When page added" →
// Send webhook → this webhook's URL (`ntn workers webhooks list`).
worker.webhook("onNewOpportunity", {
	title: "Research New Opportunity",
	description: "Researches a marketing opportunity and writes a Decision Brief in ~20s.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			const loaded = await loadPageProps(notion, event.body);
			if (!loaded) continue;
			await researchAndBrief(notion, loaded.pageId, loaded.props);
		}
	},
});

// Wire in Notion: Opportunity Inbox → automation "When Status changes" →
// Send webhook → this webhook's URL.
async function processDecision(notion: Client, pageId: string, props: Props): Promise<string> {
	const status = getSelect(props, "Status");
	if (status !== "Approved" && status !== "Rejected") {
		return `Status "${status}" is not a final decision, skipping.`;
	}

	const opportunityName = getTitle(props, "Name");
	const cost = getNumber(props, "Cost") ?? 0;
	const category = getCategory(props, "Category");
	const eventDate = getDate(props, "Event Start Date");
	const briefUrl = getUrl(props, "Brief Page") ?? "";

	console.log(`[Compass] Decision: ${opportunityName} → ${status}`);

	let baselineStars: number | undefined;

	if (status === "Approved") {
		const budget = await getActiveBudget(notion);
		if (budget) {
			await deductFromBudget(notion, budget.id, cost, budget.spent, {
					opportunityName,
					opportunityUrl: `https://notion.so/${pageId.replace(/-/g, "")}`,
				});
			console.log(`[Compass] Deducted $${cost} from ${budget.label}`);
		}
		try {
			const ghRes = await fetch(
				`https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}`,
				{
					headers: {
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				},
			);
			if (ghRes.ok) {
				const gh = (await ghRes.json()) as { stargazers_count: number };
				baselineStars = gh.stargazers_count;
				console.log(`[Compass] Baseline stars: ${baselineStars}`);
			}
		} catch {
			console.log("[Compass] Could not fetch baseline stars — continuing.");
		}
	}

	await createDecisionEntry(notion, {
		opportunityName,
		decision: status as "Approved" | "Rejected",
		amountSpent: status === "Approved" ? cost : 0,
		category,
		eventDate,
		briefUrl,
		baselineStars,
	});
	if (status === "Rejected") {
		try {
			const alts = await findAlternatives(notion, props);
			console.log(`[Compass] Found ${alts.length} alternatives for "${opportunityName}":`, JSON.stringify(alts));
		} catch (err) {
			console.log("[Compass] findAlternatives failed — reject flow unaffected.", err);
		}
	}

	const msg = `Logged to Decision Log: ${opportunityName} → ${status}`;
	console.log(`[Compass] ${msg}`);
	return msg;
}

worker.webhook("onDecisionMade", {
	title: "Process Decision",
	description: "On Approved: deduct budget + log decision. On Rejected: log only.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			const loaded = await loadPageProps(notion, event.body);
			if (!loaded) continue;
			await processDecision(notion, loaded.pageId, loaded.props);
		}
	},
});

// Manual tool: `ntn workers exec collectOutcomes` (or wire to a scheduled automation).
worker.tool("collectOutcomes", {
	title: "Collect Post-Event Outcomes",
	description:
		"For approved decisions ≥2 weeks after the event, fetch GitHub stars delta and log it to the Decision Log.",
	schema: j.object({}),
	execute: async (_input, { notion }) => {
		const { processed, skipped } = await collectOutcomes(notion);
		return `Done. Processed: ${processed}, Skipped (too early or no date): ${skipped}`;
	},
});

// Test/fallback: run the research pipeline on an Opportunity page by ID,
// without needing the webhook automation wired. `ntn workers exec runResearch -d '{"pageId":"..."}'`
worker.tool("runResearch", {
	title: "Run Research On Opportunity",
	description: "Manually research an Opportunity Inbox page by its page ID and write a Decision Brief.",
	schema: j.object({
		pageId: j.string().describe("The Notion page ID of the Opportunity Inbox row."),
	}),
	execute: async ({ pageId }, { notion }) => {
		const page = (await notion.pages.retrieve({ page_id: pageId })) as unknown as {
			id: string;
			properties?: Props;
		};
		if (!page.properties) return "Page has no properties.";
		return await researchAndBrief(notion, page.id, page.properties);
	},
});

// Test/fallback: process a decision on an Opportunity page by ID.
// `ntn workers exec runDecision -d '{"pageId":"..."}'`
worker.tool("runDecision", {
	title: "Process Decision On Opportunity",
	description: "Manually process Approved/Rejected for an Opportunity Inbox page by its page ID.",
	schema: j.object({
		pageId: j.string().describe("The Notion page ID of the Opportunity Inbox row."),
	}),
	execute: async ({ pageId }, { notion }) => {
		const page = (await notion.pages.retrieve({ page_id: pageId })) as unknown as {
			id: string;
			properties?: Props;
		};
		if (!page.properties) return "Page has no properties.";
		return await processDecision(notion, page.id, page.properties);
	},
});

// Called by the Notion agent when a user rejects an opportunity verbally.
// Auto-detects the most recently rejected row — no parameter needed.
worker.tool("findAlternatives", {
	title: "Find Alternative Opportunities",
	description:
		"Finds 3 real alternative events for a rejected opportunity. Pass the name of the rejected opportunity (e.g. 'KubeCon Europe 2026'). Call this immediately after a rejection.",
	schema: j.object({
		name: j
			.string()
			.describe("The name of the rejected opportunity, exactly as it appears in the Opportunity Inbox."),
	}),
	execute: async ({ name }, { notion }) => {
		const alts = await findAlternativesForOpportunity(notion, name);
		if (alts.length === 0) return "No alternatives found.";
		return JSON.stringify(alts);
	},
});

// Agent: paste an event URL → parse it into structured fields. Creates NOTHING.
// If cost (or name) can't be found, it's listed in `missing` so the agent can
// ask the user before anything is created.
worker.tool("addOpportunityFromUrl", {
	title: "Parse Opportunity From URL",
	description:
		"Parses an event URL into structured fields. Does NOT create anything. Returns {extracted, missing}. If `missing` is non-empty (e.g. cost), ASK THE USER for those values, then call createOpportunity.",
	schema: j.object({
		url: j.string().describe("The event or conference URL to parse."),
	}),
	execute: async ({ url }) => {
		const { extracted, missing } = await parseOpportunityUrl(url);
		return JSON.stringify({ extracted, missing });
	},
});

// Agent: create the opportunity once all fields are known (from the URL parse
// plus any values the user supplied), then run the full research pipeline.
worker.tool("createOpportunity", {
	title: "Create And Evaluate Opportunity",
	description:
		"Creates an Opportunity Inbox row and runs research, producing a Decision Brief. Call only when name and cost are known. Pass empty string for eventStartDate or notes if unknown.",
	schema: j.object({
		name: j.string().describe("Event name."),
		cost: j.number().describe("Attendance or sponsorship cost in USD."),
		category: j
			.string()
			.describe("One of: Conference, Sponsorship, Meetup, Newsletter, Demo Night, Founder/VC Meeting, Others."),
		eventStartDate: j.string().describe("ISO date YYYY-MM-DD, or empty string if unknown."),
		notes: j.string().describe("One-sentence description, or empty string."),
	}),
	execute: async ({ name, cost, category, eventStartDate, notes }, { notion }) => {
		const pageId = await createOpportunityRow(notion, {
			name,
			cost,
			category,
			eventStartDate: eventStartDate || undefined,
			notes: notes || undefined,
		});
		const page = (await notion.pages.retrieve({ page_id: pageId })) as unknown as {
			id: string;
			properties?: Props;
		};
		if (!page.properties) return "Opportunity created but properties could not be read.";
		return await researchAndBrief(notion, page.id, page.properties);
	},
});

// Agent: approve or reject an opportunity by name. Sets Status then runs the
// decision pipeline (budget + log + ledger, or log + alternatives on reject).
worker.tool("decideOpportunity", {
	title: "Approve Or Reject Opportunity",
	description:
		"Approves or rejects an opportunity by name. On Approve: deducts budget + logs. On Reject: logs + (use findAlternatives next).",
	schema: j.object({
		name: j.string().describe("The opportunity name as it appears in the Opportunity Inbox."),
		decision: j.enum("Approved", "Rejected").describe("The decision to apply."),
	}),
	execute: async ({ name, decision }, { notion }) => {
		const resolved = await resolveOpportunityByName(notion, name);
		if (!resolved) return `Could not find an opportunity matching "${name}".`;
		await notion.pages.update({
			page_id: resolved.pageId,
			properties: { Status: { select: { name: decision } } },
		});
		const page = (await notion.pages.retrieve({ page_id: resolved.pageId })) as unknown as {
			id: string;
			properties?: Props;
		};
		if (!page.properties) return "Status updated but properties could not be read.";
		return await processDecision(notion, page.id, page.properties);
	},
});
