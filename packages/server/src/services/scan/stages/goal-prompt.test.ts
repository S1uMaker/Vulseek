import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSurfacePlannerTurnPrompt,
	isNativeGoalPrompt,
	prefixNativeGoal,
	resolveGoalStagePrompt,
} from "./goal-prompt";

const surfacePrompt = [
	"Use /task/inputs/goal-spec.json as the durable GoalSpec lens.",
	"Dispatch unexplored high-value surfaces. Do not hunt.",
].join("\n");

test("goal stages send the rendered stage prompt without a /goal prefix", () => {
	const prompt = resolveGoalStagePrompt({
		renderedPrompt: surfacePrompt,
		stageInput: { feedback: null },
		sharedSession: true,
	});

	assert.equal(prompt, surfacePrompt);
	assert.equal(isNativeGoalPrompt(prompt), false);
	assert.doesNotMatch(prompt, /Success criteria:/);
	assert.doesNotMatch(prompt, /objective/);
	assert.doesNotMatch(prompt, /Use the installed skills/);
	assert.doesNotMatch(prompt, /output-validator/);
});

test("goal stage prompts preserve long rendered prompts", () => {
	const longPrompt = `${"Inspect this repository carefully. ".repeat(300)}final requirement`;

	assert.equal(
		resolveGoalStagePrompt({
			renderedPrompt: longPrompt,
			stageInput: {},
		}),
		longPrompt,
	);
	assert.equal(prefixNativeGoal(longPrompt), `/goal ${longPrompt}`);
});

test("prefixNativeGoal does not double the /goal marker", () => {
	assert.equal(prefixNativeGoal("/goal already set"), "/goal already set");
});

test("Surface re-entry is a continuation, not a new /goal", () => {
	const turn = resolveGoalStagePrompt({
		renderedPrompt: surfacePrompt,
		stageInput: {
			feedback: {
				kind: "judge-reject",
				huntGoalId: "hg-xmlrpc",
				summary: "The candidate needed local access.",
				payload: {
					judgeDecision: "rejected",
					judgeReasons: ["The candidate needed local access."],
				},
			},
		},
		sharedSession: true,
		reentry: true,
	});

	assert.equal(isNativeGoalPrompt(turn), false);
	assert.match(turn, /The candidate needed local access/);
	assert.match(turn, /hg-xmlrpc/);
	assert.doesNotMatch(turn, /Continue the standing planner goal/);
	assert.doesNotMatch(turn, /Emit the next SurfaceDispatch/);
	assert.doesNotMatch(turn, /^\/goal\s/);
	assert.doesNotMatch(
		buildSurfacePlannerTurnPrompt({
			feedback: { kind: "judge-reject", summary: "covered" },
		}),
		/^\/goal\s/,
	);
});

test("orch-hunt string feedback is a continuation turn, not a new standing prompt", () => {
	const hunterFeedback =
		"Scoped audit found one confirmed high-impact candidate: unauthenticated system.multicall is registered in wp-includes/IXR/class-IXR-server.php.";
	const turn = resolveGoalStagePrompt({
		renderedPrompt: [
			"You are the Orchestrator for a high-severity vulnerability research scan.",
			"Dispatch huntTasks. Do not hunt yourself.",
		].join("\n"),
		stageInput: { feedback: hunterFeedback, repositoryPath: "/workspace/repo" },
		sharedSession: true,
		reentry: true,
	});

	assert.equal(isNativeGoalPrompt(turn), false);
	assert.match(turn, /system\.multicall/);
	assert.doesNotMatch(turn, /You are the Orchestrator/);
	assert.doesNotMatch(turn, /^\/goal\s/);
	assert.equal(
		buildSurfacePlannerTurnPrompt({ feedback: hunterFeedback }),
		hunterFeedback,
	);
});

test("shared session without lane initialGoalPrompt keeps the standing prompt", () => {
	const hunterFeedback = "FAMILY F5: unauthenticated system.multicall.";
	const prompt = resolveGoalStagePrompt({
		renderedPrompt: surfacePrompt,
		stageInput: { feedback: hunterFeedback },
		sharedSession: true,
		reentry: false,
	});
	assert.equal(prompt, surfacePrompt);
	assert.doesNotMatch(prompt, /system\.multicall/);
});
