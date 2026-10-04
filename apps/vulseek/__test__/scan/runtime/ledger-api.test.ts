import type {
	InsertLedgerEntryInput,
	LedgerEntryRow,
} from "@vulseek/server/services/scan/persistence/ledger.repo";
import {
	appendPrimitiveForRequest,
	assignFunctionForRequest,
	ensureFunctionForRequest,
	listLedgerForRequest,
	setFunctionStateForRequest,
	updateLedgerForRequest,
} from "@vulseek/server/services/scan/runtime/ledger";
import { ScanRuntimeApiError } from "@vulseek/server/services/scan/runtime/scan-runtime-api-error";
import { describe, expect, it } from "vitest";

const now = "2026-09-05T00:00:00.000Z";

const scopeJob = {
	scanJobId: "job-1",
	pipelineId: "pipe-1",
	applicationId: "app-1",
	composeId: null as string | null,
	commitSha: "abc123",
};

const makeRow = (overrides: Partial<LedgerEntryRow> = {}): LedgerEntryRow =>
	({
		id: 1,
		organizationId: "org-1",
		applicationId: "app-1",
		composeId: null,
		projectId: "proj-1",
		sourceJobId: "job-1",
		repoId: "app-1",
		snapshotId: "abc123",
		file: "wp-includes/class-wp-query.php",
		functionName: "WP_Query::get_posts",
		line: 2400,
		endLine: 2500,
		state: "discovered",
		primitives: [],
		revision: 1,
		createdBy: "orch-1",
		updatedBy: "orch-1",
		createdAt: now,
		updatedAt: now,
		...overrides,
	}) as LedgerEntryRow;

const baseDeps = (
	store: LedgerEntryRow[],
	taskId = "orch-1",
	stageName: string | null = null,
) => ({
	findTaskById: async () => ({ taskId, scanJobId: "job-1", stageName }),
	findScanJobById: async () => scopeJob,
	findPipelineOrganizationId: async () => "org-1",
	findApplicationProjectId: async () => "proj-1",
	findComposeProjectId: async () => null,
	insert: async (input: InsertLedgerEntryInput) => {
		const row = makeRow({
			...input,
			id: Math.max(0, ...store.map((row) => row.id)) + 1,
		});
		store.push(row);
		return row;
	},
	findById: async (id: number) => store.find((row) => row.id === id) ?? null,
	findByIdentity: async (input: {
		file: string;
		functionName: string;
	}) =>
		store.find(
			(row) =>
				row.file === input.file && row.functionName === input.functionName,
		) ?? null,
	updateCas: async (input: {
		id: number;
		expectedRevision: number;
		patch: Partial<LedgerEntryRow>;
	}) => {
		const index = store.findIndex((row) => row.id === input.id);
		if (index < 0) return null;
		const current = store[index]!;
		if (current.revision !== input.expectedRevision) return null;
		store[index] = {
			...current,
			...input.patch,
			revision: current.revision + 1,
		};
		return store[index]!;
	},
	list: async (input: { state?: string; functionName?: string; file?: string }) =>
		store.filter((row) => {
			if (input.state && row.state !== input.state) return false;
			if (
				input.functionName &&
				!row.functionName.includes(input.functionName)
			) {
				return false;
			}
			if (input.file && !row.file.startsWith(input.file)) return false;
			return true;
		}),
});

const auth = {
	authorization: "Bearer test-token",
	scanJobId: "job-1",
	taskId: "orch-1",
	verifyToken: () => true,
};

