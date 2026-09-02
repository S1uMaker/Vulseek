import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveStageContainerNameParts,
	resolveStageReuseContainer,
} from "./generic-agent-container";

test("shared goal sessions reuse the configured container and omit task suffixes", () => {
	assert.equal(resolveStageReuseContainer("goal-surface", false, true, "shared"), true);
	assert.deepEqual(
		resolveStageContainerNameParts("task-1", ["lane"], true),
		["lane"],
	);
});

test("per-task goal sessions honor configured container reuse", () => {
	assert.equal(
		resolveStageReuseContainer("goal-hunt", true, true, "per-task"),
		true,
	);
	assert.deepEqual(resolveStageContainerNameParts("task-1", [], true), []);
	assert.equal(
		resolveStageReuseContainer("goal-hunt", false, true, "per-task"),
		false,
	);
	assert.deepEqual(resolveStageContainerNameParts("task-1", [], false), [
		"task-1",
	]);
});
