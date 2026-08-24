export type RunningTaskStage =
	| "delta-scope"
	| "repository-profile"
	| "attack-surface-model"
	| "identify-target"
	| "scan-target"
	| "analyze-finding"
	| "critique-finding"
	| "verify-finding"
	| "triage-finding"
	| "research-scope"
	| "surface-map"
	| "track-plan"
	| "vulnerability-discovery"
	| "track-review"
	| "finding-validation"
	| "finding-review"
	| "chain-synthesis"
	| "chain-review"
	| "exploit-validation"
	| "exploit-review"
	| "research-report"
	| "goal-craft"
	| "goal-surface"
	| "goal-hunt"
	| "goal-judge"
	| "goal-dedup"
	| "orchestrator"
	| "hunter";

export const RESEARCH_RUNNING_TASK_STAGES = [
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
] as const satisfies readonly RunningTaskStage[];

export const RESEARCH_RUNNING_TASK_STAGE_DISPLAY_NAMES: Record<
	(typeof RESEARCH_RUNNING_TASK_STAGES)[number],
	string
> = {
	"research-scope": "Research Scope",
	"surface-map": "Surface Map",
	"track-plan": "Track Plan",
	"vulnerability-discovery": "Vulnerability Discovery",
	"track-review": "Track Review",
	"finding-validation": "Finding Validation",
	"finding-review": "Finding Review",
	"chain-synthesis": "Chain Synthesis",
	"chain-review": "Chain Review",
	"exploit-validation": "Exploit Validation",
	"exploit-review": "Exploit Review",
	"research-report": "Research Report",
};

export const TOB_GOAL_RUNNING_TASK_STAGES = [
	"goal-craft",
	"goal-surface",
	"goal-hunt",
	"goal-judge",
	"goal-dedup",
] as const satisfies readonly RunningTaskStage[];

export const TOB_GOAL_RUNNING_TASK_STAGE_DISPLAY_NAMES: Record<
	(typeof TOB_GOAL_RUNNING_TASK_STAGES)[number],
	string
> = {
	"goal-craft": "Goal Craft",
	"goal-surface": "Goal Surface",
	"goal-hunt": "Goal Hunt",
	"goal-judge": "Goal Judge",
	"goal-dedup": "Goal Dedup",
};

export const isTobGoalRunningTaskStage = (
	stageName: string,
): stageName is (typeof TOB_GOAL_RUNNING_TASK_STAGES)[number] =>
	(TOB_GOAL_RUNNING_TASK_STAGES as readonly string[]).includes(stageName);

export const getTobGoalRunningTaskPresentation = (
	stageName: string,
	taskName: string,
) => {
	if (!isTobGoalRunningTaskStage(stageName)) {
		return null;
	}
	return {
		title: taskName,
		subtitle: TOB_GOAL_RUNNING_TASK_STAGE_DISPLAY_NAMES[stageName],
		stage: stageName,
	};
};

export const ORCH_HUNT_RUNNING_TASK_STAGES = [
	"orchestrator",
	"hunter",
] as const satisfies readonly RunningTaskStage[];

export const ORCH_HUNT_RUNNING_TASK_STAGE_DISPLAY_NAMES: Record<
	(typeof ORCH_HUNT_RUNNING_TASK_STAGES)[number],
	string
> = {
	orchestrator: "Orchestrator",
	hunter: "Hunter",
};

export const isOrchHuntRunningTaskStage = (
	stageName: string,
): stageName is (typeof ORCH_HUNT_RUNNING_TASK_STAGES)[number] =>
	(ORCH_HUNT_RUNNING_TASK_STAGES as readonly string[]).includes(stageName);

export const getOrchHuntRunningTaskPresentation = (
	stageName: string,
	taskName: string,
) => {
	if (!isOrchHuntRunningTaskStage(stageName)) {
		return null;
	}
	return {
		title: taskName,
		subtitle: ORCH_HUNT_RUNNING_TASK_STAGE_DISPLAY_NAMES[stageName],
		stage: stageName,
	};
};

export const isResearchRunningTaskStage = (
	stageName: string,
): stageName is (typeof RESEARCH_RUNNING_TASK_STAGES)[number] =>
	(RESEARCH_RUNNING_TASK_STAGES as readonly string[]).includes(stageName);

export const getResearchRunningTaskPresentation = (
	stageName: string,
	taskName: string,
) => {
	if (!isResearchRunningTaskStage(stageName)) {
		return null;
	}
	return {
		title: taskName,
		subtitle: RESEARCH_RUNNING_TASK_STAGE_DISPLAY_NAMES[stageName],
		stage: stageName,
	};
};

export const RUNNING_TASK_VIEW_STATUSES = [
	"launching",
	"launched",
	"starting",
	"running",
] as const;

export const mapRunningTaskStage = (
	stageName: string,
): RunningTaskStage | null => {
	switch (stageName) {
		case "delta-scope":
			return stageName;
		case "repository-profile":
			return stageName;
		case "attack-surface-model":
			return stageName;
		case "identify-target":
			return stageName;
		case "scan-target":
			return stageName;
		case "analyze-finding":
			return stageName;
		case "critique-finding":
			return stageName;
		case "verify-finding":
			return stageName;
		case "triage-finding":
			return stageName;
		case "research-scope":
		case "surface-map":
		case "track-plan":
		case "vulnerability-discovery":
		case "track-review":
		case "finding-validation":
		case "finding-review":
		case "chain-synthesis":
		case "chain-review":
		case "exploit-validation":
		case "exploit-review":
		case "research-report":
		case "goal-craft":
		case "goal-surface":
		case "goal-hunt":
		case "goal-judge":
		case "goal-dedup":
		case "orchestrator":
		case "hunter":
			return stageName;
		default:
			return null;
	}
};
