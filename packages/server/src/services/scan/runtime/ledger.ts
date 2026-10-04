import {
	FUNCTION_COVERAGE_STATES,
	LEDGER_ENTRY_TYPES,
	LEDGER_VERDICTS,
	type FunctionCoverageState,
	type LedgerPrimitive,
} from "../../../db/schema/ledger-json";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import {
	type CasLedgerEntryPatch,
	findLedgerEntryByIdRepo,
	findLedgerFunctionByIdentityRepo,
	findPipelineOrganizationIdRepo,
	type InsertLedgerEntryInput,
	insertLedgerEntryRepo,
	type LedgerEntryRow,
	type LedgerScope,
	listLedgerEntriesRepo,
	updateLedgerEntryCasRepo,
} from "../persistence/ledger.repo";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import { findTaskByIdRepo } from "../persistence/task.repo";
import {
	applyLedgerOperations,
	assertAssumptions,
	assertLedgerState,
	type LedgerEntryState,
	normalizeCreatedGaps,
} from "./ledger-operations";
import {
	ensureFunctionSchema,
	ledgerEntryIdQuerySchema,
	primitiveDraftSchema,
	setFunctionStateSchema,
	updateLedgerRequestSchema,
} from "./ledger-schema";
import {
	parseBearerToken,
	verifyScanRuntimeToken,
} from "./scan-runtime-api-auth";
import { ScanRuntimeApiError } from "./scan-runtime-api-error";

export type LedgerPublicEntry = {
	id: number;
	repoId: string;
	snapshotId: string;
	file: string;
	functionName: string;
	line: number;
	endLine?: number;
	state: FunctionCoverageState;
	primitives: LedgerPrimitive[];
	revision: number;
	sourceJobId: string;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
};

const HUNTER_FUNCTION_TRANSITIONS: Record<
	FunctionCoverageState,
	readonly FunctionCoverageState[]
> = {
	discovered: [],
	assigned: ["investigating", "blocked"],
	investigating: ["partial", "covered", "blocked"],
	partial: ["investigating", "covered", "blocked"],
	covered: ["investigating"],
	verified: ["investigating"],
	blocked: ["investigating"],
};

const openGap = (primitive: LedgerPrimitive) =>
	primitive.gaps.some(
		(gap) => gap.status === "open" || gap.status === "investigating",
	);

const hasCodeEvidence = (primitive: LedgerPrimitive) =>
	primitive.evidence.some(
		(item) => item.kind === "code" && !item.withdrawn,
	);

type LedgerDeps = {
	findTaskById: (taskId: string) => Promise<{
		taskId: string;
		scanJobId: string;
		stageName?: string | null;
	} | null>;
	findScanJobById: (scanJobId: string) => Promise<{
		scanJobId: string;
		pipelineId: string;
		applicationId: string | null;
		composeId: string | null;
		commitSha: string | null;
	} | null>;
	findPipelineOrganizationId: (pipelineId: string) => Promise<string | null>;
	findApplicationProjectId: (applicationId: string) => Promise<string | null>;
	findComposeProjectId: (composeId: string) => Promise<string | null>;
	insert: (input: InsertLedgerEntryInput) => Promise<LedgerEntryRow>;
	findById: (id: number) => Promise<LedgerEntryRow | null>;
	updateCas: (input: {
		id: number;
		expectedRevision: number;
		patch: CasLedgerEntryPatch;
	}) => Promise<LedgerEntryRow | null>;
	list: typeof listLedgerEntriesRepo;
	findByIdentity: typeof findLedgerFunctionByIdentityRepo;
};

