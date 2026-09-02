import { createTaskIdForSource } from "../task-id";
import {
	zeroOutputProtocolFailureMessage,
	type MessageRecord,
} from "../persistence/message-store";

export type CompletedAgentTaskSettlement =
	| {
			outcome: "protocol-failure";
			outputCount: number;
			errorMessage: string;
	  }
	| {
			outcome: "completed";
			outputCount: number;
			persisted: unknown;
	  };

export const settleCompletedAgentTask = async (input: {
	taskId: string;
	countMessagesByProducerTaskId: (taskId: string) => Promise<number>;
	persistTerminalFailure: (error: Error) => Promise<unknown>;
	persistTerminalSuccess: () => Promise<unknown>;
}): Promise<CompletedAgentTaskSettlement> => {
	const outputCount = await input.countMessagesByProducerTaskId(input.taskId);
	const errorMessage = zeroOutputProtocolFailureMessage(outputCount);
	if (errorMessage) {
		await input.persistTerminalFailure(new Error(errorMessage));
		return {
			outcome: "protocol-failure",
			outputCount,
			errorMessage,
		};
	}
	const persisted = await input.persistTerminalSuccess();
	return {
		outcome: "completed",
		outputCount,
		persisted,
	};
};

export const createDownstreamChildIdentity = (input: {
	sourceMessageId: string;
	sourceEdgeName: string;
	sourceItemIndex: number;
}) => ({
	sourceMessageId: input.sourceMessageId,
	sourceEdgeName: input.sourceEdgeName,
	sourceItemIndex: input.sourceItemIndex,
	taskId: createTaskIdForSource(input),
});

export type MaterializedJobOutput = {
	messageId: string;
	stageName: string;
	artifacts: Array<{ path: string }>;
};

export type DispatchableProducerTask = {
	taskId: string;
	scanJobId: string;
	name: string;
	stageName: string;
	lifecycle: "turn" | "goal";
	status: string;
};

export type DispatchedMessageResult = {
	childTaskIds: string[];
	producerStatus: string;
	producerLifecycle: "turn" | "goal";
	stampedFindingCount: number;
	jobOutput: MaterializedJobOutput | null;
};

export const dispatchClaimedMessage = async <
	TTask extends DispatchableProducerTask,
>(input: {
	output: MessageRecord;
	findTaskById: (taskId: string) => Promise<TTask>;
	reconstructTaskInput?: (task: TTask) => Promise<unknown>;
	syncCandidates?: (args: {
		taskId: string;
		messageId: string;
		output: unknown;
	}) => Promise<void>;
	upsertProjection?: (args: {
		task: TTask;
		messageId: string;
		output: unknown;
	}) => Promise<void>;
	materializeJobOutput?: (args: {
		task: TTask;
		messageId: string;
		output: unknown;
	}) => Promise<MaterializedJobOutput | null>;
	appendJobOutput?: (args: {
		scanJobId: string;
		output: MaterializedJobOutput;
	}) => Promise<void>;
	stampResearchFindings?: (args: {
		scanJobId: string;
		producerTaskId: string;
		messageId: string;
	}) => Promise<number>;
	onSuccess?: (args: {
		task: TTask;
		stageInput: unknown;
		output: unknown;
		messageId: string;
		routeKey: string | null;
	}) => Promise<void>;
	createDownstreamTasks: (args: {
		producerTask: TTask;
		taskOutput: MessageRecord;
		stageInput: unknown;
	}) => Promise<string[]>;
	completeDispatch: (messageId: string) => Promise<unknown>;
}): Promise<DispatchedMessageResult> => {
	const producerTask = await input.findTaskById(input.output.sourceTaskId);
	const stageInput = input.reconstructTaskInput
		? await input.reconstructTaskInput(producerTask)
		: null;
	await input.syncCandidates?.({
		taskId: producerTask.taskId,
		messageId: input.output.messageId,
		output: input.output.payload,
	});
	await input.upsertProjection?.({
		task: producerTask,
		messageId: input.output.messageId,
		output: input.output.payload,
	});
	const jobOutput =
		(await input.materializeJobOutput?.({
			task: producerTask,
			messageId: input.output.messageId,
			output: input.output.payload,
		})) ?? null;
	if (jobOutput) {
		await input.appendJobOutput?.({
			scanJobId: producerTask.scanJobId,
			output: jobOutput,
		});
	}
	const stampedFindingCount =
		(await input.stampResearchFindings?.({
			scanJobId: producerTask.scanJobId,
			producerTaskId: producerTask.taskId,
			messageId: input.output.messageId,
		})) ?? 0;
	await input.onSuccess?.({
		task: producerTask,
		stageInput,
		output: input.output.payload,
		messageId: input.output.messageId,
		routeKey: input.output.routeKey,
	});
	const childTaskIds = await input.createDownstreamTasks({
		producerTask,
		taskOutput: input.output,
		stageInput,
	});
	await input.completeDispatch(input.output.messageId);
	return {
		childTaskIds,
		producerStatus: producerTask.status,
		producerLifecycle: producerTask.lifecycle,
		stampedFindingCount,
		jobOutput,
	};
};

export const stampUnstampedResearchFindings = <
	T extends { producerTaskId: string; messageId: string | null },
>(
	findings: T[],
	input: { producerTaskId: string; messageId: string },
) => {
	let stamped = 0;
	for (const finding of findings) {
		if (
			finding.producerTaskId === input.producerTaskId &&
			finding.messageId == null
		) {
			finding.messageId = input.messageId;
			stamped += 1;
		}
	}
	return stamped;
};
