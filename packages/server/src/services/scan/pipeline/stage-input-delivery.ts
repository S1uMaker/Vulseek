export const STAGE_INPUT_DELIVERY = ["prompt", "poll"] as const;

export type StageInputDelivery = (typeof STAGE_INPUT_DELIVERY)[number];

export const DEFAULT_STAGE_INPUT_DELIVERY: StageInputDelivery = "prompt";

export const normalizeStageInputDelivery = (
	value: unknown,
): StageInputDelivery =>
	value === "poll" ? "poll" : DEFAULT_STAGE_INPUT_DELIVERY;

export const shouldRemoveStageQueueJob = (input: {
	inputDelivery?: StageInputDelivery | null;
}) => normalizeStageInputDelivery(input.inputDelivery) !== "poll";

export const buildPollMessagesPrompt = (input: {
	stageName: string;
	pollPrompt?: string | null;
}) => {
	const custom = input.pollPrompt?.trim();
	if (custom) {
		return custom;
	}
	const stageName = input.stageName.trim() || "this stage";
	return [
		"Inbound work for this stage stays in this stage's Redis queue. It is not launched as a new session and is not pushed into this prompt.",
		"Take items from this stage's queue with scan-runtime. Pass this stage's name:",
		"",
		`python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/query_scan_runtime.py" poll-messages --stage ${stageName}`,
		"",
		"That call takes every currently waiting Message in one batch (not one item per call) and removes them from Redis. `name` is the assigned work name. `input` is the inbound edge payload (for Hunter follow-up: name and feedback). After you have used an item, complete it so any leftover queue entry is dropped:",
		"",
		'python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/query_scan_runtime.py" complete-messages --message-id MESSAGE_ID',
		"",
		"Do not wait for a follow-up prompt that contains inbound input. Do not poll another stage's Messages as a substitute for this queue.",
		"An empty poll result while downstream tasks are still running is the expected wait state. Downstream startedAt/updatedAt often stay unchanged during a run; that is not a hang. Keep polling. Do not declare a runtime blocker because the queue is empty or timestamps are frozen.",
	].join("\n");
};

export const appendPollInputPrompt = (input: {
	prompt: string;
	stageName: string;
	inputDelivery?: StageInputDelivery | null;
	pollPrompt?: string | null;
}) => {
	const prompt = input.prompt.trim();
	if (normalizeStageInputDelivery(input.inputDelivery) !== "poll") {
		return prompt;
	}
	const pollBlock = buildPollMessagesPrompt({
		stageName: input.stageName,
		pollPrompt: input.pollPrompt,
	});
	if (!prompt) {
		return pollBlock;
	}
	return `${prompt}\n\n${pollBlock}`;
};
