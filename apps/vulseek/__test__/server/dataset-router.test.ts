import { createCallerFactory } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * tRPC router tests for the dataset router (Phase 3a server-side pagination).
 *
 * The db boundary is mocked with a fluent thenable query builder. Canned rows
 * are seeded per (operation, table) key in FIFO order — the same key a query
 * records when built — so resolution is deterministic regardless of whether
 * the router chains `.then(...)` or awaits a bare thenable in Promise.all.
 * Tests assert on org authorization, search/filter/sort/pagination wiring,
 * and the {items,total,page,pageSize} response contract without a database.
 */

type RecordedQuery = {
	operation: "select" | "insert" | "update" | "delete";
	table?: unknown;
	joins: Array<{ kind: string; table: unknown }>;
	where?: unknown;
	orderBy?: unknown[];
	groupBy?: unknown[];
	limit?: number;
	offset?: number;
	values?: unknown;
	set?: unknown;
};

const mocks = vi.hoisted(() => {
	const queries: RecordedQuery[] = [];
	// key: `${operation}:${tableName}` -> batches of rows, claimed by a query
	// when it is constructed (construction order is deterministic even when
	// the router mixes chained `.then` and bare thenables in Promise.all).
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

		innerJoin(table: unknown) {
			this.query.joins.push({ kind: "inner", table });
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

		groupBy(...columns: unknown[]) {
			this.query.groupBy = columns;
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
		datasetEvaluationQueue: { add: vi.fn() },
		cancelScanJob: vi.fn(),
		getScanPipelineDefinitions: vi.fn(),
		pauseScanJob: vi.fn(),
		findDatasetProfileCheckoutStatus: vi.fn(),
		pruneDatasetProfile: vi.fn(),
		resumeScanJob: vi.fn(),
		startDatasetProfileCheckout: vi.fn(),
		validateRequest: vi.fn(),
	};
});

vi.mock("@/server/db", () => ({ db: mocks.db }));

vi.mock("@/server/queues/queueSetup", () => ({
	datasetEvaluationQueue: mocks.datasetEvaluationQueue,
}));

vi.mock("@vulseek/server", () => ({
	cancelScanJob: mocks.cancelScanJob,
	getScanPipelineDefinitions: mocks.getScanPipelineDefinitions,
	pauseScanJob: mocks.pauseScanJob,
	findDatasetProfileCheckoutStatus: mocks.findDatasetProfileCheckoutStatus,
	pruneDatasetProfile: mocks.pruneDatasetProfile,
	resumeScanJob: mocks.resumeScanJob,
	startDatasetProfileCheckout: mocks.startDatasetProfileCheckout,
}));

vi.mock("@vulseek/server/lib/auth", () => ({
	validateRequest: mocks.validateRequest,
}));

import { datasetRouter } from "@/server/api/routers/dataset";

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

/** First recorded query on the given table — the items query, since the count query is always constructed after it. */
const firstQueryOn = (operation: RecordedQuery["operation"], table: string) => {
	const matches = queriesOf(operation).filter((query) => {
		const name = (query.table as Record<symbol, unknown> | undefined)?.[
			Symbol.for("drizzle:Name")
		];
		return name === table;
	});
	return matches[0];
};

/** Last recorded query on the given table (creation order is deterministic). */
const lastQueryOn = (operation: RecordedQuery["operation"], table: string) => {
	const matches = queriesOf(operation).filter((query) => {
		const name = (query.table as Record<symbol, unknown> | undefined)?.[
			Symbol.for("drizzle:Name")
		];
		return name === table;
	});
	return matches[matches.length - 1];
};

const tableName = (table: unknown) =>
	String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")] ?? "?");

const createCaller = createCallerFactory()(datasetRouter);

const callerFor = (options: {
	orgId: string;
	role: "owner" | "admin" | "member";
}) =>
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

const datasetRow = (overrides: Record<string, unknown> = {}) => ({
	datasetId: "ds-1",
	organizationId: "org-1",
	name: "payments",
	description: "payment service",
	source: { type: "local", path: "/repos/payments" },
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
	...overrides,
});

const profileRow = (overrides: Record<string, unknown> = {}) => ({
	profileId: "profile-1",
	datasetId: "ds-1",
	profileKey: "default",
	status: "ready",
	hostRoot: "/data/vulseek/profiles/profile-1",
	sourceDigest: null,
	toolsImageTag: `vulseek-scan-tools-dev:${"a".repeat(16)}`,
	toolsImageDigest: "sha256:tools-image",
	errorMessage: null,
	selectedSampleIds: ["sample-1"],
	configSnapshot: {},
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...overrides,
});

const pushBatch = (key: string, batch: Array<Record<string, unknown>>) => {
	const list = mocks.seedQueue.get(key) ?? [];
	list.push(batch);
	mocks.seedQueue.set(key, list);
};

const seedQuery = (
	operation: RecordedQuery["operation"],
	table: string,
	...batches: Array<Record<string, unknown>[]>
) => {
	for (const batch of batches) pushBatch(`${operation}:${table}`, batch);
};

const seedSelect = (
	table: string,
	...batches: Array<Record<string, unknown>[]>
) => seedQuery("select", table, ...batches);

const seedInsert = (
	table: string,
	...batches: Array<Record<string, unknown>[]>
) => seedQuery("insert", table, ...batches);

const seedDelete = (
	table: string,
	...batches: Array<Record<string, unknown>[]>
) => seedQuery("delete", table, ...batches);

beforeEach(() => {
	mocks.queries.length = 0;
	mocks.seedQueue.clear();
	mocks.claimed.clear();
	mocks.datasetEvaluationQueue.add.mockClear();
	mocks.pruneDatasetProfile.mockClear();
	mocks.findDatasetProfileCheckoutStatus.mockClear();
	mocks.startDatasetProfileCheckout.mockClear();
	mocks.startDatasetProfileCheckout.mockReturnValue({
		checkoutId: "checkout-1",
		profileId: "profile-1",
		status: "running",
		phase: "validating_source",
		message: "Starting dataset checkout",
		manifestProgress: null,
		startedAt: "2026-08-09T00:00:00.000Z",
	});
	mocks.getScanPipelineDefinitions.mockReturnValue({
		pipelines: {
			full: { rootStageId: "repository-profile" },
			research: { rootStageId: "research-scope" },
			"tob-goal": { rootStageId: "goal-scope" },
		},
	});
});

describe("dataset.list", () => {
	it("is scoped to the caller organization", async () => {
		seedSelect("datasets", [datasetRow()], [{ count: 1 }]);
		seedSelect("dataset_evaluations", [{ datasetId: "ds-1", count: 2 }]);
		seedSelect("dataset_samples", [{ datasetId: "ds-1", count: 3 }]);

		const result = await callerFor({ orgId: "org-1", role: "member" }).list({});

		const where = renderCondition(firstQueryOn("select", "datasets")?.where);
		expect(where).toContain('datasets.organizationId = "org-1"');
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.datasetId).toBe("ds-1");
		expect(result.items[0]?.evaluationCount).toBe(2);
		expect(result.items[0]?.sampleCount).toBe(3);
		expect(result.total).toBe(1);
		expect(result.page).toBe(1);
		expect(result.pageSize).toBe(12);
	});

	it("searches name and description with ilike", async () => {
		seedSelect("datasets", [], [{ count: 0 }]);

		await callerFor({ orgId: "org-1", role: "member" }).list({ search: "pay" });

		const where = renderCondition(firstQueryOn("select", "datasets")?.where);
		expect(where).toContain(
			"datasets.name ilike %pay% or datasets.description ilike %pay%",
		);
	});

	it("applies sortKey/sortDirection to the orderBy clause", async () => {
		seedSelect("datasets", [], [{ count: 0 }]);

		await callerFor({ orgId: "org-1", role: "member" }).list({
			sortKey: "name",
			sortDirection: "asc",
		});

		const itemsQuery = firstQueryOn("select", "datasets");
		expect(renderOrderBy(itemsQuery?.orderBy)).toContain("datasets.name asc");
	});

	it("paginates with limit and offset and returns the page contract", async () => {
		seedSelect("datasets", [], [{ count: 7 }]);

		const result = await callerFor({ orgId: "org-1", role: "member" }).list({
			page: 3,
			pageSize: 20,
		});

		const itemsQuery = firstQueryOn("select", "datasets");
		expect(itemsQuery?.limit).toBe(20);
		expect(itemsQuery?.offset).toBe(40);
		expect(result.total).toBe(7);
		expect(result.page).toBe(3);
		expect(result.pageSize).toBe(20);
	});

	it("returns early with total when no rows match", async () => {
		seedSelect("datasets", [], [{ count: 4 }]);

		const result = await callerFor({ orgId: "org-1", role: "member" }).list({
			page: 2,
			pageSize: 12,
		});

		expect(result).toEqual({ items: [], total: 4, page: 2, pageSize: 12 });
		expect(queriesOf("select")).toHaveLength(2);
	});
});

