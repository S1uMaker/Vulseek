export type PipelineTaskUpdate = {
	status?:
		| "pending"
		| "launching"
		| "launched"
		| "starting"
		| "running"
		| "completed"
		| "failed"
		| "exited"
		| "canceled";
	errorMessage?: string;
	containerName?: string;
	threadId?: string;
};

export const buildPipelineTaskUpdatePatch = (
	patch: PipelineTaskUpdate,
	now = new Date().toISOString(),
) => ({
	...(patch.containerName ? { containerName: patch.containerName } : {}),
	...(patch.threadId ? { threadId: patch.threadId } : {}),
	...(patch.status
		? {
				status: patch.status,
				errorMessage: patch.errorMessage,
				...(["launching", "launched", "starting", "running"].includes(
					patch.status,
				)
					? { startedAt: now, completedAt: null }
					: {}),
				...(["completed", "failed", "exited", "canceled"].includes(
					patch.status,
				)
					? { completedAt: now }
					: {}),
			}
		: {}),
});
