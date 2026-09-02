import { nanoid } from "nanoid";
import { createTaskIdForSource } from "../task-id";
import { stableJsonEqual } from "../runtime/stable-json";

export const ZERO_OUTPUT_PROTOCOL_FAILURE =
	"Protocol failure: task completed without submitting a Message";

export const zeroOutputProtocolFailureMessage = (outputCount: number) =>
	outputCount === 0 ? ZERO_OUTPUT_PROTOCOL_FAILURE : null;

const ACTIVE_PRODUCER_STATUSES = [
	"launching",
	"launched",
	"starting",
	"running",
] as const;

export const isActiveProducerStatus = (status: string) =>
	(ACTIVE_PRODUCER_STATUSES as readonly string[]).includes(status);

export type MessageStatus =
	| "pending"
	| "processing"
	| "completed"
	| "failed";

export type MessageRecord = {
	messageId: string;
	scanJobId: string;
	sourceTaskId: string;
	sequence: number;
	submissionKey: string;
	routeKey: string | null;
	payload: unknown;
	status: MessageStatus;
	dispatchAttempt: number;
	claimedAt: string | null;
	dispatchedAt: string | null;
	errorMessage: string | null;
	createdAt: string;
	updatedAt: string;
};

const nowIso = () => new Date().toISOString();

export type InsertMessageResult =
	| { kind: "created"; record: MessageRecord }
	| { kind: "idempotent"; record: MessageRecord }
	| { kind: "conflict"; record: MessageRecord };

export type MessageInsertStore = {
	lockProducer: (
		sourceTaskId: string,
	) => Promise<{ taskId: string; scanJobId: string } | null>;
	findBySubmissionKey: (
		sourceTaskId: string,
		submissionKey: string,
	) => Promise<MessageRecord | null>;
	maxSequence: (sourceTaskId: string) => Promise<number>;
	insert: (record: MessageRecord) => Promise<MessageRecord>;
};

export const insertPendingMessageWithStore = async (
	store: MessageInsertStore,
	input: {
		sourceTaskId: string;
		submissionKey: string;
		routeKey: string | null;
		payload: unknown;
	},
	options?: {
		now?: () => string;
		createId?: () => string;
	},
): Promise<InsertMessageResult> => {
	const producer = await store.lockProducer(input.sourceTaskId);
	if (!producer) {
		throw new Error(`Producer task ${input.sourceTaskId} not found`);
	}
	const existing = await store.findBySubmissionKey(
		input.sourceTaskId,
		input.submissionKey,
	);
	if (existing) {
		if (stableJsonEqual(existing.payload, input.payload)) {
			return { kind: "idempotent", record: existing };
		}
		return { kind: "conflict", record: existing };
	}
	const sequence = (await store.maxSequence(input.sourceTaskId)) + 1;
	const createdAt = (options?.now ?? nowIso)();
	const record = await store.insert({
		messageId: (options?.createId ?? nanoid)(),
		scanJobId: producer.scanJobId,
		sourceTaskId: input.sourceTaskId,
		sequence,
		submissionKey: input.submissionKey,
		routeKey: input.routeKey,
		payload: input.payload,
		status: "pending",
		dispatchAttempt: 0,
		claimedAt: null,
		dispatchedAt: null,
		errorMessage: null,
		createdAt,
		updatedAt: createdAt,
	});
	return { kind: "created", record };
};

export type ClaimMessageOptions = {
	allowMultipleSourceTaskIds?: Iterable<string>;
};

export const nextClaimableMessages = <
	T extends { sourceTaskId: string; sequence: number },
>(
	pending: T[],
	processingSourceTaskIds: Iterable<string>,
	options?: ClaimMessageOptions,
) => {
	const blocked = new Set(processingSourceTaskIds);
	const allowMultiple = new Set(options?.allowMultipleSourceTaskIds ?? []);
	const selected: T[] = [];
	const ordered = [...pending].sort((left, right) => {
		if (left.sourceTaskId !== right.sourceTaskId) {
			return left.sourceTaskId.localeCompare(right.sourceTaskId);
		}
		return left.sequence - right.sequence;
	});
	for (const output of ordered) {
		if (
			!allowMultiple.has(output.sourceTaskId) &&
			blocked.has(output.sourceTaskId)
		) {
			continue;
		}
		selected.push(output);
		if (!allowMultiple.has(output.sourceTaskId)) {
			blocked.add(output.sourceTaskId);
		}
	}
	return selected;
};

