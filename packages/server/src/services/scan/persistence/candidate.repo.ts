import { db } from "@vulseek/server/db";
import {
	candidateMetadata,
	candidateTags,
	messages,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Evidence, VulnerabilityCandidate } from "../types";
import { readTaskJsonArtifactForTask } from "./task-artifact-resolver";
import {
	type CandidateBackfillInput,
	backfillVulnerabilityCandidatesFromTasksWithDeps,
} from "./candidate-backfill";
import {
	CANDIDATE_PRODUCER_STAGE_NAMES,
	type PersistedVulnerabilityCandidateInput,
	syncVulnerabilityCandidatesFromMessageWithDeps,
} from "./candidate-sync";

export { CANDIDATE_PRODUCER_STAGE_NAMES } from "./candidate-sync";

const normalizeCandidateTags = (tags: string[]) =>
	[
		...new Set(
			tags
				.map((tag) => tag.trim())
				.filter(Boolean)
				.map((tag) => tag.slice(0, 64)),
		),
	].slice(0, 50);

const normalizeCandidateNote = (note: string | null | undefined) =>
	(note || "").slice(0, 10000);

const candidateMetadataKey = (
	scanJobId: string,
	vulnerabilityCandidateId: string,
) => `${scanJobId}\n${vulnerabilityCandidateId}`;

export type CandidateSyncTransaction = Pick<
	typeof db,
	"select" | "insert" | "delete"
>;

const listCandidateMetadataByIds = async (
	candidates: Array<{ scanJobId: string; vulnerabilityCandidateId: string }>,
) => {
	const ids = [
		...new Set(
			candidates
				.map((candidate) => candidate.vulnerabilityCandidateId)
				.filter(Boolean),
		),
	];
	const scanJobIds = [
		...new Set(
			candidates.map((candidate) => candidate.scanJobId).filter(Boolean),
		),
	];
	if (ids.length === 0 || scanJobIds.length === 0) {
		return new Map<string, typeof candidateMetadata.$inferSelect>();
	}

	const rows = await db
		.select()
		.from(candidateMetadata)
		.where(
			and(
				inArray(candidateMetadata.vulnerabilityCandidateId, ids),
				inArray(candidateMetadata.scanJobId, scanJobIds),
			),
		);

	return new Map(
		rows.map((row) => [
			candidateMetadataKey(row.scanJobId, row.vulnerabilityCandidateId),
			row,
		]),
	);
};

