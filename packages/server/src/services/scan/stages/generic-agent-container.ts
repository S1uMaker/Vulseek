const RESEARCH_STAGES = new Set([
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

export const isResearchStage = (stageName: string) =>
	stageName === "research" || RESEARCH_STAGES.has(stageName);

export const resolveStageReuseContainer = (
	stageName: string,
	configured: boolean,
	_goal = false,
	goalSession?: "shared" | "per-task",
) =>
	goalSession === "shared"
		? true
		: isResearchStage(stageName)
			? false
			: configured;

export const resolveStageContainerNameParts = (
	taskId: string,
	configured: Array<string | null | undefined> | undefined,
	reuseContainer: boolean,
) => (reuseContainer ? configured : [...(configured || []), taskId]);
