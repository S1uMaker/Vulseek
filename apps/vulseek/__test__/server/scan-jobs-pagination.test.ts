import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Repository tests for the server-side paginated scan job listings
 * (Phase 3a). The db boundary is mocked with a fluent thenable query builder;
 * canned rows are seeded per (operation, table) key in FIFO order so
 * resolution is deterministic whether the repo chains `.then(...)` or awaits
 * a bare thenable. Tests assert on the where/limit/offset/orderBy wiring of
 * listScanJobsByApplicationIdPageRepo / listScanJobsByComposeIdPageRepo and
 * the {items,total} contract.
 */

type RecordedQuery = {
	operation: "select" | "insert" | "update" | "delete";
	table?: unknown;
	joins: Array<{ kind: string; table: unknown }>;
	where?: unknown;
	orderBy?: unknown[];
	limit?: number;
	offset?: number;
};

const mocks = vi.hoisted(() => {
	const queries: RecordedQuery[] = [];
	// key: `${operation}:${tableName}` -> batches of rows, claimed by a query
	// when it is constructed (construction order is deterministic even when
	// the repo chains `.then` on the count query but awaits a bare thenable).
	const seedQueue = new Map<string, Array<Record<string, unknown>[]>>();
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

		/** Sets the target table and claims the next seeded batch for it. */
		from(table: unknown) {
			this.query.table = table;
			const key = keyOf(this.query);
			const index = claimed.get(key) ?? 0;
			claimed.set(key, index + 1);
			this.seedRows = (seedQueue.get(key) ?? [])[index] ?? [];
			return this;
		}

		leftJoin(table: unknown) {
			this.query.joins.push({ kind: "left", table });
			return this;
		}

		where(condition: unknown) {
			this.query.where = condition;
			return this;
		}

		orderBy(...columns: unknown[]) {
			this.query.orderBy = columns;
			return this;
		}

		limit(value: number) {
			this.query.limit = value;
			return this;
		}

		offset(value: number) {
			this.query.offset = value;
			return this;
		}

		// biome-ignore lint/suspicious/noThenProperty: thenable mock query builder; await resolves the seeded rows.
		then<TR>(
			onFulfilled?: (rows: Array<Record<string, unknown>>) => TR,
			onRejected?: (error: unknown) => TR,
		) {
			return Promise.resolve(this.seedRows).then(onFulfilled, onRejected);
		}
	}

	const db = {
		select: () => new FluentQuery("select"),
		insert: (table: unknown) => new FluentQuery("insert").from(table),
		update: (table: unknown) => new FluentQuery("update").from(table),
		delete: (table: unknown) => new FluentQuery("delete").from(table),
	};

	return {
		queries,
		seedQueue,
		claimed,
		db,
		closeDbConnection: vi.fn(),
	};
});

vi.mock("@vulseek/server/db", () => ({
	db: mocks.db,
	dbConnection: undefined,
	closeDbConnection: mocks.closeDbConnection,
}));

import {
	listScanJobsByApplicationIdPageRepo,
	listScanJobsByComposeIdPageRepo,
} from "@vulseek/server/services/scan/persistence/scan-job.repo";

const renderChunk = (chunk: unknown): string => {
	if (chunk == null) return "";
	if (typeof chunk === "string") return chunk;
	const value = chunk as Record<string, unknown>;
	if (
		typeof value.name === "string" &&
		typeof value.columnType === "string" &&
		value.table
	) {
		const table = (value.table as Record<symbol, unknown>)[
			Symbol.for("drizzle:Name")
		];
		return `${String(table ?? "?")}.${value.name}`;
	}
	if (Array.isArray(value.queryChunks)) {
		return (value.queryChunks as unknown[]).map(renderChunk).join("");
	}
	if (Array.isArray(value.value)) {
		return (value.value as unknown[])
			.map((item) => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object") {
					const nested = (item as { value?: unknown }).value;
					return typeof nested === "string" ? nested : String(nested);
				}
				return String(item);
			})
			.join("");
	}
	if ("value" in value) return JSON.stringify(value.value);
	return JSON.stringify(value);
};

const renderCondition = (condition: unknown): string =>
	condition == null
		? ""
		: Array.isArray((condition as { queryChunks?: unknown[] }).queryChunks)
			? (condition as { queryChunks: unknown[] }).queryChunks
					.map(renderChunk)
					.join("")
			: JSON.stringify(condition);

const renderOrderBy = (columns?: unknown[]) =>
	(columns ?? []).map((column) => renderCondition(column)).join(", ");

const queriesOf = (operation: RecordedQuery["operation"]) =>
	mocks.queries.filter((query) => query.operation === operation);

const lastQuery = (operation: RecordedQuery["operation"]) => {
	const matches = queriesOf(operation);
	return matches[matches.length - 1];
};

/** First recorded query — the items query, since the count query is constructed after it. */
const firstQuery = (operation: RecordedQuery["operation"]) =>
	queriesOf(operation)[0];

