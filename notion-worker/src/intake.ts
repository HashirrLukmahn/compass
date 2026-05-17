import Anthropic from "@anthropic-ai/sdk";
import Exa from "exa-js";
import type { Client } from "@notionhq/client";
import { getTitle } from "./notion-utils.js";
import type { Props } from "./notion-utils.js";

const CATEGORIES = [
	"Conference",
	"Sponsorship",
	"Meetup",
	"Newsletter",
	"Demo Night",
	"Founder/VC Meeting",
	"Others",
];

export interface ExtractedOpportunity {
	name: string;
	cost: number | null;
	category: string;
	eventStartDate: string | null;
	notes: string;
}

// Parse an event URL into structured fields. Never fabricates a cost — if it
// isn't on the page, cost is null and "cost" is reported in `missing` so the
// agent can ask the user for it.
export async function parseOpportunityUrl(
	url: string,
): Promise<{ extracted: ExtractedOpportunity; missing: string[] }> {
	const exa = new Exa(process.env.EXA_API_KEY!);
	const fetched = await exa
		.getContents([url], { text: { maxCharacters: 4000 } })
		.catch(() => ({ results: [] as Array<{ title?: string | null; text?: string | null }> }));

	const page = fetched.results[0];
	const content = `${page?.title ?? ""}\n\n${page?.text ?? ""}`.trim();

	const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
	const msg = await anthropic.messages.create({
		model: "claude-sonnet-4-6",
		max_tokens: 600,
		system:
			"Extract marketing-event details from page content. Return ONLY valid JSON: " +
			'{"name": string, "cost": number|null, "category": string, "eventStartDate": string|null, "notes": string}. ' +
			`"category" MUST be one of: ${CATEGORIES.join(", ")}. ` +
			'"cost" is the attendance or sponsorship price in USD as a number — use null if it is NOT clearly stated on the page (never guess a price). ' +
			'"eventStartDate" is ISO YYYY-MM-DD or null if not stated. ' +
			'"notes" is a one-sentence description. No prose, no markdown fences.',
		messages: [
			{
				role: "user",
				content: content
					? `URL: ${url}\n\nPAGE CONTENT:\n${content}`
					: `URL: ${url}\n\n(Page content could not be fetched. Infer name from the URL only; set cost, date to null.)`,
			},
		],
	});

	const raw = msg.content[0];
	const fallback: ExtractedOpportunity = {
		name: "",
		cost: null,
		category: "Others",
		eventStartDate: null,
		notes: "",
	};
	let extracted = fallback;
	if (raw.type === "text") {
		const m = raw.text.match(/\{[\s\S]*\}/);
		if (m) {
			try {
				const p = JSON.parse(m[0]) as Partial<ExtractedOpportunity>;
				extracted = {
					name: typeof p.name === "string" ? p.name.trim() : "",
					cost: typeof p.cost === "number" ? p.cost : null,
					category: CATEGORIES.includes(p.category ?? "") ? (p.category as string) : "Others",
					eventStartDate: typeof p.eventStartDate === "string" ? p.eventStartDate : null,
					notes: typeof p.notes === "string" ? p.notes : "",
				};
			} catch {
				/* keep fallback */
			}
		}
	}

	const missing: string[] = [];
	if (!extracted.name) missing.push("name");
	if (extracted.cost == null) missing.push("cost");

	return { extracted, missing };
}

// Create an Opportunity Inbox row at Status = New and return its page ID.
export async function createOpportunityRow(
	notion: Client,
	fields: {
		name: string;
		cost: number;
		category: string;
		eventStartDate?: string;
		notes?: string;
	},
): Promise<string> {
	const category = CATEGORIES.includes(fields.category) ? fields.category : "Others";
	const res = await notion.pages.create({
		parent: { database_id: process.env.OPPORTUNITY_DB_ID! },
		properties: {
			Name: { title: [{ text: { content: fields.name } }] },
			Cost: { number: fields.cost },
			Category: { multi_select: [{ name: category }] },
			Status: { select: { name: "New" } },
			...(fields.eventStartDate
				? { "Event Start Date": { date: { start: fields.eventStartDate } } }
				: {}),
			...(fields.notes
				? { Notes: { rich_text: [{ text: { content: fields.notes } }] } }
				: {}),
		},
	});
	return res.id;
}

// Forgiving name → opportunity row resolver: exact (case-insensitive) →
// substring → null. Returns canonical props via a fresh page retrieve.
export async function resolveOpportunityByName(
	notion: Client,
	name: string,
): Promise<{ pageId: string; props: Props } | null> {
	const db = await notion.databases.retrieve({
		database_id: process.env.OPPORTUNITY_DB_ID!,
	});
	const dbWithSources = db as unknown as { data_sources?: Array<{ id: string }> };
	if (!dbWithSources.data_sources?.length) return null;

	const res = await notion.dataSources.query({
		data_source_id: dbWithSources.data_sources[0].id,
		page_size: 50,
		result_type: "page",
		sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
	});

	const pages = (res.results as unknown[]).filter(
		(item): item is { id: string; properties: Props } => {
			const p = item as { object?: string; properties?: unknown };
			return p.object === "page" && typeof p.properties === "object" && p.properties !== null;
		},
	);

	const q = name.trim().toLowerCase();
	const hit =
		pages.find((p) => getTitle(p.properties, "Name").toLowerCase() === q) ??
		(q
			? pages.find((p) => {
					const t = getTitle(p.properties, "Name").toLowerCase();
					return t.includes(q) || q.includes(t);
				})
			: undefined);

	if (!hit) return null;
	return { pageId: hit.id, props: hit.properties };
}
