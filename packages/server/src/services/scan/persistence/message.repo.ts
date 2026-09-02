import { db } from "@vulseek/server/db";
import {
	messages,
	scanJobStageStats,
	scanJobs,
	tasks,
} from "@vulseek/server/db/schema";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import {
	type ClaimMessageOptions,
	claimNextPendingMessagesWithStore,
	type InsertMessageResult,
	insertPendingMessageWithStore,
} from "./message-store";

export type {
	ClaimMessageOptions,
	InsertMessageResult,
	MemoryJobRecord,
	MemoryTaskRecord,
	MessageClaimStore,
	MessageStatus,
	MessageInsertStore,
	MessageRecord,
} from "./message-store";
export {
	claimNextPendingMessagesWithStore,
	closeOpenMessagesWithStore,
	computeScanJobSettlement,
	createMemoryMessageStore,
	insertPendingMessageWithStore,
	isActiveProducerStatus,
	nextClaimableMessages,
	ZERO_OUTPUT_PROTOCOL_FAILURE,
	zeroOutputProtocolFailureMessage,
} from "./message-store";

const nowIso = () => new Date().toISOString();

export const findMessageByIdRepo = async (messageId: string) => {
	const [row] = await db
		.select()
		.from(messages)
		.where(eq(messages.messageId, messageId))
		.limit(1);
	return row ?? null;
};

export const listMessagesBySourceTaskIdRepo = async (
	sourceTaskId: string,
) =>
	db
		.select()
		.from(messages)
		.where(eq(messages.sourceTaskId, sourceTaskId))
		.orderBy(asc(messages.sequence));

export const listMessagesByScanJobAndStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
	status?: "pending" | "processing" | "completed" | "failed";
}) =>
	db
		.select({
			taskId: tasks.taskId,
			taskStatus: tasks.status,
			taskName: tasks.name,
			messageId: messages.messageId,
			sequence: messages.sequence,
			status: messages.status,
			output: messages.payload,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.innerJoin(tasks, eq(messages.sourceTaskId, tasks.taskId))
		.where(
			and(
				...[
					eq(tasks.scanJobId, input.scanJobId),
					eq(tasks.stageName, input.stageName),
					input.status
						? eq(messages.status, input.status)
						: undefined,
				].filter(Boolean),
			),
		)
		.orderBy(asc(messages.createdAt), asc(messages.sequence));

export const countPendingMessagesByScanJobAndSourceStageRepo = async (
	scanJobId: string,
) => {
	const counts = new Map<string, number>();
	const rows = await db
		.select({
			stageName: tasks.stageName,
			count: count(),
		})
		.from(messages)
		.innerJoin(tasks, eq(messages.sourceTaskId, tasks.taskId))
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				eq(messages.status, "pending"),
			),
		)
		.groupBy(tasks.stageName);
	for (const row of rows) {
		counts.set(row.stageName, Number(row.count ?? 0));
	}
	return counts;
};

export const listMessagesPageBySourceTaskIdRepo = async (input: {
	sourceTaskId: string;
	limit: number;
	offset: number;
}) => {
	const rows = await db
		.select()
		.from(messages)
		.where(eq(messages.sourceTaskId, input.sourceTaskId))
		.orderBy(asc(messages.sequence))
		.limit(input.limit)
		.offset(input.offset);
	const [countRow] = await db
		.select({ count: sql<number>`count(*)` })
		.from(messages)
		.where(eq(messages.sourceTaskId, input.sourceTaskId));
	return { rows, total: Number(countRow?.count ?? 0) };
};

export const countMessagesBySourceTaskIdRepo = async (
	sourceTaskId: string,
) => {
	const [countRow] = await db
		.select({ count: sql<number>`count(*)` })
		.from(messages)
		.where(eq(messages.sourceTaskId, sourceTaskId));
	return Number(countRow?.count ?? 0);
};

export const insertPendingMessageRepo = async (input: {
	sourceTaskId: string;
	submissionKey: string;
	routeKey: string | null;
	payload: unknown;
}): Promise<InsertMessageResult> => {
	return await db.transaction(async (tx) => {
		return insertPendingMessageWithStore(
			{
				lockProducer: async (sourceTaskId) =>
					tx
						.select({ taskId: tasks.taskId, scanJobId: tasks.scanJobId })
						.from(tasks)
						.where(eq(tasks.taskId, sourceTaskId))
						.for("update")
						.limit(1)
						.then((rows) => rows[0] ?? null),
				findBySubmissionKey: async (sourceTaskId, submissionKey) =>
					tx
						.select()
						.from(messages)
						.where(
							and(
								eq(messages.sourceTaskId, sourceTaskId),
								eq(messages.submissionKey, submissionKey),
							),
						)
						.limit(1)
						.then((rows) => rows[0] ?? null),
				maxSequence: async (sourceTaskId) => {
					const [sequenceRow] = await tx
						.select({
							maxSequence: sql<number>`coalesce(max(${messages.sequence}), 0)`,
						})
						.from(messages)
						.where(eq(messages.sourceTaskId, sourceTaskId));
					return Number(sequenceRow?.maxSequence ?? 0);
				},
				insert: async (record) => {
					const [created] = await tx
						.insert(messages)
						.values(record)
						.returning();
					if (!created) {
						throw new Error("Failed to insert message");
					}
					return created;
				},
			},
			input,
		);
	});
};