const tableName = (table: unknown) =>
	String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")] ?? "?");

const seedSelect = (
	table: string,
	...batches: Array<Record<string, unknown>[]>
) => {
	for (const batch of batches) {
		const key = `select:${table}`;
		const list = mocks.seedQueue.get(key) ?? [];
		list.push(batch);
		mocks.seedQueue.set(key, list);
	}
};

const scanJobRow = (overrides: Record<string, unknown> = {}) => ({
	scanJobId: "job-1",
	title: "Full Scan Job",
	description: "",
	note: null,
	pipelineId: "pipeline-full",
	pipelineSlug: "full",
	status: "finished",
	triggerSource: "manual",
	createdAt: "2026-01-01T00:00:00.000Z",
	applicationId: "app-1",
	composeId: null,
	repositoryTaskId: "task-1",
	repositoryTaskStatus: "completed",
	...overrides,
});

beforeEach(() => {
	mocks.queries.length = 0;
	mocks.seedQueue.clear();
	mocks.claimed.clear();
});

describe("listScanJobsByApplicationIdPageRepo", () => {
	it("returns {items,total} scoped to the application", async () => {
		seedSelect("scan_jobs", [scanJobRow()], [{ count: 3 }]);

		const result = await listScanJobsByApplicationIdPageRepo("app-1", {
			page: 1,
			pageSize: 12,
		});

		const itemQuery = firstQuery("select");
		expect(tableName(itemQuery?.table)).toBe("scan_jobs");
		expect(itemQuery?.joins).toHaveLength(1);
		expect(tableName(itemQuery?.joins[0]?.table)).toBe("tasks");
		expect(renderCondition(itemQuery?.where)).toContain(
			'scan_jobs.applicationId = "app-1"',
		);
		expect(renderOrderBy(itemQuery?.orderBy)).toContain(
			"scan_jobs.createdAt desc",
		);
		expect(itemQuery?.limit).toBe(12);
		expect(itemQuery?.offset).toBe(0);
		expect(result.items[0]?.scanJobId).toBe("job-1");
		expect(result.items[0]?.repositoryTaskStatus).toBe("completed");
		expect(result.total).toBe(3);
	});

	it("filters by status and search across description and note", async () => {
		seedSelect("scan_jobs", [], [{ count: 0 }]);

		await listScanJobsByApplicationIdPageRepo("app-1", {
			page: 2,
			pageSize: 20,
			search: "auth bypass",
			status: "running",
		});

		const itemQuery = firstQuery("select");
		const where = renderCondition(itemQuery?.where);
		expect(where).toContain('scan_jobs.status = "running"');
		expect(where).toContain(
			"scan_jobs.description ilike %auth bypass% or scan_jobs.note ilike %auth bypass%",
		);
		expect(itemQuery?.limit).toBe(20);
		expect(itemQuery?.offset).toBe(20);
	});

	it("counts without a task join", async () => {
		seedSelect("scan_jobs", [scanJobRow()], [{ count: 1 }]);

		await listScanJobsByApplicationIdPageRepo("app-1", {
			page: 1,
			pageSize: 12,
			status: "failed",
		});

		const selects = queriesOf("select");
		expect(selects).toHaveLength(2);
		const countQuery = selects[1];
		expect(countQuery?.joins).toHaveLength(0);
		expect(renderCondition(countQuery?.where)).toContain(
			'scan_jobs.status = "failed"',
		);
		expect(renderCondition(countQuery?.where)).toContain(
			'scan_jobs.applicationId = "app-1"',
		);
	});
});

describe("listScanJobsByComposeIdPageRepo", () => {
	it("returns {items,total} scoped to the compose service", async () => {
		seedSelect(
			"scan_jobs",
			[scanJobRow({ composeId: "compose-1" })],
			[{ count: 1 }],
		);

		const result = await listScanJobsByComposeIdPageRepo("compose-1", {
			page: 1,
			pageSize: 12,
		});

		const itemQuery = firstQuery("select");
		expect(renderCondition(itemQuery?.where)).toContain(
			'scan_jobs.composeId = "compose-1"',
		);
		expect(result.total).toBe(1);
		expect(result.items[0]?.composeId).toBe("compose-1");
	});

	it("combines search/status filters with the compose scope", async () => {
		seedSelect("scan_jobs", [], [{ count: 0 }]);

		await listScanJobsByComposeIdPageRepo("compose-1", {
			page: 3,
			pageSize: 50,
			search: "CVE",
			status: "partially_finished",
		});

		const where = renderCondition(lastQuery("select")?.where);
		expect(where).toContain('scan_jobs.composeId = "compose-1"');
		expect(where).toContain('scan_jobs.status = "partially_finished"');
		expect(where).toContain(
			"scan_jobs.description ilike %CVE% or scan_jobs.note ilike %CVE%",
		);
	});
});
