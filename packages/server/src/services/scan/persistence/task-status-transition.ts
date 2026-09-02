import type { taskStatusEnum, tasks } from "@vulseek/server/db/schema";

type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
type TaskPatch = Partial<typeof tasks.$inferSelect>;

export const buildTaskStatusTransitionPatch = (input: {
	to: TaskStatus;
	now: string;
	patch?: TaskPatch;
	terminalRouteKey?: string | null;
}): TaskPatch => ({
	...input.patch,
	status: input.to,
	updatedAt: input.now,
	...(input.to === "launching" ||
	input.to === "launched" ||
	input.to === "starting" ||
	input.to === "running"
		? { startedAt: input.now, completedAt: null }
		: {}),
	...(input.to === "completed" ||
	input.to === "failed" ||
	input.to === "exited" ||
	input.to === "canceled"
		? { completedAt: input.now }
		: {}),
});
