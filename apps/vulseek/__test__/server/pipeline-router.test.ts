import { createCallerFactory } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pipeline router tests (Phase 2b server-side org pipelines).
 *
 * The db boundary is mocked with a fluent thenable query builder (same shape
 * as the dataset router tests): rows are seeded per (operation, table) key in
 * FIFO order. Tests assert org scoping, member-vs-manager permissions, the
 * draft optimistic lock, publish validation and version idempotency.
 */

type RecordedQuery = {
	operation: "select" | "insert" | "update" | "delete";
	table?: unknown;
	joins: Array<{ kind: string; table: unknown }>;
	where?: unknown;
	values?: unknown;
	set?: unknown;
	returning?: boolean;
};

const mocks = vi.hoisted(() => {
	const queries: RecordedQuery[] = [];
	const seedQueue = new Map<string, Array<Array<Record<string, unknown>>>>();
	const claimed = new Map<string, number>();

	const keyOf = (query: RecordedQuery) => {
		const table = query.table as Record<symbol, unknown> | undefined;
		const name = table?.[Symbol.for("drizzle:Name")] ?? "?";
		return `${query.operation}:${String(name)}`;
	};

	class FluentQuery {
		private query: RecordedQuery = { operation: "select", joins: [] };
		private seedRows: Array<Record<string, unknown>> = [];

		constructor(operation: RecordedQuery["operation"]) {
			this.query.operation = operation;
			queries.push(this.query);
		}

		from(table: unknown) {
			this.query.table = table;
			const key = keyOf(this.query);
			const index = claimed.get(key) ?? 0;
			claimed.set(key, index + 1);
			this.seedRows = (seedQueue.get(key) ?? [])[index] ?? [];
			return this;
		}

		leftJoin() {
			return this;
		}
		innerJoin() {
			return this;
		}
		where(condition: unknown) {
			this.query.where = condition;
			return this;
		}
		orderBy() {
			return this;
		}
		limit() {
			return this;
		}
		values(value: unknown) {
			this.query.values = value;
			return this;
		}
		set(value: unknown) {
			this.query.set = value;
			return this;
		}
		returning() {
			this.query.returning = true;
			return this;
		}
		// biome-ignore lint/suspicious/noThenProperty: thenable mock query builder.
		then<TR>(
			onFulfilled?: (rows: Array<Record<string, unknown>>) => TR,
			onRejected?: (error: unknown) => TR,
		) {
			return Promise.resolve(this.seedRows).then(onFulfilled, onRejected);
		}
	}

	const makeDb = () => ({
		select: () => new FluentQuery("select"),
		insert: (table: unknown) => new FluentQuery("insert").from(table),
		update: (table: unknown) => new FluentQuery("update").from(table),
		delete: (table: unknown) => new FluentQuery("delete").from(table),
		transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
			callback(makeDb()),
	});

	return {
		queries,
		seedQueue,
		claimed,
		db: makeDb(),
	};
});

vi.mock("@vulseek/server/db", () => ({ db: mocks.db }));

import { pipelineRouter } from "@/server/api/routers/pipeline";

const seed = (
	operation: "select" | "insert" | "update",
	table: string,
	rows: Array<Record<string, unknown>>,
) => {
	const key = `${operation}:${table}`;
	const batch = mocks.seedQueue.get(key) ?? [];
	batch.push(rows);
	mocks.seedQueue.set(key, batch);
};

const createCaller = createCallerFactory()(pipelineRouter);

const callerFor = (options: { orgId: string; role: "owner" | "admin" | "member" }) =>
	createCaller({
		session: { activeOrganizationId: options.orgId },
		user: {
			id: "user-1",
			role: options.role,
			ownerId: "user-1",
			email: "user@test.local",
		},
		req: undefined,
		res: undefined,
		db: mocks.db,
	} as never);

const VALID_YAML = `version: 3
name: test
supportedTargets:
  - project
root: start
limits:
  maxTasks: 100
  maxDurationSeconds: 3600
schemas: {}
stages:
  start:
    name: Start
    role: scan
    group: g
    concurrency: 1
    runtime:
      prompt: Do the thing.
edges: []
groups: []
`;

const INVALID_YAML = `version: 3
name: broken
stages:
  start:
    name: s
    role: scan
    group: g
    concurrency: 1
    runtime:
      promptFile: sneaky.prompt.md
edges: []
`;

const pipelineRow = (overrides: Record<string, unknown> = {}) => ({
	pipelineId: "pipeline-1",
	organizationId: "org-1",
	slug: "my-pipeline",
	name: "My Pipeline",
	description: null,
	draftYaml: null,
	draftRevision: 0,
	draftBaseVersionId: null,
	currentPublishedVersionId: null,

	archivedAt: null,
	createdAt: "2026-08-07T00:00:00.000Z",
	updatedAt: "2026-08-07T00:00:00.000Z",
	createdBy: null,
	updatedBy: null,
	...overrides,
});

const versionRow = (overrides: Record<string, unknown> = {}) => ({
	pipelineVersionId: "version-1",
	pipelineId: "pipeline-1",
	versionNumber: 1,
	yaml: VALID_YAML,
	contentHash: "abc123",

	publishedBy: "user-1",
	publishedAt: "2026-08-07T00:00:00.000Z",
	...overrides,
});