export const claimNextPendingMessagesForJobRepo = async (
	scanJobId: string,
	options?: ClaimMessageOptions,
) => {
	return await db.transaction(async (tx) => {
		return claimNextPendingMessagesWithStore(
			{
				getJobStatus: async (id) =>
					tx
						.select({ status: scanJobs.status })
						.from(scanJobs)
						.where(eq(scanJobs.scanJobId, id))
						.for("share")
						.limit(1)
						.then((rows) => rows[0]?.status ?? null),
				listPending: async (id) =>
					tx
						.select({ output: messages })
						.from(messages)
						.innerJoin(tasks, eq(tasks.taskId, messages.sourceTaskId))
						.where(
							and(
								eq(tasks.scanJobId, id),
								eq(messages.status, "pending"),
							),
						)
						.orderBy(asc(messages.sourceTaskId), asc(messages.sequence))
						.then((rows) => rows.map((row) => row.output)),
				listProcessingSourceTaskIds: async (id) =>
					tx
						.select({ sourceTaskId: messages.sourceTaskId })
						.from(messages)
						.innerJoin(tasks, eq(tasks.taskId, messages.sourceTaskId))
						.where(
							and(
								eq(tasks.scanJobId, id),
								eq(messages.status, "processing"),
							),
						)
						.then((rows) => rows.map((row) => row.sourceTaskId)),
				claimIfPending: async (output) => {
					const claimedAt = nowIso();
					const [updated] = await tx
						.update(messages)
						.set({
							status: "processing",
							dispatchAttempt: output.dispatchAttempt + 1,
							claimedAt,
							updatedAt: claimedAt,
						})
						.where(
							and(
								eq(messages.messageId, output.messageId),
								eq(messages.status, "pending"),
							),
						)
						.returning();
					return updated ?? null;
				},
			},
			scanJobId,
			options,
		);
	});
};

export const completeMessageDispatchRepo = async (messageId: string) => {
	const [updated] = await db
		.update(messages)
		.set({
			status: "completed",
			dispatchedAt: nowIso(),
			errorMessage: null,
			updatedAt: nowIso(),
		})
		.where(eq(messages.messageId, messageId))
		.returning();
	return updated ?? null;
};

export const failMessageDispatchRepo = async (
	messageId: string,
	errorMessage: string,
) => {
	const [updated] = await db
		.update(messages)
		.set({
			status: "failed",
			errorMessage,
			updatedAt: nowIso(),
		})
		.where(eq(messages.messageId, messageId))
		.returning();
	return updated ?? null;
};

export const closeOpenMessagesForJobRepo = async (
	scanJobId: string,
	errorMessage: string,
) => {
	const producerIds = await db
		.select({ taskId: tasks.taskId })
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId));
	if (producerIds.length === 0) {
		return 0;
	}
	const updated = await db
		.update(messages)
		.set({
			status: "failed",
			errorMessage,
			updatedAt: nowIso(),
		})
		.where(
			and(
				inArray(
					messages.sourceTaskId,
					producerIds.map((row) => row.taskId),
				),
				inArray(messages.status, ["pending", "processing"]),
			),
		)
		.returning({ messageId: messages.messageId });
	return updated.length;
};

export const incrementProcessedMessageCountRepo = async (input: {
	scanJobId: string;
	stageName: string;
	count?: number;
}) => {
	const delta = input.count ?? 1;
	if (delta <= 0) {
		return;
	}
	const now = nowIso();
	await db
		.insert(scanJobStageStats)
		.values({
			scanJobId: input.scanJobId,
			stageName: input.stageName,
			processedMessageCount: delta,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [scanJobStageStats.scanJobId, scanJobStageStats.stageName],
			set: {
				processedMessageCount: sql`${scanJobStageStats.processedMessageCount} + ${delta}`,
				updatedAt: now,
			},
		});
};

export const listProcessedMessageCountsByScanJobRepo = async (
	scanJobId: string,
) => {
	const counts = new Map<string, number>();
	const rows = await db
		.select({
			stageName: scanJobStageStats.stageName,
			processedMessageCount: scanJobStageStats.processedMessageCount,
		})
		.from(scanJobStageStats)
		.where(eq(scanJobStageStats.scanJobId, scanJobId));
	for (const row of rows) {
		counts.set(row.stageName, Number(row.processedMessageCount ?? 0));
	}
	return counts;
};
