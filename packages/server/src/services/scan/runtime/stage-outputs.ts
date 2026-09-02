import type { ScanJob } from "../types";
import type { CompiledPipelineDefinition } from "../pipeline/document-v3/pipeline-v3-compiler";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import { findTaskByIdRepo } from "../persistence/task.repo";
import { listMessagesByScanJobAndStageRepo } from "../persistence/message.repo";
import {
	parseBearerToken,
	verifyScanRuntimeToken,
} from "./scan-runtime-api-auth";
import {
	collectDownstreamStageNames,
	ScanRuntimeApiError,
} from "./downstream-capacity";

export type StageOutputItem = {
	taskId: string;
	taskStatus: string;
	name: string;
	messageId: string;
	sequence: number;
	dispatchStatus: string;
	output: unknown;
	createdAt: string;
};

export type StageOutputsResult = {
	ok: true;
	scanJobId: string;
	currentStage: string;
	stageName: string;
	generatedAt: string;
	outputs: StageOutputItem[];
};

type StageOutputsDeps = {
	findTaskById: (taskId: string) => Promise<{
		taskId: string;
		scanJobId: string;
		stageName: string;
	} | null>;
	findScanJobById: (
		scanJobId: string,
	) => Promise<Pick<ScanJob, "scanJobId" | "pipelineCompiledSnapshot"> | null>;
	listOutputs: (input: {
		scanJobId: string;
		stageName: string;
		status?: "completed";
	}) => Promise<StageOutputItem[]>;
	now: () => string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const outputName = (output: unknown, taskName: string) => {
	if (isRecord(output) && typeof output.name === "string") {
		const trimmed = output.name.trim();
		if (trimmed) return trimmed;
	}
	return taskName;
};

const defaultDeps: StageOutputsDeps = {
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
			return await findScanJobByIdRepo(scanJobId);
		} catch {
			return null;
		}
	},
	listOutputs: async (input) => {
		const rows = await listMessagesByScanJobAndStageRepo(input);
		return rows.map((row) => ({
			taskId: row.taskId,
			taskStatus: row.taskStatus,
			name: outputName(row.output, row.taskName),
			messageId: row.messageId,
			sequence: row.sequence,
			dispatchStatus: row.status,
			output: row.output,
			createdAt: row.createdAt,
		}));
	},
	now: () => new Date().toISOString(),
};

const loadCompiledSnapshot = (
	job: Pick<ScanJob, "pipelineCompiledSnapshot">,
): CompiledPipelineDefinition | null => {
	const snapshot = job.pipelineCompiledSnapshot;
	if (!snapshot || typeof snapshot !== "object") {
		return null;
	}
	const compiled = snapshot as CompiledPipelineDefinition;
	if (!Array.isArray(compiled.stages) || !Array.isArray(compiled.edges)) {
		return null;
	}
	return compiled;
};

export const queryStageOutputs = async (input: {
	scanJobId: string;
	taskId: string;
	stageName: string;
	deps?: Partial<StageOutputsDeps>;
}): Promise<StageOutputsResult> => {
	const stageName = input.stageName.trim();
	if (!stageName) {
		throw new ScanRuntimeApiError(400, "stage is required");
	}
	const deps = { ...defaultDeps, ...input.deps };
	const task = await deps.findTaskById(input.taskId);
	if (!task) {
		throw new ScanRuntimeApiError(404, "Task not found");
	}
	if (task.scanJobId !== input.scanJobId) {
		throw new ScanRuntimeApiError(403, "Task does not belong to scan job");
	}
	const scanJob = await deps.findScanJobById(input.scanJobId);
	if (!scanJob) {
		throw new ScanRuntimeApiError(404, "Scan job not found");
	}
	const snapshot = loadCompiledSnapshot(scanJob);
	if (!snapshot) {
		throw new ScanRuntimeApiError(
			500,
			"Scan job has no compiled pipeline snapshot",
		);
	}
	if (!snapshot.stages.some((stage) => stage.id === stageName)) {
		throw new ScanRuntimeApiError(
			404,
			`Stage ${stageName} is not defined in the scan job pipeline`,
		);
	}
	const allowed = collectDownstreamStageNames(snapshot.edges, task.stageName);
	if (!allowed.includes(stageName)) {
		throw new ScanRuntimeApiError(
			403,
			`Stage ${stageName} is not a downstream stage of ${task.stageName}`,
		);
	}

	return {
		ok: true,
		scanJobId: input.scanJobId,
		currentStage: task.stageName,
		stageName,
		generatedAt: deps.now(),
		outputs: await deps.listOutputs({
			scanJobId: input.scanJobId,
			stageName,
			status: "completed",
		}),
	};
};

export const queryStageOutputsForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	stageName: string | null | undefined;
	deps?: Partial<StageOutputsDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const scanJobId = input.scanJobId?.trim() || "";
	const taskId = input.taskId?.trim() || "";
	const stageName = input.stageName?.trim() || "";
	if (!scanJobId || !taskId || !stageName) {
		throw new ScanRuntimeApiError(
			400,
			"scanJobId, taskId, and stage are required",
		);
	}
	const token = parseBearerToken(input.authorization);
	const verify = input.verifyToken ?? verifyScanRuntimeToken;
	if (!verify({ scanJobId, token })) {
		throw new ScanRuntimeApiError(401, "Invalid runtime token");
	}
	return queryStageOutputs({
		scanJobId,
		taskId,
		stageName,
		deps: input.deps,
	});
};
