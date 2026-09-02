import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	type TobGoalFindingContent,
	tobGoalFindings,
} from "../../../db/schema/tob-goal";

const now = () => new Date().toISOString();

export const upsertTobGoalFindingRepo = async (input: {
	scanJobId: string;
	findingId: string;
	sourceCandidateId: string;
	huntGoalId: string;
	messageId?: string | null;
	status?: string;
	title: string;
	summary?: string;
	content: TobGoalFindingContent;
	dedupRefs?: string[];
}) => {
	const updatedAt = now();
	const [row] = await db
		.insert(tobGoalFindings)
		.values({
			scanJobId: input.scanJobId,
			findingId: input.findingId,
			sourceCandidateId: input.sourceCandidateId,
			huntGoalId: input.huntGoalId,
			messageId: input.messageId ?? null,
			status: input.status ?? "novel",
			title: input.title,
			summary: input.summary ?? "",
			content: input.content,
			dedupRefs: input.dedupRefs ?? [],
			createdAt: updatedAt,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: [tobGoalFindings.scanJobId, tobGoalFindings.findingId],
			set: {
				sourceCandidateId: input.sourceCandidateId,
				huntGoalId: input.huntGoalId,
				messageId: input.messageId ?? null,
				status: input.status ?? "novel",
				title: input.title,
				summary: input.summary ?? "",
				content: input.content,
				dedupRefs: input.dedupRefs ?? [],
				updatedAt,
			},
		})
		.returning();
	return row;
};

export const listTobGoalFindingsByScanJobIdRepo = async (scanJobId: string) =>
	db
		.select()
		.from(tobGoalFindings)
		.where(eq(tobGoalFindings.scanJobId, scanJobId))
		.orderBy(desc(tobGoalFindings.updatedAt));

export const findTobGoalFindingRepo = async (input: {
	scanJobId: string;
	findingId: string;
}) => {
	const [row] = await db
		.select()
		.from(tobGoalFindings)
		.where(
			and(
				eq(tobGoalFindings.scanJobId, input.scanJobId),
				eq(tobGoalFindings.findingId, input.findingId),
			),
		)
		.limit(1);
	return row ?? null;
};
