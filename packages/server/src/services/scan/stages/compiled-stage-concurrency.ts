export type CompiledStageRuntimeSnapshot = {
	concurrency: number;
	agentProfileId: string | null;
	goalSession: "shared" | "per-task" | null;
	persistent: boolean | null;
	reuseContainer: boolean | null;
	nullableOutput: boolean | null;
	cwd: string | null;
	skills: string[];
	prompt: string;
	outputSchema: Record<string, unknown> | null;
};

export const findCompiledStageRuntimeSnapshot = (
	snapshot: unknown,
	stageName: string,
): CompiledStageRuntimeSnapshot | null | undefined => {
	if (!snapshot || typeof snapshot !== "object") return undefined;
	const stages = (snapshot as { stages?: unknown }).stages;
	if (!Array.isArray(stages)) return undefined;
	const stage = stages.find(
		(item): item is Record<string, unknown> & { id: string } =>
			Boolean(
				item &&
					typeof item === "object" &&
					(item as { id?: unknown }).id === stageName,
			),
	);
	if (!stage) return null;
	const runtime =
		stage.runtime && typeof stage.runtime === "object"
			? (stage.runtime as Record<string, unknown>)
			: {};
	if (
		typeof stage.concurrency !== "number" ||
		!Number.isInteger(stage.concurrency) ||
		stage.concurrency < 1 ||
		typeof runtime.prompt !== "string"
	) {
		return null;
	}
	return {
		concurrency: stage.concurrency,
		agentProfileId:
			typeof runtime.agentProfileId === "string"
				? runtime.agentProfileId
				: null,
		goalSession:
			runtime.goalSession === "shared" || runtime.goalSession === "per-task"
				? runtime.goalSession
				: null,
		persistent:
			typeof runtime.persistent === "boolean" ? runtime.persistent : null,
		reuseContainer:
			typeof runtime.reuseContainer === "boolean"
				? runtime.reuseContainer
				: null,
		nullableOutput:
			typeof runtime.nullableOutput === "boolean"
				? runtime.nullableOutput
				: null,
		cwd: typeof runtime.cwd === "string" ? runtime.cwd : null,
		skills: Array.isArray(runtime.skills)
			? runtime.skills.filter(
					(value): value is string => typeof value === "string",
				)
			: [],
		prompt: runtime.prompt,
		outputSchema:
			stage.outputSchema && typeof stage.outputSchema === "object"
				? (stage.outputSchema as Record<string, unknown>)
				: null,
	};
};

export const findCompiledStageConcurrency = (
	snapshot: unknown,
	stageName: string,
): number | null =>
	findCompiledStageRuntimeSnapshot(snapshot, stageName)?.concurrency ?? null;
