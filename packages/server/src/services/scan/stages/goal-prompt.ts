/** Build the small native-goal envelopes used by the ToB Goal stages. */

export const CODEX_NATIVE_GOAL_MAX_CHARS = 4000;

const collapseWhitespace = (value: string) =>
	value.replace(/\s+/g, " ").trim();

const humanizeGoalKey = (key: string) =>
	key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, (character) => character.toUpperCase());

const formatGoalScalar = (value: unknown): string => {
	if (value === null || value === undefined) return "none";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "string") return collapseWhitespace(value) || "empty";
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	return String(value);
};

const formatGoalValue = (value: unknown, indent: string): string[] => {
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${indent}none`];
		return value.flatMap((item) => {
			if (item && typeof item === "object") {
				return [
					`${indent}-`,
					...formatGoalValue(item, `${indent}  `),
				];
			}
			return [`${indent}- ${formatGoalScalar(item)}`];
		});
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return [`${indent}none`];
		return entries.flatMap(([key, child]) => {
			const label = humanizeGoalKey(key);
			if (child && typeof child === "object") {
				return [`${indent}${label}:`, ...formatGoalValue(child, `${indent}  `)];
			}
			return [`${indent}${label}: ${formatGoalScalar(child)}`];
		});
	}
	return [`${indent}${formatGoalScalar(value)}`];
};

const readRecordValue = (value: unknown, key: string): unknown =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;

const readStringValue = (value: unknown, key: string): string => {
	const result = readRecordValue(value, key);
	return typeof result === "string" ? result.trim() : "";
};

const formatGoalList = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => formatGoalScalar(item))
		.filter((item) => item !== "empty" && item !== "none");
};

const truncateGoalPrompt = (prompt: string, maxChars: number) => {
	if (prompt.length <= maxChars) return prompt;
	return `${prompt.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

/** Render stage input as readable task context rather than embedding raw JSON. */
export const formatGoalInputAsNaturalText = (input: unknown): string =>
	formatGoalValue(input, "").join("\n");

/**
 * Native `/goal` used once by the shared Surface planner lane. The durable
 * GoalSpec stays in an artifact; only its path and the planner contract are
 * placed in the goal state.
 */
export const buildSurfacePlannerGoalPrompt = (input?: {
	surfaceGuidance?: string | null;
	maxChars?: number;
}) => {
	const sections = [
		"Use /task/inputs/goal-spec.json as the durable GoalSpec lens for this scan.",
		"Continuously dispatch unexplored, high-value attack surfaces; do not hunt vulnerabilities yourself and do not rewrite the GoalSpec.",
		"On each planning turn emit 2-8 non-overlapping huntGoals, or honestly declare globalExhausted with no huntGoals.",
		"A huntGoal only locks scope with scopeStatement and focusPaths; the GoalSpec remains the sole success criterion.",
		input?.surfaceGuidance?.trim()
			? `Surface guidance:\n${input.surfaceGuidance.trim()}`
			: "",
	];
	return truncateGoalPrompt(
		`/goal ${sections.filter(Boolean).join("\n\n")}`,
		input?.maxChars ?? CODEX_NATIVE_GOAL_MAX_CHARS,
	);
};

/** Render the ordinary Surface continuation turn after its first `/goal`. */
export const buildSurfacePlannerTurnPrompt = (input: {
	prompt: string;
	feedback?: unknown;
}) => {
	const feedback = input.feedback
		? formatGoalInputAsNaturalText(input.feedback)
		: "No feedback was supplied.";
	return [
		input.prompt.trim(),
		"Feedback from the previous downstream task:",
		feedback,
		"Continue the standing planner goal. Emit the next SurfaceDispatch only.",
	].filter(Boolean).join("\n\n");
};

/** Build one Hunt's native goal from the durable GoalSpec and assigned scope. */
export const buildHuntGoalPrompt = (input: {
	goalSpec: unknown;
	huntGoal: unknown;
	maxChars?: number;
}) => {
	const goalSpec = input.goalSpec;
	const huntGoal = input.huntGoal;
	const focusPaths = formatGoalList(readRecordValue(huntGoal, "focusPaths"));
	const sections = [
		readStringValue(huntGoal, "title"),
		`Success criteria: ${readStringValue(goalSpec, "successCriteria")}`,
		`Attacker model: ${readStringValue(goalSpec, "attackerModel")}`,
		`Non-goals: ${formatGoalList(readRecordValue(goalSpec, "nonGoals")).join("; ") || "none"}`,
		`Stop condition: ${readStringValue(goalSpec, "stopCondition")}`,
		readStringValue(goalSpec, "persistenceLanguage"),
		`Scope: ${readStringValue(huntGoal, "scopeStatement")}`,
		focusPaths.length
			? `Focus paths:\n${focusPaths.map((path) => `- ${path}`).join("\n")}`
			: "Focus paths: repository-wide within the assigned scope",
	].filter(Boolean);
	return truncateGoalPrompt(
		`/goal ${sections.join("\n\n")}`,
		input.maxChars ?? CODEX_NATIVE_GOAL_MAX_CHARS,
	);
};

export const isSurfaceGoalReentry = (input: unknown) => {
	const feedback = readRecordValue(input, "feedback");
	return Boolean(feedback && typeof feedback === "object" && !Array.isArray(feedback));
};

/**
 * Prefix a stage prompt with Codex's native goal marker and append readable
 * input context. The stage's existing output contract remains authoritative.
 */
export const buildGoalPrompt = (input: {
	prompt: string;
	input: unknown;
	maxChars?: number;
}): string => {
	const maxChars = input.maxChars ?? CODEX_NATIVE_GOAL_MAX_CHARS;
	const prompt = input.prompt.trim();
	const inputText = formatGoalInputAsNaturalText(input.input);
	const sections = [prompt, "Task input:", inputText].filter(Boolean);
	const objective = sections.join("\n\n");
	if (objective.length <= maxChars) return `/goal ${objective}`;
	return `/goal ${objective.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};
