export const SCAN_JOB_MAX_TIME_BUDGET_SECONDS = 30 * 24 * 60 * 60;

export type ScanJobBudgetReason = "token_budget" | "time_budget";

export type ScanJobBudgetEvaluation =
	| { exceeded: false }
	| { exceeded: true; reason: ScanJobBudgetReason };

export const resolveScanJobDeadlineAt = (input: {
	nowMs: number;
	yamlMaxDurationSeconds: number;
	timeBudgetSeconds?: number | null;
}): string => {
	const yamlDeadlineMs = input.nowMs + input.yamlMaxDurationSeconds * 1000;
	const userDeadlineMs =
		input.timeBudgetSeconds != null
			? input.nowMs + input.timeBudgetSeconds * 1000
			: null;
	const deadlineMs =
		userDeadlineMs == null
			? yamlDeadlineMs
			: Math.min(yamlDeadlineMs, userDeadlineMs);
	return new Date(deadlineMs).toISOString();
};

export const evaluateScanJobBudget = (input: {
	nowMs: number;
	tokenBudget?: number | null;
	totalTokens: number;
	timeBudgetSeconds?: number | null;
	startedAt?: string | null;
	createdAt: string;
}): ScanJobBudgetEvaluation => {
	if (input.tokenBudget != null && input.totalTokens >= input.tokenBudget) {
		return { exceeded: true, reason: "token_budget" };
	}
	if (input.timeBudgetSeconds != null) {
		const origin = Date.parse(input.startedAt ?? input.createdAt);
		if (
			Number.isFinite(origin) &&
			input.nowMs >= origin + input.timeBudgetSeconds * 1000
		) {
			return { exceeded: true, reason: "time_budget" };
		}
	}
	return { exceeded: false };
};

export const scanJobBudgetCancelMessage = (reason: ScanJobBudgetReason) =>
	reason === "token_budget"
		? "Scan job exceeded its token usage budget"
		: "Scan job exceeded its time budget";
