import { db } from "@vulseek/server/db";
import { researchFindings } from "@vulseek/server/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export const stampResearchFindingsMessageIdRepo = async (input: {
	scanJobId: string;
	producerTaskId: string;
	messageId: string;
}) => {
	const now = new Date().toISOString();
	const updated = await db
		.update(researchFindings)
		.set({
			messageId: input.messageId,
			updatedAt: now,
		})
		.where(
			and(
				eq(researchFindings.scanJobId, input.scanJobId),
				eq(researchFindings.producerTaskId, input.producerTaskId),
				isNull(researchFindings.messageId),
			),
		)
		.returning({ findingId: researchFindings.findingId });
	return updated.length;
};
