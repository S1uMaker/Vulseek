import { describe, expect, it } from "vitest";
import { buildTaskQueueMetrics } from "../../components/dashboard/scanning/task-queue-metrics";

describe("buildTaskQueueMetrics", () => {
	it("uses the pipeline concurrency after runtime data was split", () => {
		expect(
			buildTaskQueueMetrics(
				{
					queuedMessageCount: 10,
					processedMessageCount: 3,
					runningCount: 4,
					startingCount: 0,
					completedCount: 2,
				},
				4,
			),
		).toEqual({
			queuedMessages: 10,
			runningTasks: 4,
			completedTasks: 2,
			processedMessages: 3,
			concurrencyLimit: 4,
			queued: 10,
			running: 4,
			done: 2,
		});
	});

	it("prefers the queue's profile concurrency over the pipeline graph fallback", () => {
		expect(
			buildTaskQueueMetrics(
				{
					queuedMessageCount: 1,
					processedMessageCount: 0,
					runningCount: 3,
					startingCount: 1,
					completedCount: 0,
					concurrencyLimit: 8,
				},
				1,
			),
		).toMatchObject({
			runningTasks: 4,
			concurrencyLimit: 8,
			running: 4,
		});
	});
});