const defaultDeps: LedgerDeps = {
	findTaskById: async (taskId) => {
		try {
			const task = await findTaskByIdRepo(taskId);
			return {
				taskId: task.taskId,
				scanJobId: task.scanJobId,
				stageName: task.stageName,
			};
		} catch {
			return null;
		}
	},
	findScanJobById: async (scanJobId) => {
		try {
			const job = await findScanJobByIdRepo(scanJobId);
			return {
				scanJobId: job.scanJobId,
				pipelineId: job.pipelineId,
				applicationId: job.applicationId,
				composeId: job.composeId,
				commitSha: job.commitSha,
			};
		} catch {
			return null;
		}
	},
	findPipelineOrganizationId: findPipelineOrganizationIdRepo,
	findApplicationProjectId: async (applicationId) => {
		try {
			const application = await findApplicationById(applicationId);
			return application.environment.project.projectId;
		} catch {
			return null;
		}
	},
	findComposeProjectId: async (composeId) => {
		try {
			const composeRow = await findComposeById(composeId);
			return composeRow.environment.project.projectId;
		} catch {
			return null;
		}
	},
	insert: insertLedgerEntryRepo,
	findById: findLedgerEntryByIdRepo,
	updateCas: updateLedgerEntryCasRepo,
	list: listLedgerEntriesRepo,
	findByIdentity: findLedgerFunctionByIdentityRepo,
};

const authenticate = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	deps: LedgerDeps;
	verifyToken: typeof verifyScanRuntimeToken;
}) => {
	const scanJobId = input.scanJobId?.trim() || "";
	const taskId = input.taskId?.trim() || "";
	if (!scanJobId || !taskId) {
		throw new ScanRuntimeApiError(400, "scanJobId and taskId are required", {
			code: "VALIDATION_ERROR",
		});
	}
	const token = parseBearerToken(input.authorization);
	if (!input.verifyToken({ scanJobId, token })) {
		throw new ScanRuntimeApiError(401, "Invalid runtime token");
	}
	const task = await input.deps.findTaskById(taskId);
	if (!task) {
		throw new ScanRuntimeApiError(404, "Task not found");
	}
	if (task.scanJobId !== scanJobId) {
		throw new ScanRuntimeApiError(403, "Task does not belong to scan job");
	}
	const job = await input.deps.findScanJobById(scanJobId);
	if (!job) {
		throw new ScanRuntimeApiError(404, "Scan job not found");
	}
	const organizationId = await input.deps.findPipelineOrganizationId(
		job.pipelineId,
	);
	if (!organizationId) {
		throw new ScanRuntimeApiError(500, "Scan job pipeline has no organization");
	}
	if (!job.applicationId && !job.composeId) {
		throw new ScanRuntimeApiError(
			400,
			"Scan job has no application or compose target",
			{ code: "VALIDATION_ERROR" },
		);
	}
	const projectId = job.applicationId
		? await input.deps.findApplicationProjectId(job.applicationId)
		: job.composeId
			? await input.deps.findComposeProjectId(job.composeId)
			: null;
	const repoId = job.applicationId ?? job.composeId ?? scanJobId;
	const snapshotId = job.commitSha?.trim() ? job.commitSha : `job:${scanJobId}`;
	const scope: LedgerScope = {
		organizationId,
		applicationId: job.applicationId,
		composeId: job.composeId,
		projectId,
		repoId,
		snapshotId,
	};
	return { scanJobId, taskId, stageName: task.stageName ?? null, scope };
};

const inScope = (row: LedgerEntryRow, scope: LedgerScope) => {
	if (row.organizationId !== scope.organizationId) {
		return false;
	}
	if (scope.applicationId) {
		return row.applicationId === scope.applicationId;
	}
	return row.composeId === scope.composeId;
};

