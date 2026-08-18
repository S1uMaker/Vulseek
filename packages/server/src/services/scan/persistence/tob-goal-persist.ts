const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const readString = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim() : null;

export const resolvePersistCandidate = (input: {
	stageOutput: unknown;
	stageInput?: unknown;
}) => {
	const output = asRecord(input.stageOutput) ?? {};
	const stageInput = asRecord(input.stageInput) ?? {};
	const outcome = readString(output.outcome);
	// Hunt used to emit { outcome: "candidate", candidate }. Current Hunt
	// only emits { candidate }. Persist unless an explicit non-candidate
	// outcome is set.
	if (outcome && outcome !== "candidate") {
		return { ok: false as const, reason: "not-candidate" };
	}
	const candidate = asRecord(output.candidate);
	if (!candidate) {
		return { ok: false as const, reason: "missing-candidate" };
	}
	const candidateId = readString(candidate.candidateId);
	const huntGoalId =
		readString(candidate.huntGoalId) ||
		readString(asRecord(stageInput.huntGoal)?.huntGoalId);
	const title = readString(candidate.title);
	if (!candidateId || !huntGoalId || !title) {
		return { ok: false as const, reason: "incomplete-candidate" };
	}
	return {
		ok: true as const,
		candidateId,
		huntGoalId,
		title,
		summary: readString(candidate.description) ?? title,
		content: candidate,
	};
};
