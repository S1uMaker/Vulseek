import { describe, expect, test } from "vitest";
import {
	resolveStageContainerNameParts,
	resolveStageReuseContainer,
} from "../../../../packages/server/src/services/scan/stages/generic-agent.stage";

describe("Research task container isolation", () => {
	test("disables reuse for Research without changing Full or Delta behavior", () => {
		expect(resolveStageReuseContainer("research", true)).toBe(false);
		expect(resolveStageReuseContainer("full_scan", true)).toBe(true);
		expect(resolveStageReuseContainer("delta_scan", false)).toBe(false);
	});

	test("adds task identity to Research container names", () => {
		expect(
			resolveStageContainerNameParts("task-b", ["track-review"], false),
		).toEqual(["track-review", "task-b"]);
		expect(
			resolveStageContainerNameParts("task-b", ["track-review"], true),
		).toEqual(["track-review"]);
	});

	test("goal and per-task follow configured reuse instead of forcing isolation", () => {
		expect(resolveStageReuseContainer("custom-stage", true, true)).toBe(true);
		expect(
			resolveStageReuseContainer("hunter", true, true, "per-task"),
		).toBe(true);
		expect(
			resolveStageReuseContainer("hunter", false, true, "per-task"),
		).toBe(false);
		expect(resolveStageReuseContainer("goal-like-name", true, false)).toBe(true);
		expect(resolveStageContainerNameParts("task-c", [], true)).toEqual([]);
		expect(resolveStageContainerNameParts("task-c", [], false)).toEqual([
			"task-c",
		]);
	});
});
