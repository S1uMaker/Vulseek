import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { env } from "node:process";
import { beforeEach, describe, expect, it } from "vitest";

// Point this only at a disposable Postgres container. No application database
// connection or credentials are used by these integration tests.
const container = env.VULSEEK_LEDGER_TEST_CONTAINER;
const migration = readFileSync(
	new URL("../../drizzle/0248_scan_ledger_integer_id.sql", import.meta.url),
	"utf8",
);

const sql = (query: string) =>
	execFileSync(
		"docker",
		[
			"exec",
			"-i",
			container!,
			"psql",
			"-U",
			"postgres",
			"-d",
			"postgres",
			"-X",
			"-qAt",
			"-v",
			"ON_ERROR_STOP=1",
			"--single-transaction",
		],
		{
			input: `SET search_path TO ledger_integer_id_test;\n${query}`,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		},
	).trim();

const json = (value: unknown) =>
	`'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

describe.skipIf(!container)("Ledger integer ID migration (Postgres)", () => {
	beforeEach(() => {
		sql(`
			DROP SCHEMA IF EXISTS ledger_integer_id_test CASCADE;
			CREATE SCHEMA ledger_integer_id_test;
			CREATE TABLE scan_ledger_entries (
				id text PRIMARY KEY,
				"createdAt" text NOT NULL DEFAULT '2026-09-18T00:00:00Z',
				statement text NOT NULL DEFAULT 'statement',
				revision integer NOT NULL DEFAULT 7,
				assessment jsonb,
				evidence jsonb NOT NULL DEFAULT '[]',
				gaps jsonb NOT NULL DEFAULT '[]',
				links jsonb NOT NULL DEFAULT '[]',
				changes jsonb NOT NULL DEFAULT '[]'
			);
		`);
	});

	it("preserves rows and remaps all structured pointers including history", () => {
		const pointers = {
			assessment: {
				evidenceRefs: [{ entryId: "10", evidenceId: "old-source" }],
				dependencyRefs: [{ entryId: "old-source", revision: 7 }],
			},
			evidence: [
				{
					id: "old-source",
					kind: "derivation",
					summary: "old-source",
					ref: { inputs: [{ entryId: "old-source", revision: 7 }] },
				},
			],
			gaps: [
				{
					id: "old-source",
					status: "resolved",
					resultRefs: [{ entryId: "old-source", evidenceId: "ev-source" }],
				},
			],
			links: [
				{
					id: "old-source",
					targetId: "old-source",
					relation: "depends_on",
					scopeHypothesisId: "old-hypothesis",
				},
			],
			changes: [
				{
					id: "chg-1",
					field: "links",
					from: [],
					to: [{ targetId: "old-source", scopeHypothesisId: "old-hypothesis" }],
					evidenceRefs: [{ entryId: "10", evidenceId: "old-source" }],
				},
				{
					field: "assessment",
					from: { dependencyRefs: [{ entryId: "old-source", revision: 6 }] },
					to: null,
				},
			],
		};
		sql(`
			INSERT INTO scan_ledger_entries (id, "createdAt", statement, assessment, evidence, gaps, links, changes)
			VALUES ('10', '2026-01-01', 'old-source', ${json(pointers.assessment)},
				${json(pointers.evidence)}, ${json(pointers.gaps)}, ${json(pointers.links)}, ${json(pointers.changes)});
			INSERT INTO scan_ledger_entries (id, "createdAt") VALUES
				('old-hypothesis', '2026-01-03'), ('old-source', '2026-01-02');
		`);
		sql(migration);
		const rows = JSON.parse(
			sql("SELECT json_agg(t ORDER BY id) FROM scan_ledger_entries t"),
		);
		expect(rows.map((row: { id: number }) => row.id)).toEqual([1, 2, 3]);
		expect(rows[0]).toMatchObject({
			id: 1,
			statement: "old-source",
			revision: 7,
			assessment: {
				evidenceRefs: [{ entryId: 1, evidenceId: "old-source" }],
				dependencyRefs: [{ entryId: 2, revision: 7 }],
			},
			evidence: [
				{
					id: "old-source",
					summary: "old-source",
					ref: { inputs: [{ entryId: 2, revision: 7 }] },
				},
			],
			gaps: [
				{
					id: "old-source",
					resultRefs: [{ entryId: 2, evidenceId: "ev-source" }],
				},
			],
			links: [{ id: "old-source", targetId: 2, scopeHypothesisId: 3 }],
			changes: [
				{
					to: [{ targetId: 2, scopeHypothesisId: 3 }],
					evidenceRefs: [{ entryId: 1, evidenceId: "old-source" }],
				},
				{ from: { dependencyRefs: [{ entryId: 2, revision: 6 }] } },
			],
		});
		expect(rows[1]).toMatchObject({
			assessment: null,
			evidence: [],
			gaps: [],
			links: [],
			changes: [],
		});
		expect(
			sql("INSERT INTO scan_ledger_entries DEFAULT VALUES RETURNING id"),
		).toBe("4");
		expect(
			sql("INSERT INTO scan_ledger_entries DEFAULT VALUES RETURNING id"),
		).toBe("5");
		expect(() =>
			sql("INSERT INTO scan_ledger_entries (id) VALUES (100)"),
		).toThrow();
		expect(() =>
			sql("UPDATE scan_ledger_entries SET id = 100 WHERE id = 1"),
		).toThrow();
	});

	it("starts an empty ledger at one with a database identity", () => {
		sql(migration);
		expect(
			sql("INSERT INTO scan_ledger_entries DEFAULT VALUES RETURNING id"),
		).toBe("1");
		expect(
			sql(`SELECT data_type || ':' || identity_generation FROM information_schema.columns
			WHERE table_schema = 'ledger_integer_id_test' AND table_name = 'scan_ledger_entries' AND column_name = 'id'`),
		).toBe("integer:ALWAYS");
	});

	it("rolls back if a historical pointer cannot be mapped", () => {
		sql(`INSERT INTO scan_ledger_entries (id, links)
			VALUES ('old-entry', '[{"id":"link-1","targetId":"missing-entry"}]')`);
		expect(() => sql(migration)).toThrow();
		const row = JSON.parse(
			sql("SELECT row_to_json(t) FROM scan_ledger_entries t"),
		);
		expect(row).toMatchObject({
			id: "old-entry",
			links: [{ targetId: "missing-entry" }],
		});
		expect(
			sql(`SELECT data_type FROM information_schema.columns
			WHERE table_schema = 'ledger_integer_id_test' AND table_name = 'scan_ledger_entries' AND column_name = 'id'`),
		).toBe("text");
	});
});
