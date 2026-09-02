import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	type TobGoalCandidateContent,
	tobGoalCandidates,
} from "../../../db/schema/tob-goal";

const now = () => new Date().toISOString();

export const upsertTobGoalCandidateRepo = async (input: {
	scanJobId: string;
	candidateId: string;
	huntGoalId: string;
	huntTaskId?: string | null;
	messageId?: string | null;
	status?: string;
	title: string;
	summary?: string;
	content: TobGoalCandidateContent;
}) => {
	const updatedAt = now();
	const [row] = await db
		.insert(tobGoalCandidates)
		.values({
			scanJobId: input.scanJobId,
			candidateId: input.candidateId,
			huntGoalId: input.huntGoalId,
			huntTaskId: input.huntTaskId ?? null,
			messageId: input.messageId ?? null,
			status: input.status ?? "discovered",
			title: input.title,
			summary: input.summary ?? "",
			content: input.content,
			createdAt: updatedAt,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: [tobGoalCandidates.scanJobId, tobGoalCandidates.candidateId],
			set: {
				huntGoalId: input.huntGoalId,
				huntTaskId: input.huntTaskId ?? null,
				messageId: input.messageId ?? null,
				status: input.status ?? "discovered",
				title: input.title,
				summary: input.summary ?? "",
				content: input.content,
				updatedAt,
			},
		})
		.returning();
	return row;
};

export const updateTobGoalCandidateStatusRepo = async (input: {
	scanJobId: string;
	candidateId: string;
	status: string;
}) => {
	const [row] = await db
		.update(tobGoalCandidates)
		.set({ status: input.status, updatedAt: now() })
		.where(
			and(
				eq(tobGoalCandidates.scanJobId, input.scanJobId),
				eq(tobGoalCandidates.candidateId, input.candidateId),
			),
		)
		.returning();
	return row ?? null;
};

export const listTobGoalCandidatesByScanJobIdRepo = async (scanJobId: string) =>
	db
		.select()
		.from(tobGoalCandidates)
		.where(eq(tobGoalCandidates.scanJobId, scanJobId))
		.orderBy(desc(tobGoalCandidates.updatedAt));

export const findTobGoalCandidateRepo = async (input: {
	scanJobId: string;
	candidateId: string;
}) => {
	const [row] = await db
		.select()
		.from(tobGoalCandidates)
		.where(
			and(
				eq(tobGoalCandidates.scanJobId, input.scanJobId),
				eq(tobGoalCandidates.candidateId, input.candidateId),
			),
		)
		.limit(1);
	return row ?? null;
};