export type MessageClaimStore = {
	getJobStatus: (scanJobId: string) => Promise<string | null>;
	listPending: (scanJobId: string) => Promise<MessageRecord[]>;
	listProcessingSourceTaskIds: (scanJobId: string) => Promise<string[]>;
	claimIfPending: (output: MessageRecord) => Promise<MessageRecord | null>;
};

export const claimNextPendingMessagesWithStore = async (
	store: MessageClaimStore,
	scanJobId: string,
	options?: ClaimMessageOptions,
) => {
	const status = await store.getJobStatus(scanJobId);
	if (status !== "running") {
		return [] as MessageRecord[];
	}
	const pending = await store.listPending(scanJobId);
	const processing = await store.listProcessingSourceTaskIds(scanJobId);
	const claimable = nextClaimableMessages(pending, processing, options);
	const claimed: MessageRecord[] = [];
	for (const output of claimable) {
		const updated = await store.claimIfPending(output);
		if (updated) {
			claimed.push(updated);
		}
	}
	return claimed;
};

export const closeOpenMessagesWithStore = (
	outputs: MessageRecord[],
	producerIds: Set<string>,
	errorMessage: string,
	now = nowIso(),
) => {
	let closed = 0;
	for (const output of outputs) {
		if (
			!producerIds.has(output.sourceTaskId) ||
			(output.status !== "pending" &&
				output.status !== "processing")
		) {
			continue;
		}
		output.status = "failed";
		output.errorMessage = errorMessage;
		output.updatedAt = now;
		closed += 1;
	}
	return closed;
};

const OPEN_TASK_STATUSES = [
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
] as const;
const ROOT_TERMINAL_STATUSES = [
	"completed",
	"failed",
	"exited",
	"canceled",
] as const;

export const computeScanJobSettlement = (input: {
	tasks: Array<{ sourceMessageId: string | null; status: string }>;
	outputs: Array<{ status: string }>;
}): {
	rootTerminal: boolean;
	rootFailed: boolean;
	openTaskCount: number;
	unsettledDispatchCount: number;
	failedNonRootTaskCount: number;
} => {
	const roots = input.tasks.filter((task) => task.sourceMessageId === null);
	const openTaskCount = input.tasks.filter((task) =>
		(OPEN_TASK_STATUSES as readonly string[]).includes(task.status),
	).length;
	const rootTerminalCount = roots.filter((task) =>
		(ROOT_TERMINAL_STATUSES as readonly string[]).includes(task.status),
	).length;
	return {
		rootTerminal:
			roots.length > 0 &&
			rootTerminalCount === roots.length &&
			openTaskCount === 0,
		rootFailed: roots.some(
			(task) => task.status === "failed" || task.status === "exited",
		),
		openTaskCount,
		unsettledDispatchCount: input.outputs.filter(
			(output) =>
				output.status === "pending" ||
				output.status === "processing",
		).length,
		failedNonRootTaskCount: input.tasks.filter(
			(task) =>
				task.sourceMessageId !== null &&
				(task.status === "failed" || task.status === "exited"),
		).length,
	};
};

export type MemoryTaskRecord = {
	taskId: string;
	scanJobId: string;
	name: string;
	stageName: string;
	lifecycle: "turn" | "goal";
	status: string;
	sourceMessageId: string | null;
	sourceEdgeName: string | null;
	sourceItemIndex: number | null;
	rerunOfTaskId: string | null;
};

export type MemoryJobRecord = {
	scanJobId: string;
	status: string;
};

