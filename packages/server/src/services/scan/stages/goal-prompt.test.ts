import assert from "node:assert/strict";
import test from "node:test";
import {
	buildHuntGoalPrompt,
	buildSurfacePlannerGoalPrompt,
	buildSurfacePlannerTurnPrompt,
	isSurfaceGoalReentry,
} from "./goal-prompt";

test("buildHuntGoalPrompt renders only the durable goal and assigned scope", () => {
	const prompt = buildHuntGoalPrompt({
		goalSpec: {
			title: "Remote command execution",
			successCriteria: "A pre-auth attacker reaches a command sink",
			attackerModel: "Unauthenticated remote user",
			nonGoals: ["Local-only crashes"],
			stopCondition: "One evidenced candidate or justified exhaustion",
			persistenceLanguage: "No bugs found is intermediate; change method.",
			goalPrompt: "must not be copied",
		},
		huntGoal: {
			title: "Request parser boundary",
			scopeStatement: "HTTP request parsing and normalization",
			focusPaths: ["src/http", "src/parser.ts"],
			objective: "must not be copied",
		},
	});

	assert.ok(prompt.startsWith("/goal "));
	assert.match(prompt, /Success criteria: A pre-auth attacker reaches a command sink/);
	assert.match(prompt, /Scope: HTTP request parsing and normalization/);
	assert.match(prompt, /- src\/http/);
	assert.doesNotMatch(prompt, /goalPrompt/);
	assert.doesNotMatch(prompt, /objective/);
	assert.doesNotMatch(prompt, /Structured JSON output requirement/);
	assert.ok(prompt.length < 4000);
});

test("Surface gets one native goal and ordinary feedback turns", () => {
	const initial = buildSurfacePlannerGoalPrompt({
		surfaceGuidance: "Prefer distinct trust boundaries.",
	});
	assert.ok(initial.startsWith("/goal "));
	assert.match(initial, /Prefer distinct trust boundaries/);
	assert.ok(initial.length < 4000);

	const turn = buildSurfacePlannerTurnPrompt({
		prompt: "Emit the next SurfaceDispatch.",
		feedback: {
			kind: "judge-reject",
			summary: "The candidate needed local access.",
		},
	});
	assert.doesNotMatch(turn, /^\/goal\s/);
	assert.match(turn, /The candidate needed local access/);
	assert.equal(isSurfaceGoalReentry({ feedback: null }), false);
	assert.equal(isSurfaceGoalReentry({ feedback: { kind: "judge-reject" } }), true);
});
