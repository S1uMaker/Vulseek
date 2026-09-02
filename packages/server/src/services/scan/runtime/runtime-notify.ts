export const RUNTIME_NOTIFY_TYPE = "runtime_notify" as const;

export type RuntimeNotify = {
	type: typeof RUNTIME_NOTIFY_TYPE;
	messageCount: number;
};

export const buildRuntimeNotify = (messageCount: number): RuntimeNotify => ({
	type: RUNTIME_NOTIFY_TYPE,
	messageCount,
});

export const runtimeNotifyPromptText = (messageCount: number) =>
	`Inbound message count changed to ${messageCount}.`;
