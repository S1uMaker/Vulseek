import assert from "node:assert/strict";
import test from "node:test";
import { createTaskIdForDispatchKey } from "../task-id";
import {
	getResearchRunningTaskPresentation,
	mapRunningTaskStage,
	RESEARCH_RUNNING_TASK_STAGES,
} from "../running-task-stage";
import { resolveLaunchDisposition } from "./launch-disposition";
import { buildResearchDispatchRetryPlan } from "./research-dispatch-recovery";
import {
	getPollableStageNames,
	type RuntimeLoopSnapshot,
} from "./runtime-loop-snapshot";

const RESEARCH_STAGE_NAMES = [...RESEARCH_RUNNING_TASK_STAGES];

const makeSnapshot = (
	input: Partial<RuntimeLoopSnapshot> = {},
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

test("recovers completed tasks with pending downstream dispatch without changing route or artifacts", () => {
	const completedPendingTask = {
		taskId: "task-track-review",
		stageName: "track-review",
		downstreamRouteKey: "finding-found",
		input: { trackKey: "track-authorization" },
		output: { findingIds: ["finding-1"] },
		status: "completed",
		downstreamDispatchStatus: "pending",
	};
	const duplicateTask = { ...completedPendingTask };
	const taskFromOldSnapshot = {
		...completedPendingTask,
		taskId: "task-old-snapshot",
		stageName: "removed-stage",
	};

	assert.equal(completedPendingTask.status, "completed");
	assert.equal(completedPendingTask.downstreamDispatchStatus, "pending");

	const plan = buildResearchDispatchRetryPlan(
		[completedPendingTask, duplicateTask, taskFromOldSnapshot],
		new Set(["track-review"]),
	);

	assert.deepEqual(
		plan.ready.map((task) => ({
			taskId: task.taskId,
			stageName: task.stageName,
			downstreamRouteKey: task.downstreamRouteKey,
		})),
		[
			{
				taskId: "task-track-review",
				stageName: "track-review",
				downstreamRouteKey: "finding-found",
			},
		],
	);
	assert.strictEqual(plan.ready[0]?.input, completedPendingTask.input);
	assert.strictEqual(plan.ready[0]?.output, completedPendingTask.output);
	assert.deepEqual(
		plan.skipped.map((task) => [task.taskId, task.stageName]),
		[
			["task-track-review", "track-review"],
			["task-old-snapshot", "removed-stage"],
		],
	);
});

test("pause and cancel races never proceed with a new task launch", () => {
	assert.equal(
		resolveLaunchDisposition({
			scanJobStatus: "paused",
			taskStatus: "pending",
		}),
		"defer",
	);
	assert.equal(
		resolveLaunchDisposition({
			scanJobStatus: "canceled",
			taskStatus: "pending",
		}),
		"cancel",
	);
	assert.equal(
		resolveLaunchDisposition({
			scanJobStatus: "paused",
			taskStatus: "canceled",
		}),
		"cancel",
	);
	assert.equal(
		resolveLaunchDisposition({
			scanJobStatus: "running",
			taskStatus: "canceled",
		}),
		"cancel",
	);
});

test("fan-out stages are pollable only below their concurrency limit", () => {
	const stageName = "vulnerability-discovery";
	const policy = {
		stageName,
		disabled: false,
		concurrency: 8,
	};
	const pendingTargets = Array.from({ length: 8 }, (_, index) => ({
		taskId: `discovery-${index}`,
		stageName,
		groupInstanceId: null,
	}));

	assert.deepEqual(
		getPollableStageNames(
			makeSnapshot({
				pendingTargets,
				pendingMessageCountBySourceStage: new Map([[stageName, 8]]),
				stagePolicies: new Map([[stageName, policy]]),
			}),
		),
		[stageName],
	);
	assert.deepEqual(
		getPollableStageNames(
			makeSnapshot({
				activeCountByStage: new Map([[stageName, 8]]),
				pendingTargets,
				pendingMessageCountBySourceStage: new Map([[stageName, 8]]),
				stagePolicies: new Map([[stageName, policy]]),
			}),
		),
		[],
	);
});

test("fan-out dispatch indexes produce stable, distinct task IDs across recovery", () => {
	const dispatchKey = (index: number) =>
		[
			"research-job",
			"track-review-task",
			"track-review-to-finding-validation",
			"finding-found",
			index,
		].join(":");
	const firstPass = [0, 1, 2, 3].map((index) =>
		createTaskIdForDispatchKey(dispatchKey(index)),
	);
	const recoveredPass = [0, 1, 2, 3].map((index) =>
		createTaskIdForDispatchKey(dispatchKey(index)),
	);

	assert.deepEqual(recoveredPass, firstPass);
	assert.equal(new Set(firstPass).size, 4);
});

test("zero pending tasks do not invoke any stage poll", () => {
	let pollCount = 0;
	const pollableStages = getPollableStageNames(
		makeSnapshot({
			stagePolicies: new Map(
				RESEARCH_STAGE_NAMES.map((stageName) => [
					stageName,
					{ stageName, disabled: false, concurrency: 1 },
				]),
			),
		}),
	);

	for (const _stageName of pollableStages) {
		pollCount += 1;
	}

	assert.deepEqual(pollableStages, []);
	assert.equal(pollCount, 0);
});

test("all twelve Research stages map to running task presentations", () => {
	assert.deepEqual(RESEARCH_STAGE_NAMES, [
		"research-scope",
		"surface-map",
		"track-plan",
		"vulnerability-discovery",
		"track-review",
		"finding-validation",
		"finding-review",
		"chain-synthesis",
		"chain-review",
		"exploit-validation",
		"exploit-review",
		"research-report",
	]);

	for (const stageName of RESEARCH_STAGE_NAMES) {
		assert.equal(mapRunningTaskStage(stageName), stageName);
		const presentation = getResearchRunningTaskPresentation(
			stageName,
			`Task for ${stageName}`,
		);
		assert.ok(presentation);
		assert.equal(presentation.title, `Task for ${stageName}`);
		assert.equal(presentation.stage, stageName);
		assert.ok(presentation.subtitle.length > 0);
	}

	assert.equal(mapRunningTaskStage("not-a-research-stage"), null);
});
