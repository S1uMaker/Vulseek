import {
	mapRunningTaskStage,
	getResearchRunningTaskPresentation,
	getTobGoalRunningTaskPresentation,
	RESEARCH_RUNNING_TASK_STAGES,
	TOB_GOAL_RUNNING_TASK_STAGES,
	RUNNING_TASK_VIEW_STATUSES,
} from "@vulseek/server/services/scan/running-task-stage";
import { describe, expect, it } from "vitest";

describe("mapRunningTaskStage", () => {
	it("returns canonical stage IDs without aliases", () => {
		expect(mapRunningTaskStage("repository-profile")).toBe(
			"repository-profile",
		);
		expect(mapRunningTaskStage("identify-target")).toBe("identify-target");
		expect(mapRunningTaskStage("scan-target")).toBe("scan-target");
	});

	it("includes every Research Pipeline stage", () => {
		expect(RESEARCH_RUNNING_TASK_STAGES).toEqual([
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
		for (const stage of RESEARCH_RUNNING_TASK_STAGES) {
			expect(mapRunningTaskStage(stage)).toBe(stage);
		}
		expect(
			getResearchRunningTaskPresentation(
				"research-scope",
				"Research Scope: WordPress",
			),
		).toEqual({
			title: "Research Scope: WordPress",
			subtitle: "Research Scope",
			stage: "research-scope",
		});
		for (const stage of RESEARCH_RUNNING_TASK_STAGES) {
			expect(getResearchRunningTaskPresentation(stage, "Research task")).toEqual(
				{
					title: "Research task",
					subtitle: expect.any(String),
					stage,
				},
			);
		}
	});

	it("includes every tob-goal pipeline stage", () => {
		expect(TOB_GOAL_RUNNING_TASK_STAGES).toEqual([
			"goal-craft",
			"goal-surface",
			"goal-hunt",
			"goal-judge",
			"goal-dedup",
		]);
		for (const stage of TOB_GOAL_RUNNING_TASK_STAGES) {
			expect(mapRunningTaskStage(stage)).toBe(stage);
			expect(getTobGoalRunningTaskPresentation(stage, "Goal task")).toEqual({
				title: "Goal task",
				subtitle: expect.any(String),
				stage,
			});
		}
	});

	it("rejects legacy stage IDs", () => {
		for (const stageName of [
			"delta_scoping",
			"repository-scan",
			"repository_scanning",
			"attack_surface_modeling",
			"module-scan",
			"module_scanning",
			"function-scan",
			"function_scanning",
			"analyzing",
			"analysis-critic",
			"criticizing",
			"verifying",
			"triaging",
		]) {
			expect(mapRunningTaskStage(stageName)).toBeNull();
		}
	});

	it("includes every active task status in the running task view", () => {
		expect(RUNNING_TASK_VIEW_STATUSES).toEqual([
			"launching",
			"launched",
			"starting",
			"running",
		]);
	});

	it("includes orch-hunt stages", () => {
		expect(mapRunningTaskStage("orchestrator")).toBe("orchestrator");
		expect(mapRunningTaskStage("hunter")).toBe("hunter");
	});

	it("drops unknown stages", () => {
		expect(mapRunningTaskStage("unknown-stage")).toBeNull();
	});
});