const toPublic = (row: LedgerEntryRow): LedgerPublicEntry => ({
	id: row.id,
	repoId: row.repoId,
	snapshotId: row.snapshotId,
	file: row.file,
	functionName: row.functionName,
	line: row.line,
	...(row.endLine != null ? { endLine: row.endLine } : {}),
	state: row.state,
	primitives: row.primitives ?? [],
	revision: row.revision,
	sourceJobId: row.sourceJobId,
	createdBy: row.createdBy,
	updatedBy: row.updatedBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const primitiveState = (
	row: LedgerEntryRow,
	primitive: LedgerPrimitive,
): LedgerEntryState => {
	const { id, ...rest } = primitive;
	return {
		...rest,
		functionId: row.id,
		primitiveId: id,
		repoId: row.repoId,
		snapshotId: row.snapshotId,
		revision: row.revision,
	};
};

const parseEntryIdQuery = (id: string) => {
	const parsed = ledgerEntryIdQuerySchema.safeParse(id);
	if (!parsed.success) {
		throw new ScanRuntimeApiError(
			400,
			"Ledger entry id must be a positive integer; list ledger entries to obtain current IDs",
			{
				code: "VALIDATION_ERROR",
			},
		);
	}
	return parsed.data;
};

const loadFunction = async (
	deps: LedgerDeps,
	scope: LedgerScope,
	id: number,
) => {
	const row = await deps.findById(id);
	if (!row || !inScope(row, scope)) {
		throw new ScanRuntimeApiError(404, "Ledger function not found");
	}
	return row;
};

const resolvePrimitive = async (
	deps: LedgerDeps,
	scope: LedgerScope,
	ref: { functionId: number; primitiveId: string },
) => {
	const row = await deps.findById(ref.functionId);
	if (!row || !inScope(row, scope)) {
		return null;
	}
	const primitive = (row.primitives ?? []).find(
		(item) => item.id === ref.primitiveId,
	);
	return primitive ? primitiveState(row, primitive) : null;
};

export const listLedgerForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	id?: string | null;
	primitiveId?: string | null;
	type?: string | null;
	verdict?: string | null;
	state?: string | null;
	title?: string | null;
	functionName?: string | null;
	file?: string | null;
	unlinkedSinks?: boolean;
	includeOtherSnapshots?: boolean;
	deps?: Partial<LedgerDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const deps = { ...defaultDeps, ...input.deps };
	const auth = await authenticate({
		...input,
		deps,
		verifyToken: input.verifyToken ?? verifyScanRuntimeToken,
	});
	if (input.id != null) {
		const row = await loadFunction(deps, auth.scope, parseEntryIdQuery(input.id));
		if (input.primitiveId) {
			const primitive = (row.primitives ?? []).find(
				(item) => item.id === input.primitiveId,
			);
			if (!primitive) {
				throw new ScanRuntimeApiError(404, "Ledger primitive not found");
			}
			return {
				ok: true as const,
				function: toPublic(row),
				primitive,
			};
		}
		return { ok: true as const, entry: toPublic(row) };
	}
	const type = input.type?.trim();
	const verdict = input.verdict?.trim();
	const state = input.state?.trim();
	if (type && !LEDGER_ENTRY_TYPES.includes(type as (typeof LEDGER_ENTRY_TYPES)[number])) {
		throw new ScanRuntimeApiError(400, "Invalid type", {
			code: "VALIDATION_ERROR",
		});
	}
	if (verdict && !LEDGER_VERDICTS.includes(verdict as (typeof LEDGER_VERDICTS)[number])) {
		throw new ScanRuntimeApiError(400, "Invalid verdict", {
			code: "VALIDATION_ERROR",
		});
	}
	if (
		state &&
		!FUNCTION_COVERAGE_STATES.includes(state as FunctionCoverageState)
	) {
		throw new ScanRuntimeApiError(400, "Invalid state", {
			code: "VALIDATION_ERROR",
		});
	}
	let rows = await deps.list({
		scope: auth.scope,
		snapshotId: auth.scope.snapshotId,
		includeOtherSnapshots: Boolean(input.includeOtherSnapshots),
		state: state as FunctionCoverageState | undefined,
		functionName: input.functionName?.trim() || undefined,
		file: input.file?.trim() || undefined,
	});
	if (type || verdict || input.title?.trim() || input.unlinkedSinks) {
		const title = input.title?.trim().toLowerCase();
		const linked = new Set<string>();
		if (input.unlinkedSinks) {
			for (const row of rows) {
				for (const primitive of row.primitives ?? []) {
					for (const link of primitive.links) {
						if (
							link.relation === "depends_on" ||
							link.relation === "supports"
						) {
							linked.add(
								`${link.targetFunctionId}/${link.targetPrimitiveId ?? ""}`,
							);
						}
					}
				}
			}
		}
		const primitives = rows.flatMap((row) =>
			(row.primitives ?? [])
				.filter((primitive) => {
					if (type && primitive.type !== type) return false;
					if (verdict && primitive.verdict !== verdict) return false;
					if (title && !primitive.title.toLowerCase().includes(title)) {
						return false;
					}
					if (input.unlinkedSinks) {
						if (primitive.type !== "sink") return false;
						if (
							linked.has(`${row.id}/${primitive.id}`) ||
							linked.has(`${row.id}/`)
						) {
							return false;
						}
					}
					return true;
				})
				.map((primitive) => ({
					functionId: row.id,
					file: row.file,
					functionName: row.functionName,
					functionState: row.state,
					revision: row.revision,
					primitive,
				})),
		);
		return { ok: true as const, primitives };
	}
	return {
		ok: true as const,
		entries: rows.map(toPublic),
	};
};

const authDeps = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	deps?: Partial<LedgerDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const deps = { ...defaultDeps, ...input.deps };
	const auth = await authenticate({
		...input,
		deps,
		verifyToken: input.verifyToken ?? verifyScanRuntimeToken,
	});
	return { deps, auth };
};

