export type PendingQueueTarget = {
	taskId: string;
	stageName: string;
	groupInstanceId: string | null;
};

export type StageRuntimePolicy = {
	stageName: string;
	disabled: boolean;
	concurrency: number;
};

export type RuntimeLoopSnapshot<
	TActiveTask = unknown,
	TPendingTask = unknown,
> = {
	status: string | null;
	activeCountByStage: Map<string, number>;
	activeTasksByStage: Map<string, TActiveTask[]>;
	pendingTargets: PendingQueueTarget[];
	pendingTaskMetadata: TPendingTask[];
	pendingMessageCountBySourceStage: Map<string, number>;
	stagePolicies: Map<string, StageRuntimePolicy>;
	statusCounts: Array<{ stageName: string; status: string; count: number }>;
};

const stageHasLaunchCapacity = (
	snapshot: RuntimeLoopSnapshot,
	policy: StageRuntimePolicy,
) =>
	(snapshot.activeCountByStage.get(policy.stageName) ?? 0) < policy.concurrency;

export const getPollableStageNames = (snapshot: RuntimeLoopSnapshot) =>
	[...snapshot.stagePolicies.values()]
		.filter((policy) => {
			if (policy.disabled) {
				return false;
			}
			if (
				(snapshot.pendingMessageCountBySourceStage.get(policy.stageName) ?? 0) <=
				0
			) {
				return false;
			}
			return stageHasLaunchCapacity(snapshot, policy);
		})
		.map((policy) => policy.stageName);

export const getLaunchablePendingStageNames = (snapshot: RuntimeLoopSnapshot) =>
	[...snapshot.stagePolicies.values()]
		.filter((policy) => {
			if (policy.disabled) {
				return false;
			}
			if (
				!snapshot.pendingTargets.some(
					(task) => task.stageName === policy.stageName,
				)
			) {
				return false;
			}
			return stageHasLaunchCapacity(snapshot, policy);
		})
		.map((policy) => policy.stageName);

export const groupActiveTasksByStage = <T extends { stageName: string }>(
	tasks: T[],
) => {
	const grouped = new Map<string, T[]>();
	for (const task of tasks) {
		const stageTasks = grouped.get(task.stageName) ?? [];
		stageTasks.push(task);
		grouped.set(task.stageName, stageTasks);
	}
	return grouped;
};
