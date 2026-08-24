import type { ScanJob } from "../types";
import type { CompiledPipelineDefinition } from "../pipeline/document-v3/pipeline-v3-compiler";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import {
	countActiveTasksByScanJobAndStageRepo,
	findTaskByIdRepo,
} from "../persistence/task.repo";
import {
	isFullScanStageActive,
	resolveStageConcurrencySetting,
} from "../stages/full-scan-stage.runtime";
import {
	parseBearerToken,
	verifyScanRuntimeToken,
} from "./scan-runtime-api-auth";

export class ScanRuntimeApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ScanRuntimeApiError";
		this.status = status;
	}
}

export type DownstreamCapacityStage = {
	stageName: string;
	concurrency: number;
	activeTasks: number;
	availableSlots: number;
};

export type DownstreamCapacityResult = {
	ok: true;
	scanJobId: string;
	currentStage: string;
	generatedAt: string;
	stages: DownstreamCapacityStage[];
};

export const collectDownstreamStageNames = (
	edges: Array<{ from?: string | null; to?: string | null }>,
	fromStage: string,
) => {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const edge of edges) {
		if (edge.from !== fromStage || !edge.to || seen.has(edge.to)) {
			continue;
		}
		seen.add(edge.to);
		names.push(edge.to);
	}
	return names;
};

export const computeAvailableSlots = (concurrency: number, activeTasks: number) =>
	Math.max(0, concurrency - activeTasks);

const asPositiveInt = (value: unknown, fallback: number) => {
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric) || numeric < 0) {
		return fallback;
	}
	return Math.floor(numeric);
};

const yamlConcurrencyForStage = (
	snapshot: CompiledPipelineDefinition | null,
	stageName: string,
) => {
	const stage = snapshot?.stages?.find((item) => item.id === stageName);
	return asPositiveInt(stage?.concurrency, 1) || 1;
};

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

export type DownstreamCapacityDeps = {
	findTaskById: (taskId: string) => Promise<{
		taskId: string;
		scanJobId: string;
		stageName: string;
	} | null>;
	findScanJobById: (
		scanJobId: string,
	) => Promise<Pick<ScanJob, "scanJobId" | "pipelineCompiledSnapshot"> | null>;
	resolveConcurrency: (
		scanJobId: string,
		stageName: string,
		fallback: number,
	) => Promise<number>;
	countActiveTasks: (scanJobId: string, stageName: string) => Promise<number>;
	isStageActive: (scanJobId: string, stageName: string) => Promise<boolean>;
	now: () => string;
};

const defaultDeps: DownstreamCapacityDeps = {
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
	resolveConcurrency: (scanJobId, stageName, fallback) =>
		resolveStageConcurrencySetting(scanJobId, stageName, () => fallback),
	countActiveTasks: async (scanJobId, stageName) =>
		asPositiveInt(
			await countActiveTasksByScanJobAndStageRepo({ scanJobId, stageName }),
			0,
		),
	isStageActive: isFullScanStageActive,
	now: () => new Date().toISOString(),
};

export const queryDownstreamCapacity = async (input: {
	scanJobId: string;
	taskId: string;
	toStage?: string | null;
	deps?: Partial<DownstreamCapacityDeps>;
}): Promise<DownstreamCapacityResult> => {
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
	const currentStage = task.stageName;
	let stageNames = collectDownstreamStageNames(snapshot.edges, currentStage);
	const toStage = input.toStage?.trim() || "";
	if (toStage) {
		if (!stageNames.includes(toStage)) {
			throw new ScanRuntimeApiError(
				404,
				`Stage ${toStage} is not a downstream stage of ${currentStage}`,
			);
		}
		stageNames = [toStage];
	}

	const stages: DownstreamCapacityStage[] = [];
	for (const stageName of stageNames) {
		const fallback = yamlConcurrencyForStage(snapshot, stageName);
		const concurrency = Math.max(
			1,
			asPositiveInt(
				await deps.resolveConcurrency(input.scanJobId, stageName, fallback),
				fallback,
			),
		);
		const activeTasks = asPositiveInt(
			await deps.countActiveTasks(input.scanJobId, stageName),
			0,
		);
		const enabled = await deps.isStageActive(input.scanJobId, stageName);
		stages.push({
			stageName,
			concurrency,
			activeTasks,
			availableSlots: enabled
				? computeAvailableSlots(concurrency, activeTasks)
				: 0,
		});
	}

	return {
		ok: true,
		scanJobId: input.scanJobId,
		currentStage,
		generatedAt: deps.now(),
		stages,
	};
};

export const queryDownstreamCapacityForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	toStage?: string | null;
	deps?: Partial<DownstreamCapacityDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const scanJobId = input.scanJobId?.trim() || "";
	const taskId = input.taskId?.trim() || "";
	if (!scanJobId || !taskId) {
		throw new ScanRuntimeApiError(
			400,
			"scanJobId and taskId are required",
		);
	}
	const token = parseBearerToken(input.authorization);
	const verify = input.verifyToken ?? verifyScanRuntimeToken;
	if (!verify({ scanJobId, token })) {
		throw new ScanRuntimeApiError(401, "Invalid runtime token");
	}
	return queryDownstreamCapacity({
		scanJobId,
		taskId,
		toStage: input.toStage,
		deps: input.deps,
	});
};