export const ensureFunctionForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	body: unknown;
	deps?: Partial<LedgerDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const { deps, auth } = await authDeps(input);
	const rawBody =
		typeof input.body === "object" && input.body
			? { ...(input.body as Record<string, unknown>) }
			: {};
	delete rawBody.action;
	const parsed = ensureFunctionSchema.safeParse(rawBody);
	if (!parsed.success) {
		throw new ScanRuntimeApiError(400, "Invalid ensure-function request", {
			code: "VALIDATION_ERROR",
		});
	}
	const existing = await deps.findByIdentity({
		organizationId: auth.scope.organizationId,
		repoId: auth.scope.repoId,
		snapshotId: auth.scope.snapshotId,
		file: parsed.data.file,
		functionName: parsed.data.functionName,
	});
	if (existing && inScope(existing, auth.scope)) {
		return { ok: true as const, entry: toPublic(existing), created: false };
	}
	const row = await deps.insert({
		organizationId: auth.scope.organizationId,
		applicationId: auth.scope.applicationId,
		composeId: auth.scope.composeId,
		projectId: auth.scope.projectId,
		sourceJobId: auth.scanJobId,
		repoId: auth.scope.repoId,
		snapshotId: auth.scope.snapshotId,
		file: parsed.data.file,
		functionName: parsed.data.functionName,
		line: parsed.data.line,
		endLine: parsed.data.endLine ?? null,
		state: auth.stageName === "hunter" ? "investigating" : "discovered",
		primitives: [],
		revision: 1,
		createdBy: auth.taskId,
		updatedBy: auth.taskId,
	});
	return { ok: true as const, entry: toPublic(row), created: true };
};

export const assignFunctionForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	id?: string | null;
	body: unknown;
	deps?: Partial<LedgerDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const { deps, auth } = await authDeps(input);
	const parsed = setFunctionStateSchema.safeParse({
		...(typeof input.body === "object" && input.body ? input.body : {}),
		state: "assigned",
	});
	if (!parsed.success || input.id == null) {
		throw new ScanRuntimeApiError(400, "Invalid assign-function request", {
			code: "VALIDATION_ERROR",
		});
	}
	const id = parseEntryIdQuery(input.id);
	const existing = await loadFunction(deps, auth.scope, id);
	if (existing.revision !== parsed.data.expectedRevision) {
		throw new ScanRuntimeApiError(409, "Ledger function revision conflict", {
			code: "REVISION_CONFLICT",
			current: toPublic(existing),
		});
	}
	if (auth.stageName === "hunter" || auth.stageName === "critic") {
		throw new ScanRuntimeApiError(
			400,
			"Only the orchestrator can assign a function",
			{ code: "VALIDATION_ERROR" },
		);
	}
	if (existing.state !== "discovered") {
		throw new ScanRuntimeApiError(
			400,
			`invalid function state transition: ${existing.state} -> assigned`,
			{ code: "VALIDATION_ERROR", current: toPublic(existing) },
		);
	}
	const at = new Date().toISOString();
	const row = await deps.updateCas({
		id,
		expectedRevision: existing.revision,
		patch: {
			state: "assigned",
			updatedBy: auth.taskId,
			updatedAt: at,
		},
	});
	if (!row) {
		throw new ScanRuntimeApiError(409, "Ledger function revision conflict", {
			code: "REVISION_CONFLICT",
		});
	}
	return { ok: true as const, entry: toPublic(row) };
};

