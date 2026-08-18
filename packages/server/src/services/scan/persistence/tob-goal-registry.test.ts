import assert from "node:assert/strict";
import test from "node:test";
import { resolvePersistCandidate } from "./tob-goal-persist";

const candidate = {
	candidateId: "c1",
	huntGoalId: "hg-1",
	title: "Example",
	description: "desc",
	location: { filePath: "a.php" },
	claim: "claim",
	rootCauseKey: "rk",
};

test("persist-candidate accepts Hunt output that only has candidate", () => {
	const resolved = resolvePersistCandidate({
		stageOutput: { candidate },
	});
	assert.equal(resolved.ok, true);
	if (resolved.ok) {
		assert.equal(resolved.candidateId, "c1");
		assert.equal(resolved.huntGoalId, "hg-1");
	}
});

test("persist-candidate still honors an explicit non-candidate outcome", () => {
	const resolved = resolvePersistCandidate({
		stageOutput: { outcome: "exhausted", candidate },
	});
	assert.deepEqual(resolved, { ok: false, reason: "not-candidate" });
});

test("persist-candidate can take huntGoalId from stage input", () => {
	const resolved = resolvePersistCandidate({
		stageOutput: {
			candidate: { ...candidate, huntGoalId: undefined },
		},
		stageInput: { huntGoal: { huntGoalId: "hg-from-input" } },
	});
	assert.equal(resolved.ok, true);
	if (resolved.ok) {
		assert.equal(resolved.huntGoalId, "hg-from-input");
	}
});
