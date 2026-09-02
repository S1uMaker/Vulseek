import type { AgentStreamEvent } from "./agent-stream-transport";

const liveStatuses = new Set([
	"running",
	"starting",
	"launched",
	"launching",
	"streaming",
]);

export const isAgentStreamLive = (status: string) => liveStatuses.has(status);

export const mergeAgentStreamTurns = <Turn>(
	current: readonly Turn[],
	next: readonly Turn[],
	changedFrom: number,
): Turn[] => {
	if (changedFrom >= next.length && current.length === next.length) {
		return current as Turn[];
	}
	const stableLength = Math.min(
		Math.max(0, changedFrom),
		current.length,
		next.length,
	);
	return [...current.slice(0, stableLength), ...next.slice(stableLength)];
};

export const isAgentStreamNearBottom = ({
	scrollHeight,
	scrollTop,
	clientHeight,
}: {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}) => scrollHeight - scrollTop - clientHeight <= 24;

export const formatAgentStreamProvider = (
	provider: "codex" | "claude-code" | "grok" | undefined,
) =>
	provider === "claude-code"
		? "CLAUDE CODE"
		: provider === "grok"
			? "GROK BUILD"
			: "CODEX";

const compactPreviewText = (value: string) => value.replace(/\s+/g, " ").trim();

export const formatAgentStreamToolPreview = (tool: {
	name: string;
	input: Record<string, unknown>;
}) => {
	const input = tool.input;
	if (tool.name.toLowerCase() === "edit") {
		const path = input.file_path || input.path;
		if (typeof path === "string" && path.trim()) {
			return compactPreviewText(path);
		}
	}
	const direct = [
		input.command,
		input.cmd,
		input.input,
		input.query,
		input.url,
		input.file_path,
		input.path,
		input.pattern,
		input.target_file,
	];
	for (const value of direct) {
		if (typeof value === "string" && value.trim()) {
			return compactPreviewText(value);
		}
	}
	if (typeof input.raw === "string" && input.raw.trim()) {
		const cmd =
			input.raw.match(/\bcmd\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] ??
			input.raw.match(/\bcommand\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
		if (cmd) {
			return compactPreviewText(cmd.replace(/\\n/g, " ").replace(/\\"/g, '"'));
		}
		return compactPreviewText(input.raw);
	}
	return "";
};

export type AgentStreamConnectionState = {
	status: string;
	error: string | null;
};

export const reduceAgentStreamConnectionState = (
	current: AgentStreamConnectionState,
	event: AgentStreamEvent,
): AgentStreamConnectionState => {
	if (event.type === "metadata") {
		return { status: event.payload.status, error: null };
	}
	if (
		event.type === "snapshot_start" ||
		event.type === "chunk" ||
		event.type === "append" ||
		event.type === "prompt"
	) {
		return { status: "streaming", error: null };
	}
	if (event.type === "waiting") {
		return { status: `waiting:${event.payload.reason}`, error: null };
	}
	if (event.type === "done") {
		return {
			status: event.payload.status || "done",
			error: current.error,
		};
	}
	if (event.type === "stream_error") {
		return {
			status: "error",
			error:
				event.payload.message || event.payload.code || "Agent stream error",
		};
	}
	return current;
};

export const shouldShowAgentStreamSpinner = ({
	status,
	isLastTurn,
	isLastBlock,
	kind,
	hasPendingToolResult,
}: {
	status: string;
	isLastTurn: boolean;
	isLastBlock: boolean;
	kind: string;
	hasPendingToolResult: boolean;
}) =>
	isAgentStreamLive(status) &&
	isLastTurn &&
	isLastBlock &&
	(kind === "thinking" || hasPendingToolResult);
