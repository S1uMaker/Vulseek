import type { Job, Queue } from "bullmq";
import type {
	PipelineContext,
	StageContext,
} from "../stages/full-scan-stage.runtime";
import type { StructuredOutputSchemaSource } from "./scan-pipeline-schema-contracts";

export type StageExecution<TInput> = {
	taskId: string;
	input: TInput;
};

export type StageQueueScope = {
	groupInstanceId?: string | null;
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
	poll: (
		ctx: TPipelineContext,
		scope?: StageQueueScope,
	) => Promise<StageExecution<TInput> | undefined>;
	enqueue: (taskId: string, scope?: StageQueueScope) => Promise<void>;
	remove: (taskId: string, scope?: StageQueueScope) => Promise<void>;
	obliterateGroup: (groupInstanceId: string) => Promise<void>;
};

type StageQueueBindingOptions<
	TPipelineContext extends PipelineContext,
	TInput,
> = {
	queue: Queue<string>;
	getGroupQueue?: (groupInstanceId: string) => Queue<string>;
	obliterateGroupQueue?: (groupInstanceId: string) => Promise<void>;
	getInputId?: (jobData: string, jobId: string) => string | null;
	ownsInputId?: (
		ctx: TPipelineContext,
		inputId: string,
		jobData: string,
		jobId: string,
		scope?: StageQueueScope,
	) => Promise<boolean>;
	loadInput: (ctx: TPipelineContext, inputId: string) => Promise<TInput | undefined>;
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
});

const resolveJobInputId = <TPipelineContext extends PipelineContext, TInput>(
	binding: Pick<
		StageQueueBindingOptions<TPipelineContext, TInput>,
		"getInputId" | "queue"
	>,
	job: Job<string>,
) => {
	const rawJobData = typeof job.data === "string" ? job.data : "";
	return (
		binding.getInputId?.(rawJobData, String(job.id ?? "")) ??
		(typeof job.data === "string" ? job.data : null)
	);
};

const pollStageQueue = async <
	TPipelineContext extends PipelineContext,
	TInput,
>(
	binding: StageQueueBindingOptions<TPipelineContext, TInput>,
	ctx: TPipelineContext,
	scope?: StageQueueScope,
): Promise<StageExecution<TInput> | undefined> => {
	const queue =
		scope?.groupInstanceId && binding.getGroupQueue
			? binding.getGroupQueue(scope.groupInstanceId)
			: binding.queue;
	const jobs = await queue.getJobs(["prioritized", "waiting"], 0, 25, true);
	for (const job of jobs) {
		const rawJobData = typeof job.data === "string" ? job.data : "";
		const jobId = String(job.id ?? "");
		const inputId = resolveJobInputId(binding, job);
		if (!inputId) {
			await job.remove().catch(() => {});
			console.log(
				"[scan-queue]",
				JSON.stringify({
					event: "poll.skipped_missing_input_id",
					scanJobId: ctx.scanJobId,
					queueName: queue.name,
					queueScope: scope?.groupInstanceId ? "group" : "global",
					groupInstanceId: scope?.groupInstanceId ?? null,
					jobId,
				}),
			);
			continue;
		}

		if (
			binding.ownsInputId &&
			!(await binding.ownsInputId(ctx, inputId, rawJobData, jobId, scope))
		) {
			continue;
		}

		const input = await binding.loadInput(ctx, inputId);
		console.log(
			"[scan-queue]",
			JSON.stringify({
				event: input !== undefined ? "poll.loaded_input" : "poll.input_missing",
				scanJobId: ctx.scanJobId,
				queueName: queue.name,
				queueScope: scope?.groupInstanceId ? "group" : "global",
				groupInstanceId: scope?.groupInstanceId ?? null,
				jobId,
				inputId,
			}),
		);
		await job.remove().catch(() => {});
		if (input === undefined) {
			continue;
		}
		return {
			taskId: inputId,
			input,
		};
	}

	return undefined;
};

export const createStageQueueBinding = <
	TPipelineContext extends PipelineContext,
	TInput,
>(
	binding: StageQueueBindingOptions<TPipelineContext, TInput>,
): StageQueueBinding<TPipelineContext, TInput> => ({
	queue: binding.queue,
	getQueue: (scope) =>
		scope?.groupInstanceId && binding.getGroupQueue
			? binding.getGroupQueue(scope.groupInstanceId)
			: binding.queue,
	poll: (ctx, scope) => pollStageQueue(binding, ctx, scope),
	enqueue: async (taskId, scope) => {
		const queue =
			scope?.groupInstanceId && binding.getGroupQueue
				? binding.getGroupQueue(scope.groupInstanceId)
				: binding.queue;
		await queue.add(queue.name, taskId, {
			jobId: `${queue.name}:${taskId}`,
			removeOnComplete: true,
			removeOnFail: true,
		});
	},
	remove: async (taskId, scope) => {
		const queue =
			scope?.groupInstanceId && binding.getGroupQueue
				? binding.getGroupQueue(scope.groupInstanceId)
				: binding.queue;
		const job = await queue.getJob(`${queue.name}:${taskId}`).catch(() => null);
		await job?.remove().catch(() => {});
	},
	obliterateGroup: async (groupInstanceId) => {
		await binding.obliterateGroupQueue?.(groupInstanceId);
	},
});
