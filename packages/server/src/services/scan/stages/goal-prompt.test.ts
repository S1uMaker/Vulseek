import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSurfacePlannerTurnPrompt,
	isNativeGoalPrompt,
	isSurfaceGoalReentry,
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
	assert.ok(prompt.length < 4000);
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
	});

	assert.equal(isNativeGoalPrompt(turn), false);
	assert.match(turn, /The candidate needed local access/);
	assert.match(turn, /hg-xmlrpc/);
	assert.doesNotMatch(turn, /Continue the standing planner goal/);
	assert.doesNotMatch(turn, /Emit the next SurfaceDispatch/);
	assert.doesNotMatch(turn, /^\/goal\s/);
	assert.equal(isSurfaceGoalReentry({ feedback: null }), false);
	assert.equal(
		isSurfaceGoalReentry({ feedback: { kind: "judge-reject" } }),
		true,
	);
	assert.doesNotMatch(
		buildSurfacePlannerTurnPrompt({
			feedback: { kind: "judge-reject", summary: "covered" },
		}),
		/^\/goal\s/,
	);
});