describe("function ledger", () => {
	it("ensures a discovered function row and returns the same row again", async () => {
		const store: LedgerEntryRow[] = [];
		const deps = baseDeps(store);
		const created = await ensureFunctionForRequest({
			...auth,
			deps,
			body: {
				file: "wp-includes/class-wp-query.php",
				functionName: "WP_Query::get_posts",
				line: 2400,
				endLine: 2500,
			},
		});
		expect(created.created).toBe(true);
		expect(created.entry.state).toBe("discovered");
		expect(created.entry.primitives).toEqual([]);
		const again = await ensureFunctionForRequest({
			...auth,
			deps,
			body: {
				file: "wp-includes/class-wp-query.php",
				functionName: "WP_Query::get_posts",
				line: 2400,
			},
		});
		expect(again.created).toBe(false);
		expect(again.entry.id).toBe(created.entry.id);
		expect(store).toHaveLength(1);
	});

	it("creates a hunter function row as investigating and leaves an existing row unchanged", async () => {
		const store: LedgerEntryRow[] = [];
		const deps = baseDeps(store, "hunter-1", "hunter");
		const created = await ensureFunctionForRequest({
			...auth,
			taskId: "hunter-1",
			deps,
			body: {
				file: "wp-includes/template.php",
				functionName: "get_page_template",
				line: 480,
			},
		});
		expect(created.created).toBe(true);
		expect(created.entry.state).toBe("investigating");
		store.push(
			makeRow({
				id: 9,
				file: "wp-includes/formatting.php",
				functionName: "wpautop",
				state: "discovered",
			}),
		);
		const existing = await ensureFunctionForRequest({
			...auth,
			taskId: "hunter-1",
			deps,
			body: {
				file: "wp-includes/formatting.php",
				functionName: "wpautop",
				line: 500,
			},
		});
		expect(existing.created).toBe(false);
		expect(existing.entry.state).toBe("discovered");
	});

	it("lets orch assign a discovered function and rejects hunter coverage states", async () => {
		const store = [makeRow()];
		const deps = baseDeps(store);
		const assigned = await assignFunctionForRequest({
			...auth,
			deps,
			id: "1",
			body: { expectedRevision: 1, reason: "dispatch hunter" },
		});
		expect(assigned.entry.state).toBe("assigned");
		await expect(
			setFunctionStateForRequest({
				...auth,
				deps,
				id: "1",
				body: {
					state: "discovered",
					expectedRevision: 2,
					reason: "no",
				},
			}),
		).rejects.toBeInstanceOf(ScanRuntimeApiError);
	});

	it("appends a primitive without changing function coverage", async () => {
		const store = [makeRow({ state: "assigned", revision: 2 })];
		const deps = baseDeps(store, "hunter-1");
		const result = await appendPrimitiveForRequest({
			...auth,
			taskId: "hunter-1",
			deps,
			id: "1",
			body: {
				action: "append-primitive",
				expectedRevision: 2,
				id: "sink-author",
				type: "sink",
				title: "author__not_in interpolation",
				statement: "get_posts concatenates author__not_in into SQL",
				locations: [{ file: "wp-includes/class-wp-query.php", line: 2403 }],
			},
		});
		expect(result.entry.state).toBe("assigned");
		expect(result.primitive.id).toBe("sink-author");
		expect(result.primitive.verdict).toBe("unknown");
		const listed = await listLedgerForRequest({
			...auth,
			deps,
			type: "sink",
		});
		expect(listed.primitives).toHaveLength(1);
	});

	it("updates a primitive and lets a hunter mark the function covered", async () => {
		const store = [makeRow({ state: "investigating" })];
		const deps = baseDeps(store, "hunter-1");
		await appendPrimitiveForRequest({
			...auth,
			taskId: "hunter-1",
			deps,
			id: "1",
			body: {
				expectedRevision: 1,
				id: "sink-author",
				type: "sink",
				title: "author__not_in interpolation",
				statement: "get_posts concatenates author__not_in into SQL",
			},
		});
		const updated = await updateLedgerForRequest({
			...auth,
			taskId: "hunter-1",
			deps,
			id: "1",
			body: {
				action: "update-primitive",
				functionId: 1,
				primitiveId: "sink-author",
				expectedRevision: 2,
				reason: "cite the interpolation",
				operations: [
					{
						op: "append_evidence",
						value: {
							id: "ev-1",
							kind: "code",
							stance: "supports",
							summary: "the query var is concatenated into SQL",
							ref: {
								file: "wp-includes/class-wp-query.php",
								line: 2403,
							},
						},
					},
					{
						op: "set_verdict",
						verdict: "supported",
						assessment: {
							reason: "the cited line interpolates the query var",
							evidenceRefs: [
								{
									functionId: 1,
									primitiveId: "sink-author",
									evidenceId: "ev-1",
								},
							],
							dependencyRefs: [],
						},
					},
				],
			},
		});
		expect(updated.primitive.verdict).toBe("supported");
		const covered = await setFunctionStateForRequest({
			...auth,
			taskId: "hunter-1",
			deps,
			id: "1",
			body: {
				state: "covered",
				expectedRevision: updated.entry.revision,
				reason: "local analysis finished",
			},
		});
		expect(covered.entry.state).toBe("covered");
	});

	it("lets only the critic verify or reopen a covered function", async () => {
		const store = [
			makeRow({
				state: "covered",
				revision: 3,
				primitives: [
					{
						id: "sink-1",
						type: "sink",
						title: "sink",
						statement: "the sink is real",
						state: "covered",
						verdict: "supported",
						assessment: null,
						locations: [],
						context: {},
						evidence: [
							{
								id: "ev-1",
								kind: "code",
								stance: "supports",
								summary: "cited line",
								ref: { file: "wp-includes/class-wp-query.php", line: 1 },
							},
						],
						gaps: [],
						links: [],
					},
				],
			}),
		];
		const hunter = baseDeps(store, "hunter-1");
		await expect(
			setFunctionStateForRequest({
				...auth,
				taskId: "hunter-1",
				deps: hunter,
				id: "1",
				body: {
					state: "verified",
					expectedRevision: 3,
					reason: "hunter cannot verify",
				},
			}),
		).rejects.toBeInstanceOf(ScanRuntimeApiError);
		const critic = {
			...baseDeps(store, "critic-1"),
			findTaskById: async () => ({
				taskId: "critic-1",
				scanJobId: "job-1",
				stageName: "critic",
			}),
		};
		const verified = await setFunctionStateForRequest({
			...auth,
			taskId: "critic-1",
			deps: critic,
			id: "1",
			body: {
				state: "verified",
				expectedRevision: 3,
				reason: "review passed",
			},
		});
		expect(verified.entry.state).toBe("verified");
		store[0] = { ...store[0]!, state: "covered", revision: verified.entry.revision };
		const reopened = await setFunctionStateForRequest({
			...auth,
			taskId: "critic-1",
			deps: critic,
			id: "1",
			body: {
				state: "investigating",
				expectedRevision: store[0]!.revision,
				reason: "coverage was incomplete",
			},
		});
		expect(reopened.entry.state).toBe("investigating");
	});
});