export const setFunctionStateForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	id?: string | null;
	body: unknown;
	deps?: Partial<LedgerDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const { deps, auth } = await authDeps(input);
	const parsed = setFunctionStateSchema.safeParse(input.body);
	if (!parsed.success || input.id == null) {
		throw new ScanRuntimeApiError(400, "Invalid set-function-state request", {
			code: "VALIDATION_ERROR",
		});
	}
	if (parsed.data.state === "discovered" || parsed.data.state === "assigned") {
		throw new ScanRuntimeApiError(
			400,
			"Hunters cannot set discovered or assigned",
			{ code: "VALIDATION_ERROR" },
		);
	}
	const id = parseEntryIdQuery(input.id);
	const existing = await loadFunction(deps, auth.scope, id);
	if (existing.revision !== parsed.data.expectedRevision) {
		throw new ScanRuntimeApiError(409, "Ledger function revision conflict", {
			code: "REVISION_CONFLICT",
			current: toPublic(existing),
		});
	}
	const stage = auth.stageName;
	const next = parsed.data.state;
	if (stage === "critic") {
		const criticAllowed =
			(existing.state === "covered" &&
				(next === "verified" || next === "investigating")) ||
			existing.state === next;
		if (!criticAllowed) {
			throw new ScanRuntimeApiError(
				400,
				`critic can only move covered to verified or investigating (got ${existing.state} -> ${next})`,
				{ code: "VALIDATION_ERROR" },
			);
		}
	} else if (next === "verified") {
		throw new ScanRuntimeApiError(
			400,
			"Only the critic stage can mark a function verified",
			{ code: "VALIDATION_ERROR" },
		);
	}
	const allowed = HUNTER_FUNCTION_TRANSITIONS[existing.state] ?? [];
	if (
		stage !== "critic" &&
		existing.state !== next &&
		!allowed.includes(next)
	) {
		throw new ScanRuntimeApiError(
			400,
			`invalid function state transition: ${existing.state} -> ${parsed.data.state}`,
			{ code: "VALIDATION_ERROR" },
		);
	}
	if (
		(parsed.data.state === "covered" || parsed.data.state === "verified") &&
		(existing.primitives ?? []).some(openGap)
	) {
		throw new ScanRuntimeApiError(
			400,
			"covered or verified requires no open or investigating primitive gaps",
			{ code: "VALIDATION_ERROR" },
		);
	}
	if (
		(parsed.data.state === "covered" || parsed.data.state === "verified") &&
		!(existing.primitives ?? []).some(hasCodeEvidence)
	) {
		throw new ScanRuntimeApiError(
			400,
			"covered or verified requires code evidence on a primitive",
			{ code: "VALIDATION_ERROR" },
		);
	}
	const at = new Date().toISOString();
	const row = await deps.updateCas({
		id,
		expectedRevision: existing.revision,
		patch: {
			state: parsed.data.state,
			updatedBy: auth.taskId,
			updatedAt: at,
		},
	});
	if (!row) {
		throw new ScanRuntimeApiError(409, "Ledger function revision conflict", {
			code: "REVISION_CONFLICT",
		});
	}
	return { ok: true as const, entry: toPublic(row) };
};

