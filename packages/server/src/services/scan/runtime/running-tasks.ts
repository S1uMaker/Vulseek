import type { ScanJob } from "../types";
import type { CompiledPipelineDefinition } from "../pipeline/document-v3/pipeline-v3-compiler";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import {
	findTaskByIdRepo,
	listRunningTaskViewsByScanJobAndStageRepo,
} from "../persistence/task.repo";
import {
	parseBearerToken,
	verifyScanRuntimeToken,
} from "./scan-runtime-api-auth";
import { ScanRuntimeApiError } from "./downstream-capacity";

export type RunningStageTask = {
	taskId: string;
	stageName: string;
	title: string;
	status: "launching" | "launched" | "starting" | "running";
	startedAt: string | null;
	updatedAt: string;
};

export type RunningTasksResult = {
	ok: true;
	scanJobId: string;
	currentStage: string;
	stageName: string;
	generatedAt: string;
	tasks: RunningStageTask[];
};

type RunningTasksDeps = {
	findTaskById: (taskId: string) => Promise<{
		taskId: string;
		scanJobId: string;
		stageName: string;
	} | null>;
	findScanJobById: (
		scanJobId: string,
	) => Promise<Pick<ScanJob, "scanJobId" | "pipelineCompiledSnapshot"> | null>;
	listRunningTasks: (input: {
		scanJobId: string;
		stageName: string;
	}) => Promise<RunningStageTask[]>;
	now: () => string;
};

const defaultDeps: RunningTasksDeps = {
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
	listRunningTasks: async (input) =>
		listRunningTaskViewsByScanJobAndStageRepo(input),
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
	if (!Array.isArray(compiled.stages)) {
		return null;
	}
	return compiled;
};

export const queryRunningTasks = async (input: {
	scanJobId: string;
	taskId: string;
	stageName: string;
	deps?: Partial<RunningTasksDeps>;
}): Promise<RunningTasksResult> => {
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

	return {
		ok: true,
		scanJobId: input.scanJobId,
		currentStage: task.stageName,
		stageName,
		generatedAt: deps.now(),
		tasks: await deps.listRunningTasks({
			scanJobId: input.scanJobId,
			stageName,
		}),
	};
};

export const queryRunningTasksForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	stageName: string | null | undefined;
	deps?: Partial<RunningTasksDeps>;
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
	return queryRunningTasks({
		scanJobId,
		taskId,
		stageName,
		deps: input.deps,
	});
};