export const createMemoryMessageStore = (seed?: {
	jobs?: MemoryJobRecord[];
	tasks?: MemoryTaskRecord[];
}) => {
	const jobs = new Map(
		(seed?.jobs ?? []).map((job) => [job.scanJobId, { ...job }]),
	);
	const taskRows = new Map(
		(seed?.tasks ?? []).map((task) => [task.taskId, { ...task }]),
	);
	const outputs: MessageRecord[] = [];
	const enqueued = new Set<string>();
	const producerLocks = new Map<string, Promise<void>>();
	let idSeq = 0;

	const withProducerLock = async <T>(
		sourceTaskId: string,
		fn: () => Promise<T>,
	) => {
		const previous = producerLocks.get(sourceTaskId) ?? Promise.resolve();
		let release: () => void = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		producerLocks.set(sourceTaskId, previous.then(() => current));
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	};

	const insertStore: MessageInsertStore = {
		lockProducer: async (sourceTaskId) => {
			const task = taskRows.get(sourceTaskId);
			return task
				? { taskId: sourceTaskId, scanJobId: task.scanJobId }
				: null;
		},
		findBySubmissionKey: async (sourceTaskId, submissionKey) =>
			outputs.find(
				(row) =>
					row.sourceTaskId === sourceTaskId &&
					row.submissionKey === submissionKey,
			) ?? null,
		maxSequence: async (sourceTaskId) =>
			outputs
				.filter((row) => row.sourceTaskId === sourceTaskId)
				.reduce((max, row) => Math.max(max, row.sequence), 0),
		insert: async (record) => {
			outputs.push(record);
			return record;
		},
	};

	const claimStore: MessageClaimStore = {
		getJobStatus: async (scanJobId) => jobs.get(scanJobId)?.status ?? null,
		listPending: async (scanJobId) =>
			outputs.filter((row) => {
				const task = taskRows.get(row.sourceTaskId);
				return (
					task?.scanJobId === scanJobId && row.status === "pending"
				);
			}),
		listProcessingSourceTaskIds: async (scanJobId) =>
			outputs
				.filter((row) => {
					const task = taskRows.get(row.sourceTaskId);
					return (
						task?.scanJobId === scanJobId &&
						row.status === "processing"
					);
				})
				.map((row) => row.sourceTaskId),
		claimIfPending: async (output) => {
			if (output.status !== "pending") {
				return null;
			}
			const claimedAt = nowIso();
			output.status = "processing";
			output.dispatchAttempt += 1;
			output.claimedAt = claimedAt;
			output.updatedAt = claimedAt;
			return output;
		},
	};

	return {
		jobs,
		tasks: taskRows,
		outputs,
		enqueued,
		insertPending: (input: {
			sourceTaskId: string;
			submissionKey: string;
			routeKey: string | null;
			payload: unknown;
		}) =>
			withProducerLock(input.sourceTaskId, () =>
				insertPendingMessageWithStore(insertStore, input, {
					createId: () => `to-${++idSeq}`,
				}),
			),
		claimNext: (
			scanJobId: string,
			options?: ClaimMessageOptions,
		) => claimNextPendingMessagesWithStore(claimStore, scanJobId, options),
		pauseJob: (scanJobId: string) => {
			const job = jobs.get(scanJobId);
			if (job) {
				job.status = "paused";
			}
		},
		cancelJob: (scanJobId: string) => {
			const job = jobs.get(scanJobId);
			if (job) {
				job.status = "canceled";
			}
			const producerIds = new Set(
				[...taskRows.values()]
					.filter((task) => task.scanJobId === scanJobId)
					.map((task) => task.taskId),
			);
			return closeOpenMessagesWithStore(
				outputs,
				producerIds,
				"Scan job canceled",
			);
		},
		failProducer: (taskId: string) => {
			const task = taskRows.get(taskId);
			if (task) {
				task.status = "failed";
			}
		},
		createChild: (input: {
			scanJobId: string;
			stageName: string;
			sourceMessageId: string;
			sourceEdgeName: string;
			sourceItemIndex: number;
		}) => {
			const existing = [...taskRows.values()].find(
				(task) =>
					task.sourceMessageId === input.sourceMessageId &&
					task.sourceEdgeName === input.sourceEdgeName &&
					task.sourceItemIndex === input.sourceItemIndex &&
					!task.rerunOfTaskId,
			);
			if (existing) {
				return existing;
			}
			const task: MemoryTaskRecord = {
				taskId: createTaskIdForSource(input),
				scanJobId: input.scanJobId,
				name: `${input.stageName} ${input.sourceItemIndex + 1}`,
				stageName: input.stageName,
				lifecycle: "turn",
				status: "pending",
				sourceMessageId: input.sourceMessageId,
				sourceEdgeName: input.sourceEdgeName,
				sourceItemIndex: input.sourceItemIndex,
				rerunOfTaskId: null,
			};
			taskRows.set(task.taskId, task);
			return task;
		},
		enqueueAfterCommit: (taskId: string) => {
			enqueued.add(taskId);
		},
		recoverMissingEnqueue: () => {
			let recovered = 0;
			for (const task of taskRows.values()) {
				if (task.status === "pending" && !enqueued.has(task.taskId)) {
					enqueued.add(task.taskId);
					recovered += 1;
				}
			}
			return recovered;
		},
	};
};
