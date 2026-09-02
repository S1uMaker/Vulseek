export type AgentStreamMetadata = {
	taskId: string;
	scanJobId: string;
	provider: "codex" | "claude-code" | "grok";
	threadId: string | null;
	status: string;
};

export type AgentStreamPrompt = {
	promptId: string;
	taskId: string | null;
	sessionId: string | null;
	turnIndex: number;
	timestamp: string;
	text: string;
	offset: number;
};

export type AgentStreamEvent =
	| { type: "metadata"; payload: AgentStreamMetadata }
	| { type: "waiting"; payload: { reason: string } }
	| { type: "snapshot_start"; payload: AgentStreamMetadata }
	| { type: "chunk"; payload: { text: string; offset: number } }
	| { type: "snapshot_end"; payload: { length: number } }
	| { type: "append"; payload: { text: string; offset: number } }
	| { type: "prompt"; payload: AgentStreamPrompt }
	| { type: "done"; payload: { status: string; taskId: string } }
	| { type: "stream_error"; payload: { code?: string; message?: string } };

export interface AgentStreamTransport {
	subscribe(listener: (event: AgentStreamEvent) => void): () => void;
}

export class SseAgentStreamTransport implements AgentStreamTransport {
	private readonly url: string;

	constructor(url: string) {
		this.url = url;
	}

	subscribe(listener: (event: AgentStreamEvent) => void) {
		const source = new EventSource(this.url);
		const eventTypes = [
			"metadata",
			"waiting",
			"snapshot_start",
			"chunk",
			"snapshot_end",
			"append",
			"prompt",
			"done",
			"stream_error",
		] as const;
		const handlers = eventTypes.map((type) => {
			const handler = (event: MessageEvent<string>) => {
				try {
					listener({ type, payload: JSON.parse(event.data) });
					if (type === "done") source.close();
				} catch {
					listener({
						type: "stream_error",
						payload: { code: "invalid_event", message: "Invalid SSE payload" },
					});
				}
			};
			source.addEventListener(type, handler);
			return [type, handler] as const;
		});
		source.onerror = () => {
			listener({
				type: "stream_error",
				payload: {
					code: "connection_closed",
					message: "Agent stream disconnected",
				},
			});
		};
		return () => {
			source.onerror = null;
			for (const [type, handler] of handlers) {
				source.removeEventListener(type, handler);
			}
			source.close();
		};
	}
}
