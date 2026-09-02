type QueueTaskCounts = {
	queuedMessageCount?: number | null;
	queuedCount?: number | null;
	pendingCount?: number | null;
	processedMessageCount?: number | null;
	runningCount?: number | null;
	startingCount?: number | null;
	completedCount: number;
	concurrencyLimit?: number | null;
};

export const buildTaskQueueMetrics = (
	queue: QueueTaskCounts,
	pipelineConcurrencyLimit?: number | null,
) => {
	const queuedMessages =
		queue.queuedMessageCount ?? queue.queuedCount ?? queue.pendingCount ?? 0;
	const runningTasks = (queue.runningCount ?? 0) + (queue.startingCount ?? 0);
	const completedTasks = queue.completedCount;
	const processedMessages = queue.processedMessageCount ?? 0;
	const concurrencyLimit = Math.max(
		1,
		Number(queue.concurrencyLimit ?? pipelineConcurrencyLimit ?? 1) || 1,
	);

	return {
		queuedMessages,
		runningTasks,
		completedTasks,
		processedMessages,
		concurrencyLimit,
		queued: queuedMessages,
		running: runningTasks,
		done: completedTasks,
	};
};