beforeEach(() => {
	mocks.seedQueue.clear();
	mocks.claimed.clear();
	mocks.queries.length = 0;
});

describe("permissions", () => {
	it("rejects draft management for members", async () => {
		const caller = callerFor({ orgId: "org-1", role: "member" });
		await expect(
			caller.saveDraft({
				pipelineId: "pipeline-1",
				expectedRevision: 0,
				yaml: VALID_YAML,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			caller.publish({
				pipelineId: "pipeline-1",
				expectedRevision: 0,
				yaml: VALID_YAML,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			caller.create({ slug: "x", name: "X" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("allows owners and admins to manage", async () => {
		for (const role of ["owner", "admin"] as const) {
			const caller = callerFor({ orgId: "org-1", role });
			// duplicate slug → CONFLICT from the create guard
			seed("select", "scan_pipelines", [pipelineRow()]);
			await expect(
				caller.create({ slug: "my-pipeline", name: "X" }),
			).rejects.toMatchObject({ code: "CONFLICT" });
		}
	});
});

describe("org scoping", () => {
	it("hides pipelines of other organizations", async () => {
		seed("select", "scan_pipelines", []);
		await expect(
			callerFor({ orgId: "org-2", role: "owner" }).get({
				pipelineId: "pipeline-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("saveDraft", () => {
	it("bumps the revision and returns diagnostics for invalid YAML", async () => {
		seed("update", "scan_pipelines", [{ pipelineId: "pipeline-1" }]);
		const result = await callerFor({ orgId: "org-1", role: "owner" }).saveDraft({
			pipelineId: "pipeline-1",
			expectedRevision: 0,
			yaml: INVALID_YAML,
		});
		expect(result.diagnostics.length).toBeGreaterThan(0);
		// the update carried the bumped revision as its optimistic-lock guard
		const update = mocks.queries.find(
			(q) => q.operation === "update" && q.table !== undefined,
		);
		expect(update?.set).toMatchObject({ draftRevision: 1 });
	});

	it("conflicts when the expected revision is stale", async () => {
		// update matches 0 rows → falls back to reading the current row
		seed("update", "scan_pipelines", []);
		seed("select", "scan_pipelines", [pipelineRow({ draftRevision: 3 })]);
		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).saveDraft({
				pipelineId: "pipeline-1",
				expectedRevision: 0,
				yaml: VALID_YAML,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("publish", () => {
	it("rejects publishing invalid YAML", async () => {
		seed("select", "scan_pipelines", [pipelineRow({ draftYaml: INVALID_YAML })]);
		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).publish({
				pipelineId: "pipeline-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("inserts v1 and switches current in one transaction", async () => {
		seed("select", "scan_pipelines", [pipelineRow({ draftYaml: VALID_YAML })]);
		// no existing version with this hash → max(...) returns null → v1
		seed("select", "scan_pipeline_versions", []);
		seed("select", "scan_pipeline_versions", [{ next: null }]);
		seed("insert", "scan_pipeline_versions", [versionRow({ versionNumber: 1 })]);
		seed("update", "scan_pipelines", [{ pipelineId: "pipeline-1" }]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).publish({
			pipelineId: "pipeline-1",
		});
		expect(result.versionNumber).toBe(1);
		expect(result.contentHash).toHaveLength(64);
	});

	it("is idempotent for an identical content hash", async () => {
		seed("select", "scan_pipelines", [pipelineRow({ draftYaml: VALID_YAML })]);
		// existing version with same hash → reuse, no insert
		seed("select", "scan_pipeline_versions", [
			versionRow({ versionNumber: 2, contentHash: "same-hash" }),
		]);
		seed("update", "scan_pipelines", [{ pipelineId: "pipeline-1" }]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).publish({
			pipelineId: "pipeline-1",
		});
		expect(result.versionNumber).toBe(2);
		const inserts = mocks.queries.filter(
			(q) => q.operation === "insert" && q.table !== undefined,
		);
		expect(inserts).toHaveLength(0);
	});
});

describe("runtimeCatalog", () => {
	it("lists installed agent skills for the editor", async () => {
		const catalog = await callerFor({
			orgId: "org-1",
			role: "member",
		}).runtimeCatalog();
		const names = catalog.skills.map((skill) => skill.name);
		expect(names).toEqual(
			expect.arrayContaining(["goal-craft", "goal-hunt", "codeql"]),
		);
		expect(catalog.skills.every((skill) => skill.name.length > 0)).toBe(true);
	});
});

describe("list / publishedOptions", () => {
	it("lists pipelines with their current version", async () => {
		// the leftJoin over scan_pipeline_versions surfaces its columns on
		// the same row batch in the mock
		seed("select", "scan_pipelines", [
			pipelineRow({
				pipelineId: "pipeline-1",
				currentPublishedVersionId: "version-1",
				currentVersionId: "version-1",
				currentVersionNumber: 1,
				hasDraft: false,
				draftRevision: 0,
			}),
		]);
		const result = await callerFor({ orgId: "org-1", role: "member" }).list();
		expect(result[0]?.pipelineId).toBe("pipeline-1");
		expect(result[0]?.currentVersionNumber).toBe(1);
		// members never see draft state
		expect(result[0]).not.toHaveProperty("hasDraft");
	});
});
