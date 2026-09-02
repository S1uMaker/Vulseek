import type { ScanJob, Task, Message } from "../types";
import type { CompiledPipelineDefinition } from "../pipeline/document-v3/pipeline-v3-compiler";
import { transformPipelineEdgeInput } from "../pipeline/scan-pipeline-edge-transform";


export type ReconstructTaskInputDeps = {
	findTaskById: (taskId: string) => Promise<Task>;
	findMessageById: (messageId: string) => Promise<Message | null>;
	findScanJobById: (scanJobId: string) => Promise<ScanJob>;
	readProducerArtifact?: (task: Task, containerPath: string) => Promise<unknown>;
};

const defaultDeps = (): ReconstructTaskInputDeps => ({
	findTaskById: async (taskId) => {
		const { findTaskByIdRepo } = await import("../persistence/task.repo");
		return findTaskByIdRepo(taskId);
	},
	findMessageById: async (messageId) => {
		const { findMessageByIdRepo } = await import(
			"../persistence/message.repo"
		);
		return findMessageByIdRepo(messageId);
	},
	findScanJobById: async (scanJobId) => {
		const { findScanJobByIdRepo } = await import("../persistence/scan-job.repo");
		return findScanJobByIdRepo(scanJobId);
	},
	readProducerArtifact: async (task, containerPath) => {
		const { readTaskJsonArtifactForTask } = await import(
			"../persistence/task-artifact-resolver"
		);
		return readTaskJsonArtifactForTask(task, containerPath);
	},
});

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

export const reconstructRootTaskInput = (
	job: Pick<
		ScanJob,
		| "scanJobId"
		| "title"
		| "triggerSource"
		| "applicationId"
		| "composeId"
		| "datasetEvaluationTrialId"
		| "targetRef"
		| "targetTag"
		| "commitSha"
		| "baseSha"
		| "commitWindow"
		| "maxTasks"
		| "deadlineAt"
	>,
) => ({
	run: {
		scanJobId: job.scanJobId,
		title: job.title,
		triggerSource: job.triggerSource,
	},
	target: {
		applicationId: job.applicationId ?? null,
		composeId: job.composeId ?? null,
		datasetEvaluationTrialId: job.datasetEvaluationTrialId ?? null,
	},
	repository: {
		targetRef: job.targetRef ?? null,
		targetTag: job.targetTag ?? null,
		commitSha: job.commitSha ?? null,
		baseSha: job.baseSha ?? null,
		commitWindow: job.commitWindow ?? null,
	},
	limits: {
		maxTasks: job.maxTasks ?? null,
		deadlineAt: job.deadlineAt ?? null,
	},
	repositoryPath: "/task/inputs/repository.json",
});

export const reconstructTaskInput = async (
	task: Task,
	deps?: Partial<ReconstructTaskInputDeps>,
	seen: Set<string> = new Set(),
): Promise<unknown> => {
	const resolved = { ...defaultDeps(), ...deps };
	if (seen.has(task.taskId)) {
		throw new Error(`Cycle reconstructing input for task ${task.taskId}`);
	}
	seen.add(task.taskId);
	if (task.rerunOfTaskId) {
		const original = await resolved.findTaskById(task.rerunOfTaskId);
		return reconstructTaskInput(original, resolved, seen);
	}
	if (!task.sourceMessageId) {
		const job = await resolved.findScanJobById(task.scanJobId);
		return reconstructRootTaskInput(job);
	}
	return reconstructTaskInputFromSource(
		{
			scanJobId: task.scanJobId,
			sourceMessageId: task.sourceMessageId,
			sourceEdgeName: task.sourceEdgeName,
			sourceItemIndex: task.sourceItemIndex ?? 0,
			taskId: task.taskId,
		},
		resolved,
		seen,
	);
};

export const reconstructTaskInputFromSource = async (
	input: {
		scanJobId: string;
		sourceMessageId: string;
		sourceEdgeName: string | null;
		sourceItemIndex: number;
		taskId?: string | null;
	},
	deps?: Partial<ReconstructTaskInputDeps>,
	seen: Set<string> = new Set(),
): Promise<unknown> => {
	const resolved = { ...defaultDeps(), ...deps };
	const source = await resolved.findMessageById(input.sourceMessageId);
	if (!source) {
		throw new Error(
			`Source Message ${input.sourceMessageId} not found${
				input.taskId ? ` for task ${input.taskId}` : ""
			}`,
		);
	}
	const producer = await resolved.findTaskById(source.sourceTaskId);
	const producerInput = await reconstructTaskInput(producer, resolved, seen);
	const job = await resolved.findScanJobById(input.scanJobId);
	const snapshot = loadCompiledSnapshot(job);
	if (!snapshot) {
		throw new Error(`Pipeline snapshot missing for job ${input.scanJobId}`);
	}
	const edge = snapshot.edges.find(
		(item) =>
			item.name === input.sourceEdgeName || item.id === input.sourceEdgeName,
	);
	if (!edge) {
		throw new Error(
			`Source edge ${input.sourceEdgeName} not found in pipeline snapshot`,
		);
	}
	const mapped = (await transformPipelineEdgeInput(
		{
			mode: edge.mode,
			foreach: edge.foreach,
			input: edge.input,
		},
		{
			ctx: { scanJob: job },
			stageInput: producerInput,
			stageOutput: source.payload,
			readJsonFile: resolved.readProducerArtifact
				? async (containerPath) =>
						resolved.readProducerArtifact?.(producer, containerPath)
				: undefined,
		},
	)) as unknown[];
	const index = input.sourceItemIndex ?? 0;
	if (index < 0 || index >= mapped.length) {
		if (mapped.length === 1 && index === 0) {
			return mapped[0];
		}
		throw new Error(
			`Source item index ${index} is out of range for edge ${edge.name}`,
		);
	}
	return mapped[index];
};
