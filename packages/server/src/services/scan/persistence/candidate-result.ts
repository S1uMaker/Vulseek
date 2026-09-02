export const getCandidateResultRank = (result: string | null | undefined) => {
	if (!result) {
		return -1;
	}
	return (
		{
			real_vulnerability: 4,
			true: 4,
			likely_vulnerability: 3,
			likely: 3,
			plausible_but_unproven: 2,
			api_misuse: 1,
			false_positive: 0,
			false: 0,
		} as Record<string, number>
	)[result] ?? -1;
};

export const compareCandidateResultVersions = (
	left: { resultAt: string; taskId: string },
	right: { resultAt: string; taskId: string },
) => {
	const leftTime = Date.parse(left.resultAt);
	const rightTime = Date.parse(right.resultAt);
	if (leftTime !== rightTime) {
		return leftTime - rightTime;
	}
	return left.taskId.localeCompare(right.taskId);
};

type CandidateResultPatchInput = {
	taskId: string;
	messageId?: string | null;
	stageName: string;
	output: unknown;
	resultAt: string;
};

export const normalizeCandidateResultStageOutput = (
	stageName: string,
	output: unknown,
) => {
	if (
		stageName !== "verify-finding" ||
		!output ||
		typeof output !== "object" ||
		Array.isArray(output)
	) {
		return output;
	}
	const result = (output as { result?: unknown }).result;
	if (typeof result !== "boolean") {
		return output;
	}
	return {
		...(output as Record<string, unknown>),
		result: result ? "true" : "false",
	};
};

export const buildCandidateResultPatch = (input: CandidateResultPatchInput) => {
	const output = normalizeCandidateResultStageOutput(
		input.stageName,
		input.output,
	);
	const result =
		output && typeof output === "object"
			? (output as { result?: unknown }).result
			: null;
	const resultValue = typeof result === "string" ? result : null;
	const common = {
		result: resultValue,
		rank: getCandidateResultRank(resultValue),
		resultAt: input.resultAt,
	};

	if (input.stageName === "analyze-finding") {
		return {
			analysisTaskId: input.taskId,
			analysisMessageId: input.messageId ?? null,
			analysisOutput: output,
			analysisResult: common.result,
			analysisRank: common.rank,
			analysisResultAt: common.resultAt,
		};
	}
	if (input.stageName === "verify-finding") {
		return {
			verificationTaskId: input.taskId,
			verificationMessageId: input.messageId ?? null,
			verificationOutput: output,
			verificationResult: common.result,
			verificationRank: common.rank,
			verificationResultAt: common.resultAt,
		};
	}
	if (input.stageName === "triage-finding") {
		return {
			triageTaskId: input.taskId,
			triageMessageId: input.messageId ?? null,
			triageOutput: output,
			triageResult: common.result,
			triageRank: common.rank,
			triageResultAt: common.resultAt,
		};
	}
	return {};
};
