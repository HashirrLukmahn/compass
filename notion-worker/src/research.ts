import Anthropic from "@anthropic-ai/sdk";
import Exa from "exa-js";
import type { PastDecision } from "./decisions.js";
import type { Budget } from "./budget.js";

export interface BriefData {
	eventSummary: string;
	audienceFitScore: number;
	audienceFitReason: string;
	estimatedReach: string;
	budgetImpact: string;
	similarPastBets: Array<{
		name: string;
		decision: string;
		amount: number;
		outcomeScore: number | null;
		starsData: number | null;
		notes: string;
	}>;
	recommendation: "Approve" | "Reject";
	confidence: "High" | "Medium" | "Low";
	reasoning: string;
}

const SYSTEM_PROMPT = `You are Compass, a marketing intelligence agent for early-stage startups. \
You are given research about a marketing opportunity and the company's history of past decisions. \
Your job is to produce a structured, honest assessment that helps a CEO decide whether to proceed.

Be direct. Give a clear recommendation. Don't hedge excessively. \
Early-stage CEOs need signal, not noise.

Always respond in valid JSON with this exact schema:
{
  "eventSummary": "2-3 sentences about the event",
  "audienceFitScore": 7,
  "audienceFitReason": "one sentence explaining the score",
  "estimatedReach": "~800 developers",
  "budgetImpact": "28% of remaining Q2 budget",
  "similarPastBets": [{"name": "...", "decision": "Approved", "amount": 3500, "outcomeScore": 8, "starsData": 240, "notes": "..."}],
  "recommendation": "Approve",
  "confidence": "High",
  "reasoning": "3-4 sentences of honest reasoning"
}`;

async function searchEvent(eventName: string): Promise<string> {
	const exa = new Exa(process.env.EXA_API_KEY!);
	const queries = [
		`${eventName} developer conference attendees audience`,
		`${eventName} sponsors past speakers tech startup`,
	];

	const results = await Promise.all(
		queries.map((q) =>
			exa
				.searchAndContents(q, { numResults: 3, useAutoprompt: true, text: { maxCharacters: 800 } })
				.catch(() => ({ results: [] })),
		),
	);

	const snippets = results
		.flatMap((r) => r.results)
		.map((r) => `Source: ${r.url}\n${r.text ?? ""}`)
		.filter(Boolean)
		.slice(0, 5)
		.join("\n\n---\n\n");

	return snippets || "No web research found for this event.";
}

function buildUserPrompt(
	opportunityName: string,
	cost: number,
	category: string,
	notes: string,
	research: string,
	pastDecisions: PastDecision[],
	budget: Budget | null,
): string {
	const budgetCtx = budget
		? `Remaining budget: $${budget.remaining.toLocaleString()} of $${budget.total.toLocaleString()} total (${budget.period})`
		: "Budget information unavailable";

	const budgetPct = budget && budget.remaining > 0
		? `${Math.round((cost / budget.remaining) * 100)}% of remaining ${budget.period} budget`
		: "unknown budget impact";

	const pastCtx = pastDecisions
		.map(
			(d) =>
				`- ${d.name} | ${d.decision} | $${d.amountSpent} | ${d.category} | ` +
				`OutcomeScore: ${d.outcomeScore ?? "N/A"} | StarsDelta: ${d.starsData ?? "N/A"} | ${d.outcomeNotes}`,
		)
		.join("\n");

	return `OPPORTUNITY: ${opportunityName}
Cost: $${cost.toLocaleString()}
Category: ${category}
CEO Notes: ${notes || "None"}

BUDGET CONTEXT:
${budgetCtx}
This opportunity = ${budgetPct}

PAST DECISIONS (most recent first):
${pastCtx || "No past decisions found."}

WEB RESEARCH:
${research}

Based on the above, produce the JSON assessment.`;
}

export async function researchOpportunity(
	opportunityName: string,
	cost: number,
	category: string,
	notes: string,
	pastDecisions: PastDecision[],
	budget: Budget | null,
): Promise<BriefData> {
	const [research] = await Promise.all([searchEvent(opportunityName)]);

	const userPrompt = buildUserPrompt(
		opportunityName,
		cost,
		category,
		notes,
		research,
		pastDecisions,
		budget,
	);

	const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
	const msg = await anthropic.messages.create({
		model: "claude-sonnet-4-6",
		max_tokens: 1500,
		system: SYSTEM_PROMPT,
		messages: [{ role: "user", content: userPrompt }],
	});

	const raw = msg.content[0];
	if (raw.type !== "text") throw new Error("Unexpected Claude response type");

	const jsonMatch = raw.text.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("Claude response did not contain JSON");

	const data = JSON.parse(jsonMatch[0]) as BriefData;
	return data;
}
