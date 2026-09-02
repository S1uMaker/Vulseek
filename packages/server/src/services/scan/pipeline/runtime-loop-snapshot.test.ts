import assert from "node:assert/strict";
import test from "node:test";
import {
	getLaunchablePendingStageNames,
	getPollableStageNames,
	groupActiveTasksByStage,
	type RuntimeLoopSnapshot,
} from "./runtime-loop-snapshot";

const snapshot = (
	input: Partial<RuntimeLoopSnapshot>,
): RuntimeLoopSnapshot => ({
	status: "running",
	activeCountByStage: new Map(),
	activeTasksByStage: new Map(),
	pendingTargets: [],
	pendingTaskMetadata: [],
	pendingMessageCountBySourceStage: new Map(),
	stagePolicies: new Map(),
	statusCounts: [],
	...input,
});

test("does not poll stages without pending Messages", () => {
	assert.deepEqual(
		getPollableStageNames(
			snapshot({
				stagePolicies: new Map([
					["hunter", { stageName: "hunter", disabled: false, concurrency: 8 }],
				]),
			}),
		),
		[],
	);
});

test("launches pending database tasks even when Redis has no Messages", () => {
	assert.deepEqual(
		getLaunchablePendingStageNames(
			snapshot({
				pendingTargets: [
					{
						taskId: "orch-root",
						stageName: "orchestrator",
						groupInstanceId: null,
					},
				],
				stagePolicies: new Map([
					[
						"orchestrator",
						{
							stageName: "orchestrator",
							disabled: false,
							concurrency: 1,
						},
					],
					[
						"hunter",
						{ stageName: "hunter", disabled: false, concurrency: 8 },
					],
				]),
			}),
		),
		["orchestrator"],
	);
});

test("polls stages with pending Messages and available concurrency", () => {
	assert.deepEqual(
		getPollableStageNames(
			snapshot({
				activeCountByStage: new Map([
					["hunter", 1],
					["orchestrator", 1],
				]),
				pendingMessageCountBySourceStage: new Map([
					["hunter", 4],
					["orchestrator", 2],
				]),
				stagePolicies: new Map([
					["hunter", { stageName: "hunter", disabled: false, concurrency: 8 }],
					["orchestrator", { stageName: "orchestrator", disabled: false, concurrency: 1 }],
					["verify-finding", { stageName: "verify-finding", disabled: false, concurrency: 1 }],
				]),
			}),
		),
		["hunter"],
	);
});

test("groups active tasks with one database result", () => {
	const grouped = groupActiveTasksByStage([
		{ taskId: "one", stageName: "research-scope" },
		{ taskId: "two", stageName: "research-scope" },
		{ taskId: "three", stageName: "track-review" },
	]);

	assert.deepEqual(
		[...grouped.entries()].map(([stageName, tasks]) => [
			stageName,
			tasks.map((task) => task.taskId),
		]),
		[
			["research-scope", ["one", "two"]],
			["track-review", ["three"]],
		],
	);
});
