import { TRPCError } from "@trpc/server";
import type {
	ScanJob,
	Task,
} from "./types";

export const RETRYABLE_TASK_STAGE_NAMES = [
	"delta-scope",
	"repository-profile",
	"attack-surface-model",
	"identify-target",
	"scan-target",
	"analyze-finding",
	"critique-finding",
	"verify-finding",
	"triage-finding",
] as const;

export type RetryableTaskStageName =
	(typeof RETRYABLE_TASK_STAGE_NAMES)[number];

export type RetryFailedTasksByStage = Record<RetryableTaskStageName, number>;

export type RetryFailedTasksResult = {
	scanJobId: string;
	retriedTaskCount: number;
	retriedTasksByStage: RetryFailedTasksByStage;
};

type RetryFailedTasksDeps = {
	loadScanJob: (scanJobId: string) => Promise<ScanJob>;
	listTasks: (scanJobId: string) => Promise<Task[]>;
	clearTaskArtifacts: (scanJobId: string, task: Task) => Promise<void>;
	resetFailedTask: (taskId: string) => Promise<unknown>;
	resetScanJobForRetry: (input: { scanJobId: string }) => Promise<unknown>;
};

const RETRY_STAGE_ORDER: Record<RetryableTaskStageName, number> = {
	"delta-scope": 0,
	"repository-profile": 1,
	"attack-surface-model": 2,
	"identify-target": 3,
	"scan-target": 4,
	"analyze-finding": 5,
	"critique-finding": 6,
	"verify-finding": 7,
	"triage-finding": 8,
};

const createEmptyRetryCounts = (): RetryFailedTasksByStage => ({
	"delta-scope": 0,
	"repository-profile": 0,
	"attack-surface-model": 0,
	"identify-target": 0,
	"scan-target": 0,
	"analyze-finding": 0,
	"critique-finding": 0,
	"verify-finding": 0,
	"triage-finding": 0,
});

export const isRetryableTaskStageName = (
	stageName: Task["stageName"],
): stageName is RetryableTaskStageName =>
	RETRYABLE_TASK_STAGE_NAMES.includes(stageName as RetryableTaskStageName);

export const sortRetryableTasksForRetry = (tasks: Task[]) =>
	[...tasks].sort((left, right) => {
		const stageDiff =
			RETRY_STAGE_ORDER[left.stageName as RetryableTaskStageName] -
			RETRY_STAGE_ORDER[right.stageName as RetryableTaskStageName];
		if (stageDiff !== 0) {
			return stageDiff;
		}
		return left.createdAt.localeCompare(right.createdAt);
	});

export const retryFailedScanJobTasksWithDeps = async (
	scanJobId: string,
	deps: RetryFailedTasksDeps,
): Promise<RetryFailedTasksResult> => {
	const scanJob = await deps.loadScanJob(scanJobId);
	if (
		scanJob.status !== "finished" &&
		scanJob.status !== "partially_finished"
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only finished full scan jobs can retry failed tasks",
		});
	}

	const allTasks = await deps.listTasks(scanJobId);
	const runningTask = allTasks.find((task) => task.status === "running");
	if (runningTask) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Scan job is still running tasks",
		});
	}

	const failedTasks = sortRetryableTasksForRetry(
		allTasks.filter(
			(task) =>
				task.status === "failed" && isRetryableTaskStageName(task.stageName),
		),
	);
	if (failedTasks.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "No failed tasks to retry",
		});
	}

	const retriedTasksByStage = createEmptyRetryCounts();
	await deps.resetScanJobForRetry({
		scanJobId,
	});

	for (const task of failedTasks) {
		const stageName = task.stageName as RetryableTaskStageName;
		await deps.clearTaskArtifacts(scanJobId, task).catch(() => {});
		await deps.resetFailedTask(task.taskId);
		retriedTasksByStage[stageName] += 1;
	}

	return {
		scanJobId,
		retriedTaskCount: failedTasks.length,
		retriedTasksByStage,
	};
};
