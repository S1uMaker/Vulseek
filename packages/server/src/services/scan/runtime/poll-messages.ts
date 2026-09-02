import type { ScanJob } from "../types";
import type { CompiledPipelineDefinition } from "../pipeline/document-v3/pipeline-v3-compiler";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import { findTaskByIdRepo } from "../persistence/task.repo";
import { reconstructTaskInputFromSource } from "./reconstruct-task-input";
import {
	parseBearerToken,
	verifyScanRuntimeToken,
} from "./scan-runtime-api-auth";
import { ScanRuntimeApiError } from "./scan-runtime-api-error";

export type QueuedStageMessage = {
	messageId: string;
	edgeName: string;
	itemIndex: number;
	stageName: string;
	name: string;
	status: string;
	sourceEdgeName: string | null;
	input: unknown;
	createdAt: string;
	updatedAt: string;
};

export type QueuedMessagesResult = {
	ok: true;
	scanJobId: string;
	currentStage: string;
	stageName: string;
	generatedAt: string;
	messages: QueuedStageMessage[];
};

export type CompleteQueuedMessagesResult = {
	ok: true;
	scanJobId: string;
	stageName: string;
	completedMessageIds: string[];
};

export type WaitingStageMessageJob = {
	messageId: string;
	edgeName: string;
	itemIndex: number;
	createdAt: string;
	remove: () => Promise<void>;
};

