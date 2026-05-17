import Anthropic from "@anthropic-ai/sdk";
import Exa from "exa-js";
import type { Client } from "@notionhq/client";
import { listPastDecisions } from "./decisions.js";
import { getTitle, getCategory, getNumber, getDate, getRichText } from "./notion-utils.js";
import type { Props } from "./notion-utils.js";

function isPageResult(item: unknown): item is { id: string; object: string; properties: Props } {
	return (
		typeof item === "object" &&
		item !== null &&
		(item as Record<string, unknown>).object === "page" &&
		typeof (item as Record<string, unknown>).properties === "object"
	);
}

// Looks up the Opportunity Inbox row by name and calls findAlternatives.
// Forgiving match so a slightly-off name from the agent still resolves:
//   exact (case-insensitive) → substring → most recently rejected row.
export async function findAlternativesForOpportunity(
	notion: Client,
	opportunityName: string,
): Promise<Alternative[]> {
	const db = await notion.databases.retrieve({
		database_id: process.env.OPPORTUNITY_DB_ID!,
	});
	const dbWithSources = db as unknown as { data_sources?: Array<{ id: string }> };
	if (!dbWithSources.data_sources?.length) throw new Error("No data source for Opportunity Inbox");
	const dataSourceId = dbWithSources.data_sources[0].id;

	const res = await notion.dataSources.query({
		data_source_id: dataSourceId,
		page_size: 50,
		result_type: "page",
		sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
	});

	const pages = (res.results as unknown[]).filter(isPageResult);
	const query = opportunityName.trim().toLowerCase();

	const exact = pages.find((p) => getTitle(p.properties, "Name").toLowerCase() === query);
	const partial =
		exact ??
		(query
			? pages.find((p) => {
					const t = getTitle(p.properties, "Name").toLowerCase();
					return t.includes(query) || query.includes(t);
				})
			: undefined);
	// Last resort: the most recently rejected row (results are sorted desc).
	const fallback =
		partial ??
		pages.find((p) => {
			const s = p.properties["Status"] as { select?: { name?: string } } | undefined;
			return s?.select?.name === "Rejected";
		});

	if (!fallback) throw new Error(`Could not resolve opportunity "${opportunityName}" in the Inbox`);
	return findAlternatives(notion, fallback.properties);
}

export interface Alternative {
	name: string;
	url: string;
	estimatedCost: string;
	date: string;
	audienceFitReason: string;
	whyBetterThanRejected: string;
}

