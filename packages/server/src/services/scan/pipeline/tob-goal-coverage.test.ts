import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	collectDispatchedHuntGoalIds,
	emptySurfaceCoverage,
	ensureSurfaceCoverageFile,
	filterNewHuntInputs,
	huntGoalDispatchKey,
	readHuntGoalId,
	SURFACE_COVERAGE_FILE_NAME,
	surfaceCoverageContainerPath,
} from "./tob-goal-coverage";

test("collects dispatched huntGoalIds from hunt task inputs", () => {
	assert.deepEqual(
		collectDispatchedHuntGoalIds([
			{ input: { huntGoal: { huntGoalId: "hg-xmlrpc" } } },
			{ input: { huntGoal: { huntGoalId: "hg-rest-api" } } },
			{ input: { huntGoal: { huntGoalId: "hg-xmlrpc" } } },
			{ input: { huntGoal: {} } },
		]),
		["hg-rest-api", "hg-xmlrpc"],
	);
});

test("filters already dispatched and duplicate hunt inputs", () => {
	const next = filterNewHuntInputs(
		[
			{ huntGoal: { huntGoalId: "hg-xmlrpc" } },
			{ huntGoal: { huntGoalId: "hg-oembed-proxy" } },
			{ huntGoal: { huntGoalId: "hg-oembed-proxy" } },
			{ huntGoal: { title: "missing id" } },
		],
		["hg-xmlrpc"],
	);
	assert.deepEqual(next, [{ huntGoal: { huntGoalId: "hg-oembed-proxy" } }]);
	assert.equal(readHuntGoalId(next[0]), "hg-oembed-proxy");
	assert.equal(
		huntGoalDispatchKey("job-1", "hg-oembed-proxy"),
		"job-1:goal-hunt:hg-oembed-proxy",
	);
});

test("creates the coverage file in the lane directory", async () => {
	const laneDir = await mkdtemp(path.join(tmpdir(), "surface-coverage-"));
	const laneFile = await ensureSurfaceCoverageFile(laneDir);
	assert.equal(path.basename(laneFile), SURFACE_COVERAGE_FILE_NAME);
	assert.equal(path.dirname(laneFile), laneDir);
	assert.deepEqual(
		JSON.parse(await readFile(laneFile, "utf-8")),
		emptySurfaceCoverage(),
	);
	assert.equal(
		surfaceCoverageContainerPath(
			"/scan-context/projects/p/profiles/s/jobs/j/scanning/full_scan/stages/goal-surface/lanes/lane-0",
		),
		"/scan-context/projects/p/profiles/s/jobs/j/scanning/full_scan/stages/goal-surface/lanes/lane-0/surface-coverage.json",
	);
});
