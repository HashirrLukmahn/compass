import type { Client } from "@notionhq/client";
import { getTitle, getSelect, getNumber } from "./notion-utils.js";
import type { Props } from "./notion-utils.js";

const DB = () => process.env.BUDGET_DB_ID!;

export interface Budget {
	id: string;
	label: string;
	total: number;
	spent: number;
	remaining: number;
	period: string;
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

export async function getActiveBudget(notion: Client): Promise<Budget | null> {
	const dataSourceId = await getDataSourceId(notion, DB());
	const res = await notion.dataSources.query({
		data_source_id: dataSourceId,
		page_size: 1,
		result_type: "page",
		sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
	});

	const page = (res.results as unknown[]).find(isPageResult);
	if (!page) return null;

	const p = page.properties;
	const total = getNumber(p, "Total Budget") ?? 0;
	const spent = getNumber(p, "Spent") ?? 0;
	return {
		id: page.id,
		label: getTitle(p, "Label"),
		total,
		spent,
		remaining: total - spent,
		period: getSelect(p, "Period"),
	};
}

export async function deductFromBudget(
	notion: Client,
	budgetId: string,
	amount: number,
	currentSpent: number,
	transaction: { opportunityName: string; opportunityUrl: string },
): Promise<void> {
	await notion.pages.update({
		page_id: budgetId,
		properties: {
			Spent: { number: currentSpent + amount },
		},
	});

	const date = new Date().toISOString().slice(0, 10);
	await notion.blocks.children.append({
		block_id: budgetId,
		children: [
			{
				type: "bulleted_list_item",
				bulleted_list_item: {
					rich_text: [
						{ type: "text", text: { content: `$${amount.toLocaleString()} — ` } },
						{
							type: "text",
							text: {
								content: transaction.opportunityName,
								link: { url: transaction.opportunityUrl },
							},
						},
						{ type: "text", text: { content: ` · ${date}` } },
					],
				},
			},
		],
	});
}
