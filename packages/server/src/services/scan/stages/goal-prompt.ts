/** Native `/goal` helpers. The goal text is the rendered stage prompt. */

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
				return [`${indent}-`, ...formatGoalValue(item, `${indent}  `)];
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

/** Render stage input as readable task context rather than embedding raw JSON. */
export const formatGoalInputAsNaturalText = (input: unknown): string =>
	formatGoalValue(input, "").join("\n");

export const isNativeGoalPrompt = (prompt: string) =>
	/^\s*\/goal(?:\s|$)/i.test(prompt);

export const prefixNativeGoal = (
	prompt: string,
	maxChars = CODEX_NATIVE_GOAL_MAX_CHARS,
) => {
	const trimmed = prompt.trim();
	const withPrefix = isNativeGoalPrompt(trimmed)
		? trimmed
		: `/goal ${trimmed}`;
	if (withPrefix.length <= maxChars) return withPrefix;
	return `${withPrefix.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

export const isSurfaceGoalReentry = (input: unknown) => {
	const feedback = readRecordValue(input, "feedback");
	return Boolean(
		feedback && typeof feedback === "object" && !Array.isArray(feedback),
	);
};

/** Feedback-only follow-up after the standing `/goal`. No extra wrapper text. */
export const buildSurfacePlannerTurnPrompt = (input: {
	feedback?: unknown;
}) =>
	input.feedback
		? formatGoalInputAsNaturalText(input.feedback)
		: "";

/** First Hunt/Surface turn is the rendered stage prompt (no `/goal` prefix). Re-entry is not. */
export const resolveGoalStagePrompt = (input: {
	renderedPrompt: string;
	stageInput: unknown;
	sharedSession?: boolean;
	maxChars?: number;
}) => {
	if (input.sharedSession && isSurfaceGoalReentry(input.stageInput)) {
		return buildSurfacePlannerTurnPrompt({
			feedback: readRecordValue(input.stageInput, "feedback"),
		});
	}
	const trimmed = input.renderedPrompt.trim();
	const maxChars = input.maxChars ?? CODEX_NATIVE_GOAL_MAX_CHARS;
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};