export const toCandidateRecord = (
	row: typeof vulnerabilityCandidates.$inferSelect,
	metadata?: typeof candidateMetadata.$inferSelect,
): VulnerabilityCandidate => ({
	vulnerabilityCandidateId: row.vulnerabilityCandidateId,
	scanJobId: row.scanJobId,
	producerTaskId: row.producerTaskId,
	messageId: row.messageId ?? null,
	producerStageName: row.producerStageName,
	functionId: row.functionId,
	title: row.title,
	description: row.description,
	filePath: row.filePath,
	line: row.line,
	vulnerabilityType: row.vulnerabilityType,
	confidence: row.confidence,
	score: row.score,
	targetId: row.targetId,
	targetKind: row.targetKind,
	claim: row.claim,
	rootCauseKey: row.rootCauseKey,
	evidence: (Array.isArray(row.evidence) ? row.evidence : []) as Evidence[],
	attackerControl: row.attackerControl,
	affectedSink: row.affectedSink,
	preconditions: Array.isArray(row.preconditions) ? row.preconditions : [],
	quickDisproofAttempt: row.quickDisproofAttempt,
	needsFuzzing: row.needsFuzzing,
	needsManualAnalysis: row.needsManualAnalysis,
	note: metadata?.note ?? "",
	tags: Array.isArray(metadata?.tags) ? metadata.tags : [],
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const withCandidateMetadata = async <
	TCandidate extends {
		scanJobId: string;
		vulnerabilityCandidateId: string;
	},
>(
	candidates: TCandidate[],
) => {
	const metadataById = await listCandidateMetadataByIds(candidates);
	return candidates.map((candidate) => ({
		...candidate,
		note:
			metadataById.get(
				candidateMetadataKey(
					candidate.scanJobId,
					candidate.vulnerabilityCandidateId,
				),
			)?.note ?? "",
		tags:
			metadataById.get(
				candidateMetadataKey(
					candidate.scanJobId,
					candidate.vulnerabilityCandidateId,
				),
			)?.tags ?? [],
	}));
};

export const upsertVulnerabilityCandidatesRepo = async (
	candidates: PersistedVulnerabilityCandidateInput[],
	executor: CandidateSyncTransaction = db,
) => {
	if (candidates.length === 0) {
		return;
	}
	await executor
		.insert(vulnerabilityCandidates)
		.values(
			candidates.map((candidate) => ({
				...candidate,
				producerStageName: candidate.producerStageName,
			})),
		)
		.onConflictDoUpdate({
			target: [
				vulnerabilityCandidates.scanJobId,
				vulnerabilityCandidates.vulnerabilityCandidateId,
			],
			set: {
				producerTaskId: sql`excluded."producerTaskId"`,
				messageId: sql`excluded."messageId"`,
				producerStageName: sql`excluded."producerStageName"`,
				functionId: sql`excluded."functionId"`,
				title: sql`excluded."title"`,
				description: sql`excluded."description"`,
				filePath: sql`excluded."filePath"`,
				line: sql`excluded."line"`,
				vulnerabilityType: sql`excluded."vulnerabilityType"`,
				confidence: sql`excluded."confidence"`,
				score: sql`excluded."score"`,
				targetId: sql`excluded."targetId"`,
				targetKind: sql`excluded."targetKind"`,
				claim: sql`excluded."claim"`,
				rootCauseKey: sql`excluded."rootCauseKey"`,
				evidence: sql`excluded."evidence"`,
				attackerControl: sql`excluded."attackerControl"`,
				affectedSink: sql`excluded."affectedSink"`,
				preconditions: sql`excluded."preconditions"`,
				quickDisproofAttempt: sql`excluded."quickDisproofAttempt"`,
				needsFuzzing: sql`excluded."needsFuzzing"`,
				needsManualAnalysis: sql`excluded."needsManualAnalysis"`,
				updatedAt: sql`excluded."updatedAt"`,
			},
		});
};

export const deleteStaleVulnerabilityCandidatesForMessageRepo = async (
	input: {
		producerTaskId: string;
		messageId: string;
		keepCandidateIds: string[];
	},
	executor: CandidateSyncTransaction = db,
) => {
	const uniqueIds = [...new Set(input.keepCandidateIds)];
	const conditions = [
		eq(vulnerabilityCandidates.producerTaskId, input.producerTaskId),
		eq(vulnerabilityCandidates.messageId, input.messageId),
	];
	if (uniqueIds.length > 0) {
		conditions.push(
			notInArray(vulnerabilityCandidates.vulnerabilityCandidateId, uniqueIds),
		);
	}
	await executor.delete(vulnerabilityCandidates).where(and(...conditions));
};

const candidateSyncDeps = (executor: CandidateSyncTransaction) => ({
	findTaskById: async (id: string) =>
		await executor
			.select()
			.from(tasks)
			.where(eq(tasks.taskId, id))
			.limit(1)
			.then((rows) => {
				const task = rows[0];
				if (!task) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Task not found",
					});
				}
				return task;
			}),
	readTaskJsonArtifact: readTaskJsonArtifactForTask,
	upsertCandidates: async (candidates: PersistedVulnerabilityCandidateInput[]) =>
		await upsertVulnerabilityCandidatesRepo(candidates, executor),
	deleteStaleCandidatesForMessage: async (input: {
		producerTaskId: string;
		messageId: string;
		keepCandidateIds: string[];
	}) => await deleteStaleVulnerabilityCandidatesForMessageRepo(input, executor),
});

export const syncVulnerabilityCandidatesFromMessage = async (
	input: {
		taskId: string;
		messageId: string;
		output: unknown;
	},
	executor: CandidateSyncTransaction = db,
) =>
	await syncVulnerabilityCandidatesFromMessageWithDeps(
		input,
		candidateSyncDeps(executor),
	);