export const appendPrimitiveForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	id?: string | null;
	body: unknown;
	deps?: Partial<LedgerDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const { deps, auth } = await authDeps(input);
	const raw =
		typeof input.body === "object" && input.body
			? (input.body as { expectedRevision?: unknown })
			: {};
	const { expectedRevision: rawRevision, action: _action, ...draftBody } =
		raw as {
			expectedRevision?: unknown;
			action?: unknown;
		} & Record<string, unknown>;
	const parsed = primitiveDraftSchema.safeParse(draftBody);
	if (!parsed.success || input.id == null) {
		throw new ScanRuntimeApiError(400, "Invalid append-primitive request", {
			code: "VALIDATION_ERROR",
		});
	}
	const id = parseEntryIdQuery(input.id);
	const existing = await loadFunction(deps, auth.scope, id);
	const revisionHeader = Number(rawRevision);
	if (!Number.isInteger(revisionHeader) || existing.revision !== revisionHeader) {
		throw new ScanRuntimeApiError(409, "Ledger function revision conflict", {
			code: "REVISION_CONFLICT",
			current: toPublic(existing),
		});
	}
	if ((existing.primitives ?? []).some((item) => item.id === parsed.data.id)) {
		throw new ScanRuntimeApiError(
			409,
			`primitive id "${parsed.data.id}" already exists`,
			{ code: "ID_CONFLICT", current: toPublic(existing) },
		);
	}
	const primitive: LedgerPrimitive = {
		id: parsed.data.id,
		type: parsed.data.type,
		title: parsed.data.title,
		statement: parsed.data.statement,
		state: "discovered",
		verdict: "unknown",
		assessment: null,
		locations: parsed.data.locations ?? [],
		context: parsed.data.context ?? {},
		evidence: [],
		gaps: normalizeCreatedGaps(parsed.data.gaps),
		links: [],
	};
	assertAssumptions(primitive);
	const at = new Date().toISOString();
	const row = await deps.updateCas({
		id,
		expectedRevision: existing.revision,
		patch: {
			primitives: [...(existing.primitives ?? []), primitive],
			updatedBy: auth.taskId,
			updatedAt: at,
		},
	});
	if (!row) {
		throw new ScanRuntimeApiError(409, "Ledger function revision conflict", {
			code: "REVISION_CONFLICT",
		});
	}
	return { ok: true as const, entry: toPublic(row), primitive };
};

export const updateLedgerForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	id?: string | null;
	body: unknown;
	deps?: Partial<LedgerDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const deps = { ...defaultDeps, ...input.deps };
	const auth = await authenticate({
		...input,
		deps,
		verifyToken: input.verifyToken ?? verifyScanRuntimeToken,
	});
	const parsed = updateLedgerRequestSchema.safeParse(input.body);
	if (!parsed.success) {
		throw new ScanRuntimeApiError(400, "Invalid ledger update request", {
			code: "VALIDATION_ERROR",
		});
	}
	const queryId = input.id == null ? undefined : parseEntryIdQuery(input.id);
	const functionId = parsed.data.functionId;
	if (queryId !== undefined && queryId !== functionId) {
		throw new ScanRuntimeApiError(400, "Conflicting ledger function ids", {
			code: "VALIDATION_ERROR",
		});
	}
	const existing = await loadFunction(deps, auth.scope, functionId);
	if (existing.revision !== parsed.data.expectedRevision) {
		throw new ScanRuntimeApiError(409, "Ledger function revision conflict", {
			code: "REVISION_CONFLICT",
			current: toPublic(existing),
		});
	}
	const currentPrimitive = (existing.primitives ?? []).find(
		(item) => item.id === parsed.data.primitiveId,
	);
	if (!currentPrimitive) {
		throw new ScanRuntimeApiError(404, "Ledger primitive not found");
	}
	const at = new Date().toISOString();
	const next = await applyLedgerOperations({
		current: primitiveState(existing, currentPrimitive),
		operations: parsed.data.operations,
		actor: auth.taskId,
		at,
		reason: parsed.data.reason,
		nextRevision: parsed.data.expectedRevision + 1,
		resolveEntry: (ref) => resolvePrimitive(deps, auth.scope, ref),
	});
	const {
		functionId: _functionId,
		primitiveId,
		repoId: _repoId,
		snapshotId: _snapshotId,
		revision: _revision,
		...rest
	} = next;
	const primitive = { ...rest, id: primitiveId };
	const primitives = (existing.primitives ?? []).map((item) =>
		item.id === primitive.id ? primitive : item,
	);
	const row = await deps.updateCas({
		id: functionId,
		expectedRevision: parsed.data.expectedRevision,
		patch: {
			primitives,
			updatedBy: auth.taskId,
			updatedAt: at,
		},
	});
	if (!row) {
		const current = await deps.findById(functionId);
		throw new ScanRuntimeApiError(409, "Ledger function revision conflict", {
			code: "REVISION_CONFLICT",
			current:
				current && inScope(current, auth.scope) ? toPublic(current) : null,
		});
	}
	return { ok: true as const, entry: toPublic(row), primitive };
};
