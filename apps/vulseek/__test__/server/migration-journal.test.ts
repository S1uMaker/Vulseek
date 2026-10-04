import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
}

describe("migration journal", () => {
	it("registers every migration except the known legacy duplicate", () => {
		const drizzleDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../drizzle",
		);
		const journal = JSON.parse(
			readFileSync(join(drizzleDirectory, "meta/_journal.json"), "utf8"),
		) as { entries: JournalEntry[] };
		const sqlTags = readdirSync(drizzleDirectory)
			.filter((fileName) => fileName.endsWith(".sql"))
			.map((fileName) => fileName.slice(0, -4));
		const journalTags = new Set(journal.entries.map((entry) => entry.tag));
		const unregisteredTags = sqlTags
			.filter((tag) => !journalTags.has(tag))
			.sort();

		expect(journal.entries).toHaveLength(251);
		expect(journal.entries.at(-1)?.tag).toBe("0250_scan_ledger_functions");
		expect(unregisteredTags).toEqual(["0057_damp_prism"]);
		expect(journal.entries.map((entry) => entry.idx)).toEqual(
			journal.entries.map((_, index) => index),
		);
		expect(journal.entries.map((entry) => entry.when)).toEqual(
			journal.entries.map((entry) => entry.when).sort((a, b) => a - b),
		);
	});

	it("removes claims and event history while retaining entity revisions", () => {
		const drizzleDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../drizzle",
		);
		const migration = readFileSync(
			join(drizzleDirectory, "0220_agent_owned_research_registry.sql"),
			"utf8",
		);
		const schema = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../../../../packages/server/src/db/schema/research.ts",
			),
			"utf8",
		);

		for (const table of [
			"research_entity_claims",
			"research_track_events",
			"research_finding_events",
			"exploit_primitive_events",
			"exploit_chain_events",
		]) {
			expect(migration).toContain(`DROP TABLE IF EXISTS "${table}"`);
			expect(schema).not.toContain(`export const ${table}`);
		}
		expect(schema).not.toContain("currentTaskId");
		expect(schema).toContain('revision: integer("revision")');
	});

	it("creates messages and drops old Task protocol columns", () => {
		const drizzleDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../drizzle",
		);
		const migration = readFileSync(
			join(drizzleDirectory, "0238_task_outputs.sql"),
			"utf8",
		);
		expect(migration).toContain("pending', 'running', 'paused', 'finalizing");
		expect(migration).toContain('CREATE TABLE IF NOT EXISTS "task_outputs"');
		expect(migration).toContain("'legacy:' || t.\"taskId\"");
		expect(migration).toContain('DROP COLUMN IF EXISTS "input"');
		expect(migration).toContain('DROP COLUMN IF EXISTS "output"');
		expect(migration).toContain('DROP COLUMN IF EXISTS "parentTaskId"');
		expect(migration).toContain('DROP COLUMN IF EXISTS "dispatchKey"');
		expect(migration).toContain("taskLifecycle");
		expect(migration).not.toContain("/task/output.json");
	});

	it("creates messages and migrates task_outputs", () => {
		const drizzleDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../drizzle",
		);
		const migration = readFileSync(
			join(drizzleDirectory, "0239_messages.sql"),
			"utf8",
		);
		expect(migration).toContain('CREATE TABLE IF NOT EXISTS "messages"');
		expect(migration).toContain('"sourceTaskId"');
		expect(migration).toContain('"payload" jsonb');
		expect(migration).toContain("scan_job_stage_stats");
		expect(migration).toContain("DROP TABLE IF EXISTS \"task_outputs\"");
	});

	it("adds a JSONB output list to scan jobs", () => {
		const drizzleDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../drizzle",
		);
		const migration = readFileSync(
			join(drizzleDirectory, "0228_scan_job_outputs.sql"),
			"utf8",
		);

		expect(migration).toContain('ALTER TABLE "scan_jobs"');
		expect(migration).toContain('"outputs" jsonb');
		expect(migration).toContain("DEFAULT '[]'::jsonb NOT NULL");
	});

	it("migrates prompt file names stored in pipeline snapshots", () => {
		const drizzleDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../drizzle",
		);
		const migration = readFileSync(
			join(drizzleDirectory, "0211_canonical_scan_prompt_files.sql"),
			"utf8",
		);

		for (const [legacyName, canonicalName] of [
			["scan-repository.prompt.md", "repository-profile.prompt.md"],
			["analyze.prompt.md", "analyze-finding.prompt.md"],
			["criticize.prompt.md", "critique-finding.prompt.md"],
			["verify.prompt.md", "verify-finding.prompt.md"],
			["triage.prompt.md", "triage-finding.prompt.md"],
		]) {
			expect(migration).toContain(legacyName);
			expect(migration).toContain(canonicalName);
		}
	});
});
