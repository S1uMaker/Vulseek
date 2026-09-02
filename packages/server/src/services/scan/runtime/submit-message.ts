import { randomUUID } from "node:crypto";
import type { ScanJob, Task } from "../types";
import type { CompiledPipelineDefinition } from "../pipeline/document-v3/pipeline-v3-compiler";
import {
	createJsonSchemaContract,
	type JsonSchemaObject,
	validateJsonSchemaContract,
	validateJsonSchemaContractArtifacts,
} from "../pipeline/scan-pipeline-schema-contracts";
import {
	type InsertMessageResult,
	isActiveProducerStatus,
	type MessageRecord,
} from "../persistence/message-store";
import { ScanRuntimeApiError } from "./scan-runtime-api-error";
import {
	parseBearerToken,
	verifyScanRuntimeToken,
} from "./scan-runtime-api-auth";

const ACTIVE_JOB_STATUSES = new Set(["running", "paused"]);

type SnapshotStage = CompiledPipelineDefinition["stages"][number];
type SnapshotEdge = CompiledPipelineDefinition["edges"][number];

const loadCompiledSnapshot = (
	job: Pick<ScanJob, "pipelineCompiledSnapshot">,
): CompiledPipelineDefinition | null => {
	const snapshot = job.pipelineCompiledSnapshot;
	if (!snapshot || typeof snapshot !== "object") {
		return null;
	}
	const compiled = snapshot as CompiledPipelineDefinition;
	if (!Array.isArray(compiled.edges) || !Array.isArray(compiled.stages)) {
		return null;
	}
	return compiled;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const resolveStageRoutes = (
	snapshot: CompiledPipelineDefinition,
	stageName: string,
) => snapshot.edges.filter((edge) => edge.from === stageName && edge.route);

export const resolveSubmitRouteKey = (input: {
	snapshot: CompiledPipelineDefinition;
	stageName: string;
	requestedRouteKey?: string | null;
}) => {
	const routed = resolveStageRoutes(input.snapshot, input.stageName);
	const requested = input.requestedRouteKey?.trim() || null;
	if (routed.length === 0) {
		if (requested) {
			throw new ScanRuntimeApiError(
				400,
				`Stage ${input.stageName} does not accept a route key`,
			);
		}
		return null;
	}
	if (requested) {
		const selected = routed.find((edge) => edge.route?.key === requested);
		if (!selected) {
			throw new ScanRuntimeApiError(
				400,
				`Invalid route key ${requested} for stage ${input.stageName}`,
			);
		}
		return requested;
	}
	const defaultRoute = routed.find((edge) => edge.route?.default);
	if (defaultRoute?.route?.key) {
		return defaultRoute.route.key;
	}
	throw new ScanRuntimeApiError(
		400,
		`Stage ${input.stageName} requires a route key`,
	);
};

const outputSchemaForRoute = (input: {
	snapshot: CompiledPipelineDefinition;
	stage: SnapshotStage;
	routeKey: string | null;
}): JsonSchemaObject | null => {
	if (input.routeKey) {
		const edge = input.snapshot.edges.find(
			(item): item is SnapshotEdge =>
				item.from === input.stage.id && item.route?.key === input.routeKey,
		);
		if (edge?.outputSchema && isRecord(edge.outputSchema)) {
			return edge.outputSchema;
		}
	}
	return isRecord(input.stage.outputSchema) ? input.stage.outputSchema : null;
};

export type SubmitMessageDeps = {
	findTaskById: (taskId: string) => Promise<Task | null>;
	findScanJobById: (
		scanJobId: string,
	) => Promise<
		| (Pick<ScanJob, "scanJobId" | "status" | "pipelineCompiledSnapshot"> &
				Partial<ScanJob>)
		| null
	>;
	insertPending: (input: {
		sourceTaskId: string;
		submissionKey: string;
		routeKey: string | null;
		payload: unknown;
	}) => Promise<InsertMessageResult>;
	readArtifact: (task: Task, containerPath: string) => Promise<unknown>;
	wakeJob: (scanJobId: string) => void;
	reconstructTaskInput?: (task: Task) => Promise<unknown>;
};

const defaultDeps = (): SubmitMessageDeps => ({
	findTaskById: async (taskId) => {
		const { findTaskByIdRepo } = await import("../persistence/task.repo");
		try {
			return await findTaskByIdRepo(taskId);
		} catch {
			return null;
		}
	},
	findScanJobById: async (scanJobId) => {
		const { findScanJobByIdRepo } = await import("../persistence/scan-job.repo");
		try {
			return await findScanJobByIdRepo(scanJobId);
		} catch {
			return null;
		}
	},
	insertPending: async (input) => {
		const { insertPendingMessageRepo } = await import(
			"../persistence/message.repo"
		);
		return insertPendingMessageRepo(input);
	},
	readArtifact: async (task, containerPath) => {
		const { readTaskJsonArtifactForTask } = await import(
			"../persistence/task-artifact-resolver"
		);
		return readTaskJsonArtifactForTask(task, containerPath);
	},
	wakeJob: (scanJobId) => {
		void import("../pipeline/pipeline-runtime-registry").then(
			({ wakePipelineRuntimesForScanJob }) => {
				wakePipelineRuntimesForScanJob(scanJobId);
			},
		);
	},
	reconstructTaskInput: async (task) => {
		const { reconstructTaskInput } = await import("./reconstruct-task-input");
		return reconstructTaskInput(task);
	},
});

export const submitMessage = async (input: {
	scanJobId: string;
	taskId: string;
	output: unknown;
	routeKey?: string | null;
	submissionKey?: string | null;
	deps?: Partial<SubmitMessageDeps>;
}): Promise<
	| {
			ok: true;
			validated: true;
			routeKey: string | null;
	  }
	| {
			ok: true;
			message: MessageRecord;
			idempotent: boolean;
	  }
> => {
	const deps = { ...defaultDeps(), ...input.deps };
	const task = await deps.findTaskById(input.taskId);
	if (!task) {
		throw new ScanRuntimeApiError(404, "Task not found");
	}
	if (task.scanJobId !== input.scanJobId) {
		throw new ScanRuntimeApiError(403, "Task does not belong to scan job");
	}
	if (!isActiveProducerStatus(task.status)) {
		throw new ScanRuntimeApiError(
			409,
			`Task ${task.taskId} is ${task.status} and cannot submit output`,
		);
	}
	const job = await deps.findScanJobById(input.scanJobId);
	if (!job) {
		throw new ScanRuntimeApiError(404, "Scan job not found");
	}
	if (!ACTIVE_JOB_STATUSES.has(job.status)) {
		throw new ScanRuntimeApiError(
			409,
			`Scan job ${job.scanJobId} is ${job.status} and cannot accept outputs`,
		);
	}
	const snapshot = loadCompiledSnapshot(job);
	if (!snapshot) {
		throw new ScanRuntimeApiError(500, "Scan job pipeline snapshot is missing");
	}
	const stage = snapshot.stages.find((item) => item.id === task.stageName);
	if (!stage) {
		throw new ScanRuntimeApiError(
			400,
			`Stage ${task.stageName} is not in the job pipeline snapshot`,
		);
	}
	const routeKey = resolveSubmitRouteKey({
		snapshot,
		stageName: task.stageName,
		requestedRouteKey: input.routeKey,
	});
	if (task.stageName === "hunter" && isRecord(input.output)) {
		try {
			const reconstructed = await deps.reconstructTaskInput?.(task);
			const expectedName =
				isRecord(reconstructed) && typeof reconstructed.name === "string"
					? reconstructed.name.trim()
					: "";
			const submittedName =
				typeof input.output.name === "string" ? input.output.name.trim() : "";
			if (expectedName && submittedName !== expectedName) {
				throw new ScanRuntimeApiError(
					400,
					`Hunter output name ${JSON.stringify(submittedName)} does not match assigned name ${JSON.stringify(expectedName)}`,
				);
			}
		} catch (error) {
			if (error instanceof ScanRuntimeApiError) {
				throw error;
			}
		}
	}
	const schema = outputSchemaForRoute({ snapshot, stage, routeKey });
	if (schema) {
		const contract = createJsonSchemaContract({
			schemas: (snapshot.schemas ?? {}) as Record<string, JsonSchemaObject>,
			schema,
		});
		try {
			validateJsonSchemaContract(contract, input.output);
			await validateJsonSchemaContractArtifacts(
				contract,
				input.output,
				async (containerPath) => deps.readArtifact(task, containerPath),
			);
		} catch (error) {
			throw new ScanRuntimeApiError(
				400,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	const submissionKey = input.submissionKey?.trim() || randomUUID();
	const inserted = await deps.insertPending({
		sourceTaskId: task.taskId,
		submissionKey,
		routeKey,
		payload: input.output,
	});
	if (inserted.kind === "conflict") {
		throw new ScanRuntimeApiError(
			409,
			"submissionKey already used with different output",
		);
	}
	if (inserted.kind === "created") {
		deps.wakeJob(task.scanJobId);
	}
	return {
		ok: true,
		message: inserted.record,
		idempotent: inserted.kind === "idempotent",
	};
};

export const submitMessageForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	output: unknown;
	routeKey?: string | null;
	submissionKey?: string | null;
	deps?: Partial<SubmitMessageDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const scanJobId = input.scanJobId?.trim() || "";
	const taskId = input.taskId?.trim() || "";
	if (!scanJobId || !taskId) {
		throw new ScanRuntimeApiError(400, "scanJobId and taskId are required");
	}
	const token = parseBearerToken(input.authorization);
	const verify = input.verifyToken ?? verifyScanRuntimeToken;
	if (!verify({ scanJobId, token })) {
		throw new ScanRuntimeApiError(401, "Invalid runtime token");
	}
	return submitMessage({
		scanJobId,
		taskId,
		output: input.output,
		routeKey: input.routeKey,
		submissionKey: input.submissionKey,
		deps: input.deps,
	});
};

const readHeaderValue = (
	headers: Record<string, string | string[] | undefined>,
	name: string,
) => {
	const value = headers[name] ?? headers[name.toLowerCase()];
	if (Array.isArray(value)) {
		return value[0] ?? null;
	}
	return value ?? null;
};

export const handleMessagesHttp = async (input: {
	method?: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
	deps?: Partial<SubmitMessageDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}): Promise<{ status: number; body: unknown }> => {
	if (input.method && input.method !== "POST") {
		return { status: 405, body: { ok: false, error: "Method not allowed" } };
	}
	const body =
		input.body && typeof input.body === "object" && !Array.isArray(input.body)
			? (input.body as Record<string, unknown>)
			: {};
	try {
		const result = await submitMessageForRequest({
			authorization: readHeaderValue(input.headers, "authorization"),
			scanJobId: readHeaderValue(input.headers, "x-vulseek-scan-job-id"),
			taskId: readHeaderValue(input.headers, "x-vulseek-task-id"),
			output: "output" in body ? body.output : body,
			routeKey:
				typeof body.routeKey === "string"
					? body.routeKey
					: typeof body.route === "string"
						? body.route
						: null,
			submissionKey:
				typeof body.submissionKey === "string" ? body.submissionKey : null,
			deps: input.deps,
			verifyToken: input.verifyToken,
		});
		if ("message" in result) {
			return { status: result.idempotent ? 200 : 201, body: result };
		}
		return { status: 200, body: result };
	} catch (error) {
		if (error instanceof ScanRuntimeApiError) {
			return {
				status: error.status,
				body: { ok: false, error: error.message },
			};
		}
		return {
			status: 500,
			body: {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}
};
