import { describe, expect, it } from "vitest";
import { buildTaskStatusTransitionPatch } from "../../../../packages/server/src/services/scan/persistence/task-status-transition";

describe("task status transition patch", () => {
	it("marks completion without storing route or output on the task", () => {
		const patch = buildTaskStatusTransitionPatch({
			to: "completed",
			now: "2026-07-25T00:00:00.000Z",
			terminalRouteKey: "new-surface",
		});

		expect(patch).toMatchObject({
			status: "completed",
			completedAt: "2026-07-25T00:00:00.000Z",
		});
		expect(patch).not.toHaveProperty("downstreamRouteKey");
		expect(patch).not.toHaveProperty("output");
	});

	it("does not add a route to a failure transition", () => {
		const patch = buildTaskStatusTransitionPatch({
			to: "failed",
			now: "2026-07-25T00:00:00.000Z",
			terminalRouteKey: "new-surface",
		});

		expect(patch).not.toHaveProperty("downstreamRouteKey");
	});
});