type QueuedMessagesDeps = {
	findTaskById: (taskId: string) => Promise<{
		taskId: string;
		scanJobId: string;
		stageName: string;
		status: string;
	} | null>;
	findScanJobById: (
		scanJobId: string,
	) => Promise<Pick<ScanJob, "scanJobId" | "pipelineCompiledSnapshot"> | null>;
	listWaitingOutputJobs: (input: {
		scanJobId: string;
		stageName: string;
	}) => Promise<WaitingStageMessageJob[]>;
	reconstructInput: (input: {
		scanJobId: string;
		sourceMessageId: string;
		sourceEdgeName: string;
		sourceItemIndex: number;
	}) => Promise<unknown>;
	incrementProcessed?: (input: {
		scanJobId: string;
		stageName: string;
		count: number;
	}) => Promise<void>;
	now: () => string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const queuedOutputName = (input: unknown, edgeName: string) => {
	if (isRecord(input) && typeof input.name === "string") {
		const trimmed = input.name.trim();
		if (trimmed) return trimmed;
	}
	return edgeName;
};

const defaultDeps: QueuedMessagesDeps = {
	findTaskById: async (taskId) => {
		try {
			const task = await findTaskByIdRepo(taskId);
			return {
				taskId: task.taskId,
				scanJobId: task.scanJobId,
				stageName: task.stageName,
				status: task.status,
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
	listWaitingOutputJobs: async (input) => {
		const { listScanStageWaitingMessageJobs } = await import("../../scan");
		return listScanStageWaitingMessageJobs(input);
	},
	reconstructInput: (input) => reconstructTaskInputFromSource(input),
	incrementProcessed: async (input) => {
		const { incrementProcessedMessageCountRepo } = await import(
			"../persistence/message.repo"
		);
		await incrementProcessedMessageCountRepo(input);
	},
	now: () => new Date().toISOString(),
};

const toQueuedItem = async (input: {
	scanJobId: string;
	stageName: string;
	item: {
		messageId: string;
		edgeName: string;
		itemIndex: number;
		createdAt: string;
		status: string;
	};
	deps: QueuedMessagesDeps;
}): Promise<QueuedStageMessage> => {
	const reconstructed = await input.deps.reconstructInput({
		scanJobId: input.scanJobId,
		sourceMessageId: input.item.messageId,
		sourceEdgeName: input.item.edgeName,
		sourceItemIndex: input.item.itemIndex,
	});
	return {
		messageId: input.item.messageId,
		edgeName: input.item.edgeName,
		itemIndex: input.item.itemIndex,
		stageName: input.stageName,
		name: queuedOutputName(reconstructed, input.item.edgeName),
		status: input.item.status,
		sourceEdgeName: input.item.edgeName,
		input: reconstructed,
		createdAt: input.item.createdAt,
		updatedAt: input.item.createdAt,
	};
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

const authorizeQueuedStage = async (input: {
	scanJobId: string;
	taskId: string;
	stageName: string;
	deps: QueuedMessagesDeps;
}) => {
	const stageName = input.stageName.trim();
	if (!stageName) {
		throw new ScanRuntimeApiError(400, "stage is required");
	}
	const task = await input.deps.findTaskById(input.taskId);
	if (!task) {
		throw new ScanRuntimeApiError(404, "Task not found");
	}
	if (task.scanJobId !== input.scanJobId) {
		throw new ScanRuntimeApiError(403, "Task does not belong to scan job");
	}
	if (task.stageName !== stageName) {
		throw new ScanRuntimeApiError(
			403,
			`query-messages only lists the current stage queue (${task.stageName}), not ${stageName}`,
		);
	}
	const scanJob = await input.deps.findScanJobById(input.scanJobId);
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
	return { task, stageName };
};

export const queryMessages = async (input: {
	scanJobId: string;
	taskId: string;
	stageName: string;
	deps?: Partial<QueuedMessagesDeps>;
}): Promise<QueuedMessagesResult> => {
	const deps = { ...defaultDeps, ...input.deps };
	const { task, stageName } = await authorizeQueuedStage({
		scanJobId: input.scanJobId,
		taskId: input.taskId,
		stageName: input.stageName,
		deps,
	});
	const queued = await deps.listWaitingOutputJobs({
		scanJobId: input.scanJobId,
		stageName,
	});
	const messages: QueuedStageMessage[] = [];
	for (const item of queued) {
		messages.push(
			await toQueuedItem({
				scanJobId: input.scanJobId,
				stageName,
				item: { ...item, status: "queued" },
				deps,
			}),
		);
	}
	return {
		ok: true,
		scanJobId: input.scanJobId,
		currentStage: task.stageName,
		stageName,
		generatedAt: deps.now(),
		messages,
	};
};

export const pollMessages = async (input: {
	scanJobId: string;
	taskId: string;
	stageName: string;
	deps?: Partial<QueuedMessagesDeps>;
}): Promise<QueuedMessagesResult> => {
	const deps = { ...defaultDeps, ...input.deps };
	const { task, stageName } = await authorizeQueuedStage({
		scanJobId: input.scanJobId,
		taskId: input.taskId,
		stageName: input.stageName,
		deps,
	});
	const waiting = await deps.listWaitingOutputJobs({
		scanJobId: input.scanJobId,
		stageName,
	});
	const messages: QueuedStageMessage[] = [];
	for (const item of waiting) {
		await item.remove();
		messages.push(
			await toQueuedItem({
				scanJobId: input.scanJobId,
				stageName,
				item: { ...item, status: "polled" },
				deps,
			}),
		);
	}
	if (messages.length > 0) {
		await deps.incrementProcessed?.({
			scanJobId: input.scanJobId,
			stageName,
			count: messages.length,
		});
	}
	return {
		ok: true,
		scanJobId: input.scanJobId,
		currentStage: task.stageName,
		stageName,
		generatedAt: deps.now(),
		messages,
	};
};

export const completeMessages = async (input: {
	scanJobId: string;
	taskId: string;
	stageName: string;
	messageIds: string[];
	deps?: Partial<QueuedMessagesDeps>;
}): Promise<CompleteQueuedMessagesResult> => {
	const deps = { ...defaultDeps, ...input.deps };
	const { stageName } = await authorizeQueuedStage({
		scanJobId: input.scanJobId,
		taskId: input.taskId,
		stageName: input.stageName,
		deps,
	});
	const requested = [
		...new Set(input.messageIds.map((id) => id.trim()).filter(Boolean)),
	];
	const waiting = await deps.listWaitingOutputJobs({
		scanJobId: input.scanJobId,
		stageName,
	});
	const waitingByOutputId = new Map<string, WaitingStageMessageJob[]>();
	for (const item of waiting) {
		const current = waitingByOutputId.get(item.messageId) ?? [];
		current.push(item);
		waitingByOutputId.set(item.messageId, current);
	}
	const completedMessageIds: string[] = [];
	for (const messageId of requested) {
		const leftover = waitingByOutputId.get(messageId) ?? [];
		for (const item of leftover) {
			await item.remove();
		}
		completedMessageIds.push(messageId);
	}
	return {
		ok: true,
		scanJobId: input.scanJobId,
		stageName,
		completedMessageIds,
	};
};

const requireRuntimeIdentity = (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	stageName: string | null | undefined;
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
	return { scanJobId, taskId, stageName };
};

export const queryMessagesForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	stageName: string | null | undefined;
	deps?: Partial<QueuedMessagesDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const identity = requireRuntimeIdentity(input);
	return queryMessages({
		...identity,
		deps: input.deps,
	});
};

export const pollMessagesForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	stageName: string | null | undefined;
	deps?: Partial<QueuedMessagesDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const identity = requireRuntimeIdentity(input);
	return pollMessages({
		...identity,
		deps: input.deps,
	});
};

export const completeMessagesForRequest = async (input: {
	authorization: string | null | undefined;
	scanJobId: string | null | undefined;
	taskId: string | null | undefined;
	stageName: string | null | undefined;
	messageIds: string[];
	deps?: Partial<QueuedMessagesDeps>;
	verifyToken?: typeof verifyScanRuntimeToken;
}) => {
	const identity = requireRuntimeIdentity(input);
	return completeMessages({
		...identity,
		messageIds: input.messageIds,
		deps: input.deps,
	});
};