// Reject → Discover Replacement.
// 1. Claude builds two targeted Exa queries using rejected props + Decision Log context.
// 2. Exa searches the live web for REAL named upcoming events.
// 3. Claude synthesises exactly 3 specific alternatives from the web results only —
//    never generic categories, always real event names with URLs and dates.
export async function findAlternatives(
	notion: Client,
	props: Props,
): Promise<Alternative[]> {
	const name = getTitle(props, "Name");
	const category = getCategory(props, "Category");
	const cost = getNumber(props, "Cost") ?? 0;
	const eventDate = getDate(props, "Event Start Date") ?? "";
	const notes = getRichText(props, "Notes");

	const [pastDecisions, budget] = await Promise.all([
		listPastDecisions(notion),
		// Import inline to avoid circular deps — same pattern as researchAndBrief
		(async () => {
			try {
				const { getActiveBudget } = await import("./budget.js");
				return getActiveBudget(notion);
			} catch {
				return null;
			}
		})(),
	]);

	// Use actual remaining budget as ceiling, not the rejected event's cost.
	const budgetCeiling = budget && budget.remaining > 0 ? budget.remaining : cost;

	const pastCtx = pastDecisions
		.filter((d) => d.decision === "Approved" && d.outcomeScore != null)
		.map((d) => `${d.name} | $${d.amountSpent} | ${d.category} | score ${d.outcomeScore}`)
		.join("\n");

	const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

	// Claude builds two search queries — one broad, one narrow — for real upcoming events.
	const queryMsg = await anthropic.messages.create({
		model: "claude-sonnet-4-6",
		max_tokens: 200,
		system:
			"You produce exactly TWO web search queries to find real upcoming developer events or conferences. " +
			"Queries must target SPECIFIC named events, not generic categories. Include the year. " +
			"Output ONLY two lines, one query per line, no numbering, no quotes, no explanation.",
		messages: [
			{
				role: "user",
				content:
					`Rejected: "${name}" (${category}, ${eventDate}). Budget ceiling: $${budgetCeiling.toLocaleString()}. Notes: ${notes || "none"}.\n` +
					`Past bets that worked: ${pastCtx || "none"}.\n` +
					`Build two search queries for REAL upcoming ${category} events, under $${budgetCeiling.toLocaleString()}, near ${eventDate || "late 2026"}. ` +
					`Bias toward events with proven developer audiences similar to past wins.`,
			},
		],
	});

	const queryRaw = queryMsg.content[0];
	const queries =
		queryRaw.type === "text"
			? queryRaw.text.trim().split("\n").filter(Boolean).slice(0, 2)
			: [`upcoming ${category} developer events 2026 sponsorship under $${budgetCeiling}`];

	type ExaResult = { url?: string | null; title?: string | null; text?: string | null };

	const exa = new Exa(process.env.EXA_API_KEY!);
	const searches = await Promise.all(
		queries.map((q) =>
			exa
				.searchAndContents(q, { numResults: 4, useAutoprompt: true, text: { maxCharacters: 600 } })
				.then((res) => res.results as ExaResult[])
				.catch(() => [] as ExaResult[]),
		),
	);

	const snippets = searches
		.flat()
		.map((r) => `URL: ${r.url ?? "unknown"}\nTitle: ${r.title ?? ""}\n${r.text ?? ""}`)
		.filter((s) => s.length > 20)
		.slice(0, 8)
		.join("\n\n---\n\n");

	const synthMsg = await anthropic.messages.create({
		model: "claude-sonnet-4-6",
		max_tokens: 1500,
		system:
			"You are a marketing analyst. Return ONLY a valid JSON array of EXACTLY 3 objects.\n" +
			'Each object must have keys: "name" (string), "url" (string), "estimatedCost" (string), ' +
			'"date" (string), "audienceFitReason" (string), "whyBetterThanRejected" (string).\n' +
			"CRITICAL RULES:\n" +
			"- Use ONLY real named events found in the web research. Do NOT invent events.\n" +
			"- Do NOT suggest generic categories like 'Newsletter Sponsorship', 'Local Meetup', or 'Demo Night'.\n" +
			"- Each event must have a real name, a real or estimated date, and a source URL.\n" +
			"- If fewer than 3 real events are found in the research, say so in whyBetterThanRejected.\n" +
			"- No prose, no markdown fences, no explanation outside the JSON array.",
		messages: [
			{
				role: "user",
				content:
					`Rejected: "${name}" (${category}, ~$${cost.toLocaleString()}, ${eventDate || "unknown date"}). ` +
					`Reason for rejection: over budget — remaining Q2 budget is $${budgetCeiling.toLocaleString()}.\n\n` +
					`Past high-performing bets: ${pastCtx || "none"}\n\n` +
					`Find 3 REAL upcoming ${category} events under $${budgetCeiling.toLocaleString()} from this web research:\n\n${snippets || "No results — return best-known real events in this space."}`,
			},
		],
	});

	const synthRaw = synthMsg.content[0];
	if (synthRaw.type !== "text") return [];
	const match = synthRaw.text.match(/\[[\s\S]*\]/);
	if (!match) return [];

	try {
		const parsed = JSON.parse(match[0]) as Alternative[];
		return parsed.slice(0, 3);
	} catch {
		return [];
	}
}