describe("dataset.one", () => {
	it("returns the dataset with canManage for owners", async () => {
		seedSelect("datasets", [datasetRow()]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).one({
			datasetId: "ds-1",
		});

		expect(result.datasetId).toBe("ds-1");
		expect(result.canManage).toBe(true);
	});

	it("returns canManage false for members", async () => {
		seedSelect("datasets", [datasetRow()]);

		const result = await callerFor({ orgId: "org-1", role: "member" }).one({
			datasetId: "ds-1",
		});

		expect(result.canManage).toBe(false);
	});

	it("rejects when the dataset belongs to another organization", async () => {
		seedSelect("datasets");

		await expect(
			callerFor({ orgId: "org-2", role: "owner" }).one({ datasetId: "ds-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("dataset.create", () => {
	it("rejects members", async () => {
		await expect(
			callerFor({ orgId: "org-1", role: "member" }).create({
				name: "new dataset",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("rejects relative local paths", async () => {
		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).create({
				name: "new dataset",
				source: { type: "local", path: "relative/path" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("inserts scoped to the caller organization", async () => {
		seedInsert("datasets", [datasetRow({ name: "new dataset" })]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).create({
			name: "new dataset",
			description: "desc",
			source: { type: "local", path: "/repos/new" },
		});

		expect(result?.name).toBe("new dataset");
		const insert = lastQuery("insert");
		expect(insert?.values).toMatchObject({
			organizationId: "org-1",
			name: "new dataset",
			source: { type: "local", path: "/repos/new" },
		});
	});
});

describe("dataset.profiles.list", () => {
	it("requires the dataset to exist in the caller org, filters by status, and paginates", async () => {
		seedSelect("datasets", [datasetRow()]);
		seedSelect("dataset_profiles", [profileRow()], [{ count: 1 }]);
		seedSelect("dataset_samples", [{ profileId: "profile-1", count: 4 }]);

		const result = await callerFor({
			orgId: "org-1",
			role: "owner",
		}).profiles.list({
			datasetId: "ds-1",
			status: "ready",
			page: 1,
			pageSize: 12,
		});

		const where = renderCondition(
			firstQueryOn("select", "dataset_profiles")?.where,
		);
		expect(where).toContain('dataset_profiles.datasetId = "ds-1"');
		expect(where).toContain('dataset_profiles.status = "ready"');
		expect(result.items[0]?.sampleCount).toBe(4);
		expect(result.total).toBe(1);
		expect(result.page).toBe(1);
		expect(result.pageSize).toBe(12);
	});

	it("rejects when the dataset belongs to another organization", async () => {
		seedSelect("datasets");

		await expect(
			callerFor({ orgId: "org-2", role: "owner" }).profiles.list({
				datasetId: "ds-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("dataset.profiles.checkout", () => {
	it("rejects when an active evaluation locks the profile", async () => {
		seedSelect("dataset_profiles", [profileRow()]);
		seedSelect("dataset_evaluations", [{ evaluationId: "e-1" }]);

		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).profiles.checkout({
				profileId: "profile-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.startDatasetProfileCheckout).not.toHaveBeenCalled();
	});

	it("prepares the profile when unlocked", async () => {
		seedSelect("dataset_profiles", [profileRow()], [profileRow()]);
		seedSelect("dataset_evaluations");

		const result = await callerFor({
			orgId: "org-1",
			role: "owner",
		}).profiles.checkout({
			profileId: "profile-1",
		});

		expect(mocks.startDatasetProfileCheckout).toHaveBeenCalledWith("profile-1");
		expect(result?.checkoutId).toBe("checkout-1");
	});
});

describe("dataset.evaluations.list", () => {
	it("scopes by org and applies dataset/profile/status/search filters", async () => {
		seedSelect(
			"dataset_evaluations",
			[
				{
					evaluation: {
						evaluationId: "e-1",
						datasetId: "ds-1",
						profileId: "profile-1",
						name: "eval one",
						status: "completed",
					},
					profileKey: "default",
				},
			],
			[{ count: 1 }],
		);

		const result = await callerFor({
			orgId: "org-1",
			role: "member",
		}).evaluations.list({
			datasetId: "ds-1",
			profileId: "profile-1",
			status: "completed",
			search: "eval",
			page: 2,
			pageSize: 25,
		});

		const itemsQuery = firstQueryOn("select", "dataset_evaluations");
		const where = renderCondition(itemsQuery?.where);
		expect(where).toContain('datasets.organizationId = "org-1"');
		expect(where).toContain('dataset_evaluations.datasetId = "ds-1"');
		expect(where).toContain('dataset_evaluations.profileId = "profile-1"');
		expect(where).toContain('dataset_evaluations.status = "completed"');
		expect(where).toContain("dataset_evaluations.name ilike %eval%");
		expect(itemsQuery?.limit).toBe(25);
		expect(itemsQuery?.offset).toBe(25);
		expect(result.items[0]?.name).toBe("eval one");
		expect(result.items[0]?.profileKey).toBe("default");
		expect(result.total).toBe(1);
	});
});

describe("dataset.evaluations.one", () => {
	it("returns the evaluation with trial totals for the caller org", async () => {
		seedSelect("dataset_evaluations", [
			{
				evaluation: {
					evaluationId: "e-1",
					status: "completed",
				},
				dataset: { name: "payments" },
				profile: { profileKey: "default" },
			},
		]);
		seedSelect("dataset_evaluation_trials", [
			{ durationMs: 100, totalTokens: 50, estimatedCost: 1.25, count: 2 },
		]);

		const result = await callerFor({
			orgId: "org-1",
			role: "member",
		}).evaluations.one({
			evaluationId: "e-1",
		});

		expect(result.evaluationId).toBe("e-1");
		expect(result.datasetName).toBe("payments");
		expect(result.profileKey).toBe("default");
		expect(result.trialCount).toBe(2);
		expect(result.totals).toEqual({
			durationMs: 100,
			totalTokens: 50,
			estimatedCost: 1.25,
		});
	});

	it("rejects for a different organization", async () => {
		seedSelect("dataset_evaluations");

		await expect(
			callerFor({ orgId: "org-2", role: "owner" }).evaluations.one({
				evaluationId: "e-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("dataset.evaluations.trialsList", () => {
	it("scopes by org, filters by status/search on samples, and maps the sample", async () => {
		seedSelect("dataset_evaluations", [{ evaluationId: "e-1" }]);
		seedSelect(
			"dataset_evaluation_trials",
			[
				{
					dataset_evaluation_trials: {
						trialId: "trial-1",
						evaluationId: "e-1",
						status: "completed",
						ordinal: 0,
					},
					dataset_samples: {
						sampleId: "sample-1",
						id: "sample-1",
						title: "Sample one",
						groundTruthArtifacts: [
							"ground-truth/description.txt",
						],
					},
				},
			],
			[{ count: 1 }],
		);

		const result = await callerFor({
			orgId: "org-1",
			role: "member",
		}).evaluations.trialsList({
			evaluationId: "e-1",
			status: "completed",
			search: "Sample",
			page: 1,
			pageSize: 12,
		});

		const itemsQuery = lastQueryOn("select", "dataset_evaluation_trials");
		const where = renderCondition(itemsQuery?.where);
		expect(where).toContain('dataset_evaluation_trials.evaluationId = "e-1"');
		expect(where).toContain('dataset_evaluation_trials.status = "completed"');
		expect(where).toContain(
			"dataset_samples.id ilike %Sample% or dataset_samples.title ilike %Sample%",
		);
		expect(result.items[0]?.trialId).toBe("trial-1");
		expect(result.items[0]?.sample).toMatchObject({
			sampleId: "sample-1",
			id: "sample-1",
			title: "Sample one",
			groundTruthArtifacts: ["ground-truth/description.txt"],
		});
		expect(result.total).toBe(1);
	});

	it("rejects for a different organization", async () => {
		seedSelect("dataset_evaluations");

		await expect(
			callerFor({ orgId: "org-2", role: "owner" }).evaluations.trialsList({
				evaluationId: "e-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("dataset.evaluations.create", () => {
	const evaluationInput = {
		datasetId: "ds-1",
		profileId: "profile-1",
		name: "eval",
		pipelineId: "full" as "full" | "research" | "tob-goal",
		sampleIds: ["sample-1"],
		repetitions: 2,
	};

	it("rejects members", async () => {
		await expect(
			callerFor({ orgId: "org-1", role: "member" }).evaluations.create(
				evaluationInput,
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("rejects non-ready profiles", async () => {
		seedSelect("datasets", [datasetRow()]);
		seedSelect("dataset_profiles", [profileRow({ status: "failed" })]);

		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).evaluations.create(
				evaluationInput,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects ready profiles without a pinned tools image", async () => {
		seedSelect("datasets", [datasetRow()]);
		seedSelect(
			"dataset_profiles",
			[
				profileRow({
					toolsImageTag: null,
					toolsImageDigest: null,
				}),
			],
		);

		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).evaluations.create(
				evaluationInput,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "A checked-out Dataset Profile with a pinned tools image is required",
		});
	});

	it("rejects unknown pipelines", async () => {
		seedSelect("datasets", [datasetRow()]);
		seedSelect("dataset_profiles", [profileRow()]);
		seedSelect("dataset_samples", [
			{ id: "sample-1", profileId: "profile-1", ordinal: 0 },
		]);

		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).evaluations.create({
				...evaluationInput,
				pipelineId: "bogus" as "full" | "research" | "tob-goal",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("creates the evaluation with trials and enqueues the queue job", async () => {
		seedSelect("datasets", [datasetRow()]);
		seedSelect("dataset_profiles", [profileRow()]);
		seedSelect("dataset_samples", [
			{ id: "sample-1", profileId: "profile-1", ordinal: 0 },
			{ id: "sample-2", profileId: "profile-1", ordinal: 1 },
		]);
		seedSelect("scan_pipelines", [
			{
				pipelineId: "full",
				organizationId: "org-1",
				archivedAt: null,
				currentPublishedVersionId: "version-1",
			},
		]);
		seedSelect("scan_pipeline_versions", [
			{
				pipelineVersionId: "version-1",
				pipelineId: "full",
				yaml: "",
				compiledDefinition: {
					root: "discovery",
					stages: [{ id: "discovery" }],
					supportedTargets: ["evaluation"],
				},
			},
		]);
		seedInsert("dataset_evaluations", [
			{
				evaluationId: "evaluation-1",
				datasetId: "ds-1",
				profileId: "profile-1",
				name: "eval",
			},
		]);
		seedInsert("dataset_evaluation_trials", []);

		const result = await callerFor({
			orgId: "org-1",
			role: "owner",
		}).evaluations.create({
			...evaluationInput,
			sampleIds: ["sample-1", "sample-2"],
		});

		expect(result?.name).toBe("eval");
		const inserts = queriesOf("insert");
		const trialsInsert = inserts[1];
		// 2 samples × 2 repetitions = 4 trials, ordered by sample then repetition.
		expect(trialsInsert?.values).toHaveLength(4);
		expect(
			(trialsInsert?.values as Array<{ repetition: number }>)[0],
		).toMatchObject({
			repetition: 1,
		});
		expect(
			(trialsInsert?.values as Array<{ repetition: number }>)[3],
		).toMatchObject({
			repetition: 2,
		});
		expect(mocks.datasetEvaluationQueue.add).toHaveBeenCalledTimes(1);
		expect(mocks.datasetEvaluationQueue.add.mock.calls[0]?.[1]).toMatchObject({
			evaluationId: expect.stringMatching(/^evaluation-/),
		});
	});

	it("freezes the selected pipeline profile and published version", async () => {
		seedSelect("datasets", [datasetRow()]);
		seedSelect("dataset_profiles", [profileRow()]);
		seedSelect("dataset_samples", [
			{ id: "sample-1", profileId: "profile-1", ordinal: 0 },
		]);
		seedSelect("scan_pipelines", [
			{
				pipelineId: "pipeline-1",
				organizationId: "org-1",
				currentPublishedVersionId: "version-1",
				archivedAt: null,
			},
		]);
		seedSelect("scan_pipeline_profiles", [
			{
				pipelineProfileId: "pipeline-profile-1",
				pipelineId: "pipeline-1",
				pipelineVersionId: "version-1",
				organizationId: "org-1",
				settings: {
					stages: { discovery: { concurrency: 8 } },
				},
			},
		]);
		const compiledDefinition = {
			version: 3,
			pipelineId: "pipeline-1",
			name: "Evaluation pipeline",
			supportedTargets: ["evaluation"],
			root: "discovery",
			limits: { maxTasks: 100, maxDurationSeconds: 3600 },
			prepareRepository: "target",
			capabilities: { candidates: true, research: false, tobGoal: false },
			schemas: {},
			stages: [{ id: "discovery" }],
			edges: [],
			groups: [],
		};
		seedSelect("scan_pipeline_versions", [
			{
				pipelineVersionId: "version-1",
				pipelineId: "pipeline-1",
				yaml: "version: 3",
				compiledDefinition,
			},
		]);
		seedInsert("dataset_evaluations", [
			{ evaluationId: "evaluation-1", name: "eval" },
		]);
		seedInsert("dataset_evaluation_trials", []);

		await callerFor({ orgId: "org-1", role: "owner" }).evaluations.create({
			...evaluationInput,
			pipelineId: "pipeline-1",
			pipelineProfileId: "pipeline-profile-1",
		});

		const inserted = firstQueryOn("insert", "dataset_evaluations")?.values;
		expect(inserted).toMatchObject({
			pipelineId: "pipeline-1",
			pipelineProfileId: "pipeline-profile-1",
			pipelineVersionId: "version-1",
			pipelineCompiledSnapshot: compiledDefinition,
			scanRuntimeSettings: {
				stages: { discovery: { concurrency: 8 } },
			},
		});
	});
});

describe("dataset.remove", () => {
	it("rejects when evaluations still reference the dataset", async () => {
		seedSelect("datasets", [datasetRow()]);
		seedSelect("dataset_evaluations", [{ evaluationId: "e-1" }]);

		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).remove({
				datasetId: "ds-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.pruneDatasetProfile).not.toHaveBeenCalled();
	});

	it("prunes profiles and deletes the dataset", async () => {
		seedSelect("datasets", [datasetRow()]);
		seedSelect("dataset_evaluations");
		seedSelect("dataset_profiles", [
			{ profileId: "profile-1" },
			{ profileId: "profile-2" },
		]);
		seedDelete("datasets", [datasetRow()]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).remove({
			datasetId: "ds-1",
		});

		expect(mocks.pruneDatasetProfile).toHaveBeenCalledTimes(2);
		expect(mocks.pruneDatasetProfile).toHaveBeenCalledWith("profile-1");
		expect(mocks.pruneDatasetProfile).toHaveBeenCalledWith("profile-2");
		expect(lastQuery("delete")?.where).toBeTruthy();
		expect(result?.datasetId).toBe("ds-1");
	});

	it("rejects when the dataset belongs to another organization", async () => {
		seedSelect("datasets");

		await expect(
			callerFor({ orgId: "org-2", role: "owner" }).remove({
				datasetId: "ds-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects members", async () => {
		await expect(
			callerFor({ orgId: "org-1", role: "member" }).remove({
				datasetId: "ds-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