export const syncVulnerabilityCandidatesFromProducerTask = async (
	taskId: string,
	executor: CandidateSyncTransaction = db,
) => {
	const outputs = await executor
		.select({
			messageId: messages.messageId,
			output: messages.payload,
		})
		.from(messages)
		.where(eq(messages.sourceTaskId, taskId))
		.orderBy(asc(messages.sequence));
	let synced = 0;
	for (const output of outputs) {
		const result = await syncVulnerabilityCandidatesFromMessage(
			{
				taskId,
				messageId: output.messageId,
				output: output.output,
			},
			executor,
		);
		synced += result.synced;
	}
	return { synced };
};

export const backfillVulnerabilityCandidatesFromTasks = async (
	input?: CandidateBackfillInput,
) => {
	const conditions = [
		inArray(tasks.stageName, [...CANDIDATE_PRODUCER_STAGE_NAMES]),
		input?.scanJobId ? eq(tasks.scanJobId, input.scanJobId) : undefined,
	].filter(Boolean);
	return await backfillVulnerabilityCandidatesFromTasksWithDeps(
		input,
		{
			listProducerTaskIds: async () =>
				await db
					.select({
						taskId: tasks.taskId,
					})
					.from(tasks)
					.where(and(...conditions))
					.orderBy(asc(tasks.createdAt))
					.then((rows) => rows.map((row) => row.taskId)),
			syncProducerTask: syncVulnerabilityCandidatesFromProducerTask,
		},
		CANDIDATE_PRODUCER_STAGE_NAMES,
	);
};

export const findVulnerabilityCandidatesByScanJobIdRepo = async (
	scanJobId: string,
) => {
	const rows = await db
		.select()
		.from(vulnerabilityCandidates)
		.where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
		.orderBy(desc(vulnerabilityCandidates.createdAt));
	const metadataById = await listCandidateMetadataByIds(rows);
	return rows.map((row) =>
		toCandidateRecord(
			row,
			metadataById.get(
				candidateMetadataKey(row.scanJobId, row.vulnerabilityCandidateId),
			),
		),
	);
};

export const findVulnerabilityCandidateByIdAndScanJobIdRepo = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	producerTaskId?: string;
}) => {
	const conditions = [
		eq(vulnerabilityCandidates.scanJobId, input.scanJobId),
		eq(
			vulnerabilityCandidates.vulnerabilityCandidateId,
			input.vulnerabilityCandidateId,
		),
		input.producerTaskId
			? eq(vulnerabilityCandidates.producerTaskId, input.producerTaskId)
			: undefined,
	].filter(Boolean);
	const row = await db
		.select()
		.from(vulnerabilityCandidates)
		.where(and(...conditions))
		.limit(1)
		.then((rows) => rows[0] || null);
	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Vulnerability candidate not found",
		});
	}
	const [candidate] = await withCandidateMetadata([toCandidateRecord(row)]);
	if (!candidate) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Vulnerability candidate not found",
		});
	}
	return candidate;
};

export const findVulnerabilityCandidateByIdRepo = async (
	vulnerabilityCandidateId: string,
) => {
	const row = await db
		.select()
		.from(vulnerabilityCandidates)
		.where(
			eq(
				vulnerabilityCandidates.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);
	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Vulnerability candidate not found",
		});
	}
	const [candidate] = await withCandidateMetadata([toCandidateRecord(row)]);
	if (!candidate) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Vulnerability candidate not found",
		});
	}
	return candidate;
};

export const listCandidateTagsRepo = async () =>
	await db
		.select({
			name: candidateTags.name,
		})
		.from(candidateTags)
		.orderBy(asc(candidateTags.name))
		.then((rows) => rows.map((row) => row.name));

export const updateVulnerabilityCandidateMetadataRepo = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	note: string;
	tags: string[];
}) => {
	const now = new Date().toISOString();
	const note = normalizeCandidateNote(input.note);
	const tags = normalizeCandidateTags(input.tags);
	await Promise.all(
		tags.map((name) =>
			db
				.insert(candidateTags)
				.values({
					name,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: candidateTags.name,
					set: {
						updatedAt: now,
					},
				}),
		),
	);

	const [metadata] = await db
		.insert(candidateMetadata)
		.values({
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			scanJobId: input.scanJobId,
			note,
			tags,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				candidateMetadata.scanJobId,
				candidateMetadata.vulnerabilityCandidateId,
			],
			set: {
				note,
				tags,
				updatedAt: now,
			},
		})
		.returning();

	return {
		note: metadata?.note ?? note,
		tags: metadata?.tags ?? tags,
	};
};
