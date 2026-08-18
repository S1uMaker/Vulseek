import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveStageContainerNameParts,
	resolveStageReuseContainer,
} from "./generic-agent.stage";

test("shared goal sessions reuse the configured container and omit task suffixes", () => {
	assert.equal(resolveStageReuseContainer("goal-surface", false, true, "shared"), true);
	assert.deepEqual(
		resolveStageContainerNameParts("goal-surface", "task-1", ["lane"], true, "shared"),
		["lane"],
	);
});

test("per-task goal sessions remain isolated", () => {
	assert.equal(resolveStageReuseContainer("goal-hunt", true, true, "per-task"), false);
	assert.deepEqual(
		resolveStageContainerNameParts("goal-hunt", "task-1", [], true, "per-task"),
		["task-1"],
	);
});
