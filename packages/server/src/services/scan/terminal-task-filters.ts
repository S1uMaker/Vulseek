import type { taskStatusEnum } from "@vulseek/server/db/schema";

type TerminalTaskStatus = Extract<
	(typeof taskStatusEnum.enumValues)[number],
	"completed" | "failed" | "exited" | "canceled"
>;

const terminalTaskStatuses = new Set<string>([
	"completed",
	"failed",
	"exited",
	"canceled",
]);

const normalizeFilterValue = (value?: string) => {
	const trimmed = value?.trim() ?? "";
	if (!trimmed || trimmed === "all") {
		return undefined;
	}
	return trimmed;
};

export const normalizeTerminalTaskFilters = (input: {
	stage?: string;
	status?: string;
}) => {
	const stageName = normalizeFilterValue(input.stage);
	const status = normalizeFilterValue(input.status);
	return {
		stageName,
		status: terminalTaskStatuses.has(status ?? "")
			? (status as TerminalTaskStatus)
			: undefined,
	};
};
