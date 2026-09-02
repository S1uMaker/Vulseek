import { db } from "@vulseek/server/db";
import { scanJobs, messages, tasks } from "@vulseek/server/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { resolveTerminalScanJobStatus } from "../state/scan-state-machine";
import { closeOpenMessagesForJobRepo } from "./message.repo";
import { computeScanJobSettlement } from "./message-store";

export type ScanJobSettlement = {
	rootTerminal: boolean;
	rootFailed: boolean;
	openTaskCount: number;
	unsettledDispatchCount: number;
	failedNonRootTaskCount: number;
};

export { computeScanJobSettlement };

export const getScanJobSettlementRepo = async (
	scanJobId: string,
): Promise<ScanJobSettlement> => {
	const [row] = await db
		.select({
			rootCount: sql<number>`count(*) filter (
				where ${tasks.sourceMessageId} is null
			)`,
			rootTerminalCount: sql<number>`count(*) filter (
				where ${tasks.sourceMessageId} is null
				and ${tasks.status} in ('completed', 'failed', 'exited', 'canceled')
			)`,
			rootFailedCount: sql<number>`count(*) filter (
				where ${tasks.sourceMessageId} is null
				and ${tasks.status}::text in ('failed', 'exited')
			)`,
			openTaskCount: sql<number>`count(*) filter (
				where ${tasks.status} in ('pending', 'launching', 'launched', 'starting', 'running')
			)`,
			failedNonRootTaskCount: sql<number>`count(*) filter (
				where ${tasks.sourceMessageId} is not null
				and ${tasks.status}::text in ('failed', 'exited')
			)`,
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId));

	const [dispatchRow] = await db
		.select({
			unsettledDispatchCount: sql<number>`count(*) filter (
				where ${messages.status} in ('pending', 'processing')
			)`,
		})
		.from(messages)
		.innerJoin(tasks, eq(tasks.taskId, messages.sourceTaskId))
		.where(eq(tasks.scanJobId, scanJobId));

	const rootCount = Number(row?.rootCount ?? 0);
	return {
		rootTerminal:
			rootCount > 0 &&
			Number(row?.rootTerminalCount ?? 0) === rootCount &&
			Number(row?.openTaskCount ?? 0) === 0,
		rootFailed: Number(row?.rootFailedCount ?? 0) > 0,
		openTaskCount: Number(row?.openTaskCount ?? 0),
		unsettledDispatchCount: Number(dispatchRow?.unsettledDispatchCount ?? 0),
		failedNonRootTaskCount: Number(row?.failedNonRootTaskCount ?? 0),
	};
};

export const completeTerminalTaskDispatchesRepo = async (scanJobId: string) =>
	closeOpenMessagesForJobRepo(
		scanJobId,
		"Producer task or job is no longer running",
	);

export const settleScanJobRepo = async (scanJobId: string) => {
	const state = await getScanJobSettlementRepo(scanJobId);
	if (
		!state.rootTerminal ||
		state.openTaskCount > 0 ||
		state.unsettledDispatchCount > 0
	) {
		return { state, status: "not_ready" as const };
	}

	const transition = await db.transaction(async (tx) => {
		const [job] = await tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, scanJobId))
			.for("update")
			.limit(1);
		if (!job || job.status === "canceled") {
			return "terminal" as const;
		}
		if (job.status === "finalizing") {
			return "finalizing" as const;
		}
		if (
			job.status === "finished" ||
			job.status === "partially_finished" ||
			job.status === "failed"
		) {
			return "terminal" as const;
		}
		const [updated] = await tx
			.update(scanJobs)
			.set({ status: "finalizing" })
			.where(
				and(
					eq(scanJobs.scanJobId, scanJobId),
					inArray(scanJobs.status, ["pending", "running"]),
				),
			)
			.returning({ status: scanJobs.status });
		return updated ? ("finalizing" as const) : ("terminal" as const);
	});
	return { state, status: transition };
};

export const finalizeScanJobRepo = async (scanJobId: string) => {
	const state = await getScanJobSettlementRepo(scanJobId);
	if (
		!state.rootTerminal ||
		state.openTaskCount > 0 ||
		state.unsettledDispatchCount > 0
	) {
		return null;
	}
	const status = resolveTerminalScanJobStatus({
		rootFailed: state.rootFailed,
		failedTaskCount: state.failedNonRootTaskCount,
		canceled: false,
	});
	const [updated] = await db
		.update(scanJobs)
		.set({ status, finishedAt: new Date().toISOString() })
		.where(
			and(eq(scanJobs.scanJobId, scanJobId), eq(scanJobs.status, "finalizing")),
		)
		.returning({ status: scanJobs.status });
	return updated?.status ?? null;
};
