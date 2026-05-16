import type { Client } from "@notionhq/client";
import { getDecisionsWithoutOutcome, updateOutcome } from "./decisions.js";

async function getGitHubStars(owner: string, repo: string): Promise<number> {
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
		headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
	});
	if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
	const data = (await res.json()) as { stargazers_count: number };
	return data.stargazers_count;
}

function parseBaselineFromNotes(notes: string): { baselineStars: number; loggedAt: string } | null {
	try {
		const parsed = JSON.parse(notes) as { baselineStars?: number; loggedAt?: string };
		if (typeof parsed.baselineStars === "number" && parsed.loggedAt) {
			return { baselineStars: parsed.baselineStars, loggedAt: parsed.loggedAt };
		}
	} catch {
		// notes is free-form text, not JSON
	}
	return null;
}

export async function collectOutcomes(notion: Client): Promise<{ processed: number; skipped: number }> {
	const owner = process.env.GITHUB_REPO_OWNER!;
	const repo = process.env.GITHUB_REPO_NAME!;

	const decisions = await getDecisionsWithoutOutcome(notion);
	let processed = 0;
	let skipped = 0;

	const currentStars = await getGitHubStars(owner, repo);

	for (const decision of decisions) {
		if (!decision.eventDate) {
			skipped++;
			continue;
		}

		const eventDate = new Date(decision.eventDate);
		const twoWeeksAfter = new Date(eventDate.getTime() + 14 * 24 * 60 * 60 * 1000);
		if (new Date() < twoWeeksAfter) {
			skipped++;
			continue;
		}

		const baseline = parseBaselineFromNotes(decision.outcomeNotes);
		const delta = baseline ? currentStars - baseline.baselineStars : null;

		const updatedNotes = baseline
			? `baseline: ${baseline.baselineStars} stars | current: ${currentStars} | delta: +${delta} | collected: ${new Date().toISOString()}`
			: `current stars: ${currentStars} | no baseline recorded | collected: ${new Date().toISOString()}`;

		await updateOutcome(notion, decision.id, {
			starsData: delta ?? undefined,
			outcomeNotes: updatedNotes,
		});
		processed++;
	}

	return { processed, skipped };
}
