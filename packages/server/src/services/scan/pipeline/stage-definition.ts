import type { Queue } from "bullmq";
import type {
	PipelineContext,
	StageContext,
} from "../stages/full-scan-stage.runtime";
import type { StructuredOutputSchemaSource } from "./scan-pipeline-schema-contracts";
import {
	buildMessageQueueJobId,
	listAllQueueJobs,
	serializeMessageQueueJob,
	type MessageQueueJob,
} from "./message-queue";

export type StageExecution<TInput> = {
	taskId: string;
	input: TInput;
};

export type StageQueueScope = {
	groupInstanceId?: string | null;
};

export type StageQueueWaitingJob = {
	id: string;
	data: string;
	remove: () => Promise<void>;
};

export type StageRunResult =
	| {
			completion: "immediate";
			rawOutput: string;
	  }
	| {
			completion: "deferred";
			threadId?: string | null;
	  };

export type StageRuntimeConfigGetters = {
	getConcurrency: () => Promise<number>;
	getAgentProfile: () => Promise<string | null>;
	getGoalSession: () => Promise<"shared" | "per-task" | null>;
	getPersistent: () => Promise<boolean | null>;
	getReuseContainer: () => Promise<boolean | null>;
	getNullableOutput: () => Promise<boolean | null>;
	getCwd: () => Promise<string | null>;
	getSkills: () => Promise<string[]>;
	getMcp: () => Promise<string[]>;
	getPrompt: () => Promise<string | null>;
	getInputArtifacts: () => Promise<Record<string, unknown> | null>;
	getOutputSchema: () => Promise<unknown>;
};

export type StageQueueBinding<
	TPipelineContext extends PipelineContext,
	TInput,
> = {
	queue: Queue<string>;
	getQueue: (scope?: StageQueueScope) => Queue<string>;
	listWaiting: (scope?: StageQueueScope) => Promise<StageQueueWaitingJob[]>;
	enqueueOutput: (
		job: MessageQueueJob,
		scope?: StageQueueScope,
	) => Promise<void>;
	removeOutput: (
		job: MessageQueueJob,
		scope?: StageQueueScope,
	) => Promise<void>;
	obliterateGroup: (groupInstanceId: string) => Promise<void>;
};

type StageQueueBindingOptions<
	TPipelineContext extends PipelineContext,
	TInput,
> = {
	queue: Queue<string>;
	getGroupQueue?: (groupInstanceId: string) => Queue<string>;
	obliterateGroupQueue?: (groupInstanceId: string) => Promise<void>;
};

export type StageDefinition<
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput = void,
	TStageContext extends StageContext = StageContext,
> = {
	id: string;
	name: string;
	persistent?: boolean;
	reuseContainer?: boolean;
	nullableOutput?: boolean;
	jobOutput?: boolean;
	goal?: boolean;
	goalSession?: "shared" | "per-task";
	inputDelivery?: "prompt" | "poll";
	messageNotification?: boolean;
	allowAgentExit?: boolean;
	outputSchema?: StructuredOutputSchemaSource;
	runtimeConfig?: StageRuntimeConfigGetters;
	queue?: StageQueueBinding<TPipelineContext, TInput>;
	validateInput?: (ctx: TStageContext, input: TInput) => Promise<boolean>;
	launch?: (ctx: TStageContext, input: TInput) => Promise<void>;
	run: (
		ctx: TStageContext,
		input: TInput,
	) => Promise<StageRunResult>;
	validateOutput?: (
		ctx: TStageContext,
		input: TInput,
		rawOutput: string,
	) => Promise<TOutput>;
	getDesiredConcurrency?: (ctx: TPipelineContext) => Promise<number>;
	recoverQueue?: (ctx: TPipelineContext) => Promise<number>;
	onSuccess?: (
		ctx: TStageContext,
		input: TInput,
		output: TOutput,
		transaction?: unknown,
		metadata?: StageSuccessMetadata,
	) => Promise<void>;
	onFailure?: (
		ctx: TStageContext,
		input: TInput,
		error: unknown,
	) => Promise<void>;
};

export type StageSuccessMetadata = {
	routeKey: string | null;
	messageId?: string | null;
};

export const createStageDefinition = <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput = void,
	TStageContext extends StageContext = StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
): StageDefinition<TPipelineContext, TInput, TOutput, TStageContext> => ({
	...stage,
	persistent: stage.persistent ?? true,
	reuseContainer: stage.reuseContainer ?? true,
	nullableOutput: stage.nullableOutput ?? false,
	jobOutput: stage.jobOutput ?? false,
	goal: stage.goal ?? false,
	inputDelivery: stage.inputDelivery ?? "prompt",
	messageNotification: stage.messageNotification === true,
});

const resolveScopedQueue = <TPipelineContext extends PipelineContext, TInput>(
	binding: StageQueueBindingOptions<TPipelineContext, TInput>,
	scope?: StageQueueScope,
) =>
	scope?.groupInstanceId && binding.getGroupQueue
		? binding.getGroupQueue(scope.groupInstanceId)
		: binding.queue;

const listWaitingStageQueueJobs = async <
	TPipelineContext extends PipelineContext,
	TInput,
>(
	binding: StageQueueBindingOptions<TPipelineContext, TInput>,
	scope?: StageQueueScope,
): Promise<StageQueueWaitingJob[]> => {
	const queue = resolveScopedQueue(binding, scope);
	const jobs = await listAllQueueJobs(queue, ["prioritized", "waiting"]);
	return jobs.map((job) => ({
		id: String(job.id ?? ""),
		data:
			typeof job.data === "string"
				? job.data
				: JSON.stringify(job.data ?? ""),
		remove: () => job.remove().then(() => undefined).catch(() => {}),
	}));
};

export const createStageQueueBinding = <
	TPipelineContext extends PipelineContext,
	TInput,
>(
	binding: StageQueueBindingOptions<TPipelineContext, TInput>,
): StageQueueBinding<TPipelineContext, TInput> => ({
	queue: binding.queue,
	getQueue: (scope) => resolveScopedQueue(binding, scope),
	listWaiting: (scope) => listWaitingStageQueueJobs(binding, scope),
	enqueueOutput: async (job, scope) => {
		const queue = resolveScopedQueue(binding, scope);
		await queue.add(queue.name, serializeMessageQueueJob(job), {
			jobId: buildMessageQueueJobId(queue.name, job),
			removeOnComplete: true,
			removeOnFail: true,
		});
	},
	removeOutput: async (job, scope) => {
		const queue = resolveScopedQueue(binding, scope);
		const existing = await queue
			.getJob(buildMessageQueueJobId(queue.name, job))
			.catch(() => null);
		await existing?.remove().catch(() => {});
	},
	obliterateGroup: async (groupInstanceId) => {
		await binding.obliterateGroupQueue?.(groupInstanceId);
	},
});
