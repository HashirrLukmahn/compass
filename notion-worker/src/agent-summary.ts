import type { Client } from "@notionhq/client";
import type { BriefData } from "./research.js";
import type { Budget } from "./budget.js";

// One-line digest stored on the Opportunity Inbox row so the Notion agent can
// surface highlights instantly without fetching the full Decision Brief page.
export function buildAgentSummary(
	brief: BriefData,
	cost: number,
	budget: Budget | null,
): string {
	const pct =
		budget && budget.remaining > 0 ? Math.round((cost / budget.remaining) * 100) : null;
	const budgetImpact = `$${cost.toLocaleString()}${pct != null ? ` (${pct}% of remaining)` : ""}`;

	const best = brief.similarPastBets[0];
	const comparable = best
		? `${best.name} → ${best.outcomeScore != null ? `score ${best.outcomeScore}` : best.decision}`
		: "none";

	return (
		`Audience Fit: ${brief.audienceFitScore}/10 | ` +
		`Budget Impact: ${budgetImpact} | ` +
		`Comparable: ${comparable} | ` +
		`Recommendation: ${brief.recommendation} (${brief.confidence})`
	);
}

export async function writeAgentSummary(
	notion: Client,
	pageId: string,
	summary: string,
): Promise<void> {
	await notion.pages.update({
		page_id: pageId,
		properties: {
			"Agent Summary": { rich_text: [{ text: { content: summary } }] },
		},
	});
}
