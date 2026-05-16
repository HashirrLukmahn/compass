/**
 * Seeds the Decision Log database with 6 realistic past decisions so the
 * research agent has real context to reason from during the demo.
 *
 * Usage (from repo root):
 *   cd scripts && npm install && npx tsx seed-demo-data.ts
 *
 * Requires .env at repo root with NOTION_API_KEY and NOTION_DECISION_LOG_DB_ID.
 * The Decision Log database must be shared with your Notion integration.
 */
import { Client } from "@notionhq/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(): Record<string, string> {
	const envPath = join(__dirname, "..", ".env");
	const raw = readFileSync(envPath, "utf-8");
	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = trimmed.indexOf("=");
		if (idx === -1) continue;
		env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
	}
	return env;
}

const env = loadEnv();
const notion = new Client({ auth: env.NOTION_API_KEY });
const DB_ID = env.NOTION_DECISION_LOG_DB_ID;

interface SeedDecision {
	name: string;
	decision: "Approved" | "Rejected";
	amount: number;
	category: "Conference" | "Sponsorship" | "Meetup" | "Newsletter" | "Others";
	outcomeScore?: number;
	starsDelta?: number;
	notes: string;
	eventDate: string;
	decisionDate: string;
}

const SEED: SeedDecision[] = [
	{
		name: "Vercel Ship 2024",
		decision: "Approved",
		amount: 3500,
		category: "Conference",
		outcomeScore: 8,
		starsDelta: 240,
		notes: "Strong developer audience, good brand visibility",
		eventDate: "2024-10-24",
		decisionDate: "2024-09-15",
	},
	{
		name: "Dev Newsletter Sponsorship - TLDR",
		decision: "Approved",
		amount: 800,
		category: "Newsletter",
		outcomeScore: 5,
		starsDelta: 45,
		notes: "Decent reach but low conversion",
		eventDate: "2024-08-01",
		decisionDate: "2024-07-20",
	},
	{
		name: "SaaStr Annual 2024",
		decision: "Rejected",
		amount: 6000,
		category: "Conference",
		notes: "Wrong audience, sales-focused not developer-focused",
		eventDate: "2024-09-10",
		decisionDate: "2024-08-05",
	},
	{
		name: "Local JS Meetup SF",
		decision: "Approved",
		amount: 500,
		category: "Meetup",
		outcomeScore: 7,
		starsDelta: 90,
		notes: "Punched above weight for the cost",
		eventDate: "2024-11-12",
		decisionDate: "2024-11-01",
	},
	{
		name: "GitHub Universe 2024",
		decision: "Approved",
		amount: 5000,
		category: "Conference",
		outcomeScore: 9,
		starsDelta: 380,
		notes: "Best ROI event of the year",
		eventDate: "2024-10-29",
		decisionDate: "2024-09-20",
	},
	{
		name: "Podcast Sponsorship - Indie Hackers",
		decision: "Rejected",
		amount: 1200,
		category: "Others",
		notes: "Audience too broad, not enough developer density",
		eventDate: "2024-07-15",
		decisionDate: "2024-06-30",
	},
];

async function getDataSourceId(dbId: string): Promise<string> {
	const db = await notion.databases.retrieve({ database_id: dbId });
	const dbWithSources = db as unknown as { data_sources?: Array<{ id: string }> };
	if (!dbWithSources.data_sources?.length) {
		throw new Error(`No data source found for database ${dbId}`);
	}
	return dbWithSources.data_sources[0].id;
}

async function main() {
	if (!env.NOTION_API_KEY || !DB_ID) {
		throw new Error("Missing NOTION_API_KEY or NOTION_DECISION_LOG_DB_ID in .env");
	}

	console.log(`Seeding ${SEED.length} past decisions into Decision Log...`);

	for (const d of SEED) {
		await notion.pages.create({
			parent: { database_id: DB_ID },
			properties: {
				"Opportunity Name": { title: [{ text: { content: d.name } }] },
				Decision: { select: { name: d.decision } },
				"Amount Spent": { number: d.amount },
				Category: { multi_select: [{ name: d.category }] },
				"Event Start Date": { date: { start: d.eventDate } },
				"Decision Date": { date: { start: d.decisionDate } },
				...(d.outcomeScore != null ? { "Outcome Score": { number: d.outcomeScore } } : {}),
				...(d.starsDelta != null
					? { "GitHub Stars Delta": { number: d.starsDelta } }
					: {}),
				"Outcome Notes": { rich_text: [{ text: { content: d.notes } }] },
			},
		});
		console.log(`  ✓ ${d.decision.padEnd(8)} | ${d.name}`);
	}

	console.log("\nDone. Decision Log seeded.");
}

main().catch((err) => {
	console.error("Seed failed:", err);
	process.exit(1);
});
