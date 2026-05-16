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
	// Fast path: Notion automation payloads embed the full page object in `data`.
	const data = body.data as { id?: string; properties?: Props } | undefined;
	if (data?.id && data.properties && typeof data.properties === "object") {
		return { pageId: data.id, props: data.properties };
	}

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
async function processDecision(notion: Client, props: Props): Promise<string> {
	const status = getSelect(props, "Status");
	if (status !== "Approved" && status !== "Rejected") {
		return `Status "${status}" is not a final decision, skipping.`;
	}

	const opportunityName = getTitle(props, "Name");
	const cost = getNumber(props, "Cost") ?? 0;
	const category = getCategory(props, "Category");
	const eventDate = getDate(props, "Event Start Date");
	const briefUrl = getUrl(props, "Brief Page/Event Page") ?? "";

	console.log(`[Compass] Decision: ${opportunityName} → ${status}`);

	let baselineStars: number | undefined;

	if (status === "Approved") {
		const budget = await getActiveBudget(notion);
		if (budget) {
			await deductFromBudget(notion, budget.id, cost, budget.spent);
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
			await processDecision(notion, loaded.props);
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
			properties?: Props;
		};
		if (!page.properties) return "Page has no properties.";
		return await processDecision(notion, page.properties);
	},
});
