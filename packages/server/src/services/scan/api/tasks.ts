import {
	bindTaskRuntimeRepo,
	cancelOpenTasksByScanJobIdRepo,
	countTasksByScanJobAndStatusRepo,
	countTasksByScanJobStageAndStatusRepo,
	createTaskRepo,
	findTaskByIdRepo,
	listChildTasksByParentTaskIdRepo,
	listTasksByScanJobAndStageRepo,
	listTasksByScanJobIdRepo,
	resetFailedTaskForRetryRepo,
	storeTaskInputRepo,
	storeMessageRepo,
	updateTaskRepo,
	updateTaskStatusRepo,
} from "../persistence/task.repo";
import type { Task } from "../types";

export const createTask = async (input: Parameters<typeof createTaskRepo>[0]) =>
	await createTaskRepo(input);

export const findTaskById = async (taskId: string) =>
	await findTaskByIdRepo(taskId);

export const findTasksByScanJobId = async (scanJobId: string) =>
	await listTasksByScanJobIdRepo(scanJobId);

export const findChildTasksByParentTaskId = async (parentTaskId: string) =>
	await listChildTasksByParentTaskIdRepo(parentTaskId);

export const findTasksByScanJobAndStage = async (input: {
	scanJobId: string;
	stageName: string;
}) => await listTasksByScanJobAndStageRepo(input);

export const updateTask = async (taskId: string, patch: Partial<Task>) =>
	await updateTaskRepo(taskId, patch);

export const updateTaskStatus = async (
	taskId: string,
	status:
		| "pending"
		| "launching"
		| "launched"
		| "starting"
		| "running"
		| "completed"
		| "failed"
		| "exited"
		| "canceled",
	errorMessage?: string | null,
) => await updateTaskStatusRepo({ taskId, status, errorMessage });

export const cancelOpenScanJobTasks = async (
	scanJobId: string,
	errorMessage?: string | null,
) => await cancelOpenTasksByScanJobIdRepo(scanJobId, errorMessage);

export const bindTaskRuntime = async (input: {
	taskId: string;
	containerName?: string | null;
	containerIndex?: number | null;
	threadId?: string | null;
	agentProfile?: Task["agentProfile"];
}) => await bindTaskRuntimeRepo(input);

export const storeTaskInput = async (taskId: string, input: unknown) =>
	await storeTaskInputRepo(taskId, input);

export const storeMessage = async (taskId: string, output: unknown) =>
	await storeMessageRepo(taskId, output);

export const resetFailedTaskForRetry = async (taskId: string) =>
	await resetFailedTaskForRetryRepo(taskId);

export const countTasksByScanJobAndStatus = async (scanJobId: string) =>
	await countTasksByScanJobAndStatusRepo(scanJobId);

export const countTasksByScanJobStageAndStatus = async (scanJobId: string) =>
	await countTasksByScanJobStageAndStatusRepo(scanJobId);
