import { db } from "@vulseek/server/db";
import { scanJobCostBackfills } from "@vulseek/server/db/schema";
import { eq, sql } from "drizzle-orm";

const BACKFILL_ID = "v2-task-cost-persistence";

export const backfillScanJobCosts = async () => {
	await db
		.insert(scanJobCostBackfills)
		.values({
			backfillId: BACKFILL_ID,
			status: "pending",
			updatedAt: new Date().toISOString(),
		})
		.onConflictDoNothing();

	const marker = await db
		.select()
		.from(scanJobCostBackfills)
		.where(eq(scanJobCostBackfills.backfillId, BACKFILL_ID))
		.limit(1)
		.then((rows) => rows[0]);
	if (!marker) {
		throw new Error("Scan job cost backfill marker is missing");
	}
	if (marker.status === "completed") {
		return marker;
	}

	await db.execute(sql`
		UPDATE scan_jobs
		SET estimated_cost = COALESCE(aggregates.estimated_cost, 0)
		FROM (
			SELECT "scanJobId", SUM(COALESCE(estimated_cost, 0)) AS estimated_cost
			FROM tasks
			GROUP BY "scanJobId"
		) AS aggregates
		WHERE scan_jobs."scanJobId" = aggregates."scanJobId"
	`);
	await db
		.update(scanJobCostBackfills)
		.set({
			status: "completed",
			processedCount: 0,
			skippedCount: 0,
			skippedTasks: [],
			updatedAt: new Date().toISOString(),
		})
		.where(eq(scanJobCostBackfills.backfillId, BACKFILL_ID));
	return {
		processedCount: 0,
		skippedCount: 0,
		skippedTasks: [] as Array<{ taskId: string; reason: string }>,
	};
};
