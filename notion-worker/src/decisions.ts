import type { Client } from "@notionhq/client";
import { getTitle, getSelect, getCategory, getNumber, getDate, getRichText, getUrl } from "./notion-utils.js";
import type { Props } from "./notion-utils.js";

const DB = () => process.env.DECISION_LOG_DB_ID!;

export interface PastDecision {
	id: string;
	name: string;
	decision: string;
	amountSpent: number;
	category: string;
	eventDate: string | null;
	decisionDate: string | null;
	outcomeScore: number | null;
	starsData: number | null;
	outcomeNotes: string;
	briefUrl: string | null;
}

interface PageResult {
	id: string;
	object: string;
	properties: Props;
}

function isPageResult(item: unknown): item is PageResult {
	return (
		typeof item === "object" &&
		item !== null &&
		(item as Record<string, unknown>).object === "page" &&
		typeof (item as Record<string, unknown>).properties === "object"
	);
}

async function getDataSourceId(notion: Client, dbId: string): Promise<string> {
	const db = await notion.databases.retrieve({ database_id: dbId });
	const dbWithSources = db as unknown as { data_sources?: Array<{ id: string }> };
	if (!dbWithSources.data_sources?.length) {
		throw new Error(`No data source found for database ${dbId}`);
	}
	return dbWithSources.data_sources[0].id;
}

function rowToDecision(page: PageResult): PastDecision {
	const p = page.properties;
	return {
		id: page.id,
		name: getTitle(p, "Opportunity Name"),
		decision: getSelect(p, "Decision"),
		amountSpent: getNumber(p, "Amount Spent") ?? 0,
		category: getCategory(p, "Category"),
		eventDate: getDate(p, "Event Start Date"),
		decisionDate: getDate(p, "Decision Date"),
		outcomeScore: getNumber(p, "Outcome Score"),
		starsData: getNumber(p, "GitHub Stars Delta"),
		outcomeNotes: getRichText(p, "Outcome Notes"),
		briefUrl: getUrl(p, "Brief Page"),
	};
}

export async function listPastDecisions(notion: Client): Promise<PastDecision[]> {
	const dataSourceId = await getDataSourceId(notion, DB());
	const res = await notion.dataSources.query({
		data_source_id: dataSourceId,
		page_size: 50,
		result_type: "page",
	});
	return (res.results as unknown[]).filter(isPageResult).map(rowToDecision);
}

export async function getDecisionsWithoutOutcome(notion: Client): Promise<PastDecision[]> {
	const all = await listPastDecisions(notion);
	return all.filter((d) => d.decision === "Approved" && d.starsData == null);
}

export async function createDecisionEntry(
	notion: Client,
	data: {
		opportunityName: string;
		decision: "Approved" | "Rejected";
		amountSpent: number;
		category: string;
		eventDate: string | null;
		briefUrl: string;
		baselineStars?: number;
	},
): Promise<string> {
	const outcomeNotes =
		data.baselineStars != null
			? JSON.stringify({ baselineStars: data.baselineStars, loggedAt: new Date().toISOString() })
			: "";

	const res = await notion.pages.create({
		parent: { database_id: DB() },
		properties: {
			"Opportunity Name": { title: [{ text: { content: data.opportunityName } }] },
			Decision: { select: { name: data.decision } },
			"Amount Spent": { number: data.amountSpent },
			...(data.category
				? { Category: { multi_select: [{ name: data.category }] } }
				: {}),
			"Decision Date": { date: { start: new Date().toISOString().split("T")[0] } },
			...(data.briefUrl ? { "Brief Page": { url: data.briefUrl } } : {}),
			...(data.eventDate ? { "Event Start Date": { date: { start: data.eventDate } } } : {}),
			...(outcomeNotes
				? { "Outcome Notes": { rich_text: [{ text: { content: outcomeNotes } }] } }
				: {}),
		},
	});
	return res.id;
}

export async function updateOutcome(
	notion: Client,
	pageId: string,
	data: { outcomeScore?: number; starsData?: number; outcomeNotes?: string },
): Promise<void> {
	await notion.pages.update({
		page_id: pageId,
		properties: {
			...(data.outcomeScore != null ? { "Outcome Score": { number: data.outcomeScore } } : {}),
			...(data.starsData != null ? { "GitHub Stars Delta": { number: data.starsData } } : {}),
			...(data.outcomeNotes
				? { "Outcome Notes": { rich_text: [{ text: { content: data.outcomeNotes } }] } }
				: {}),
		},
	});
}
