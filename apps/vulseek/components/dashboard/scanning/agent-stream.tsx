import { createAgentStreamParser } from "claude-replay/agent-stream";
import { memo, useEffect, useRef, useState } from "react";
import styles from "./agent-stream.module.css";
import {
	formatAgentStreamProvider,
	isAgentStreamNearBottom,
	mergeAgentStreamTurns,
	reduceAgentStreamConnectionState,
	shouldShowAgentStreamSpinner,
} from "./agent-stream-state";
import type {
	AgentStreamEvent,
	AgentStreamMetadata,
	AgentStreamTransport,
} from "./agent-stream-transport";

type AgentStreamToolCall = {
	name: string;
	input: Record<string, unknown>;
	result: string | null;
	is_error: boolean;
};
type AgentStreamBlock = {
	kind: string;
	text: string;
	tool_call: AgentStreamToolCall | null;
};
type AgentStreamTurn = {
	index: number;
	user_text: string;
	blocks: AgentStreamBlock[];
};

export type AgentStreamLabels = {
	running: string;
	waiting: string;
	unavailable: string;
	connectionError: string;
	jumpToLatest: string;
};

const DEFAULT_LABELS: AgentStreamLabels = {
	running: "Running",
	waiting: "Waiting for native agent transcript...",
	unavailable: "Native agent session is unavailable.",
	connectionError: "Unable to connect to the agent session.",
	jumpToLatest: "Jump to latest",
};

const renderJson = (value: unknown) => {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

const blockLabel = (kind: string) => {
	if (kind === "thinking") return "Thinking";
	if (kind === "tool_use") return "Tool call";
	return "Assistant";
};

const toolPreview = (tool: AgentStreamToolCall) => {
	const input = tool.input;
	if (tool.name.toLowerCase() === "edit") {
		return String(input.file_path || input.path || "");
	}
	return String(input.command || input.cmd || input.input || "");
};

const TurnView = memo(function TurnView({
	turn,
	status,
	isLastTurn,
	provider,
	labels,
}: {
	turn: AgentStreamTurn;
	status: string;
	isLastTurn: boolean;
	provider: AgentStreamMetadata["provider"] | undefined;
	labels: AgentStreamLabels;
}) {
	return (
		<article className={styles.turn}>
			<header className={styles.turnHeader}>
				<strong>#{turn.index}</strong>
				<time>0:00</time>
			</header>
			{turn.user_text ? (
				<details className={styles.userMessage}>
					<summary className={styles.userSummary}>
						<span className={styles.userPrompt}>USER</span>
						<span className={styles.userPreview}>{turn.user_text}</span>
					</summary>
					<div className={styles.userText}>{turn.user_text}</div>
				</details>
			) : null}
			<section className={styles.assistantLane}>
				<div className={styles.assistantLabel}>
					{formatAgentStreamProvider(provider)}
				</div>
				{turn.blocks.map((block, index) => {
					const tool = block.tool_call;
					const showSpinner = shouldShowAgentStreamSpinner({
						status,
						isLastTurn,
						isLastBlock: index === turn.blocks.length - 1,
						kind: block.kind,
						hasPendingToolResult: Boolean(tool && tool.result === null),
					});
					return (
						<div className={styles.block} key={`${turn.index}-${index}`}>
							{block.kind === "thinking" ? (
								<details className={styles.thinking}>
									<summary>
										{blockLabel(block.kind)}
										{showSpinner ? (
											<span
												className={styles.spinner}
												aria-label={labels.running}
												title={labels.running}
											/>
										) : null}
									</summary>
									<div className={styles.thinkingBody}>{block.text}</div>
								</details>
							) : tool ? (
								<details className={styles.tool}>
									<summary className={styles.toolSummary}>
										<span className={styles.toolDot} />
										<strong>{tool.name || "Tool"}</strong>
										<span className={styles.toolPreview}>
											{toolPreview(tool)}
										</span>
										{showSpinner ? (
											<span
												className={styles.spinner}
												aria-label={labels.running}
												title={labels.running}
											/>
										) : null}
									</summary>
									<pre>{renderJson(tool.input)}</pre>
									{tool.result !== null ? (
										<pre
											className={
												tool.is_error ? styles.toolError : styles.toolResult
											}
										>
											{tool.result}
										</pre>
									) : null}
								</details>
							) : (
								<div className={styles.assistantText}>{block.text}</div>
							)}
						</div>
					);
				})}
			</section>
		</article>
	);
});

export const AgentStream = ({
	transport,
	className,
	labels: providedLabels,
}: {
	transport: AgentStreamTransport;
	className?: string;
	labels?: Partial<AgentStreamLabels>;
}) => {
	const labels = { ...DEFAULT_LABELS, ...providedLabels };
	const labelsRef = useRef(labels);
	labelsRef.current = labels;
	const parserRef = useRef<ReturnType<typeof createAgentStreamParser> | null>(
		null,
	);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const autoFollowRef = useRef(true);
	const [turns, setTurns] = useState<AgentStreamTurn[]>([]);
	const [metadata, setMetadata] = useState<AgentStreamMetadata | null>(null);
	const [connection, setConnection] = useState({
		status: "connecting",
		error: null as string | null,
	});
	const [hasNewContent, setHasNewContent] = useState(false);
	const { status, error } = connection;

	useEffect(() => {
		const unsubscribe = transport.subscribe((event: AgentStreamEvent) => {
			setConnection((current) => {
				const next = reduceAgentStreamConnectionState(current, event);
				if (event.type !== "stream_error") {
					return next;
				}
				return {
					...next,
					error:
						event.payload.code === "source_unavailable"
							? labelsRef.current.unavailable
							: labelsRef.current.connectionError,
				};
			});
			if (event.type === "metadata") {
				setMetadata(event.payload);
				parserRef.current = createAgentStreamParser({
					format: event.payload.provider,
				});
				return;
			}
			if (event.type === "snapshot_start") {
				if (!parserRef.current) {
					parserRef.current = createAgentStreamParser({
						format: event.payload.provider,
					});
				}
				parserRef.current.reset();
				setTurns([]);
				return;
			}
			if (event.type === "chunk" || event.type === "append") {
				if (!parserRef.current) return;
				const result = parserRef.current.push(event.payload.text);
				setTurns((current) =>
					mergeAgentStreamTurns(current, result.turns, result.changedFrom),
				);
				setHasNewContent(!autoFollowRef.current);
				return;
			}
			if (event.type === "snapshot_end") {
				if (!parserRef.current) return;
				setTurns(parserRef.current.finish().turns);
				return;
			}
			if (event.type === "prompt") {
				if (!parserRef.current) return;
				const result = parserRef.current.pushPrompt(event.payload);
				setTurns((current) =>
					mergeAgentStreamTurns(current, result.turns, result.changedFrom),
				);
				setHasNewContent(!autoFollowRef.current);
				return;
			}
			if (event.type === "waiting") {
				return;
			}
			if (event.type === "done") {
				return;
			}
		});
		return unsubscribe;
	}, [transport]);

	useEffect(() => {
		const container = scrollRef.current;
		if (container && autoFollowRef.current) {
			container.scrollTop = container.scrollHeight;
		}
	}, [turns]);

	const handleScroll = () => {
		const container = scrollRef.current;
		if (!container) return;
		autoFollowRef.current = isAgentStreamNearBottom(container);
		if (autoFollowRef.current) setHasNewContent(false);
	};

	const jumpToLatest = () => {
		const container = scrollRef.current;
		if (!container) return;
		autoFollowRef.current = true;
		container.scrollTop = container.scrollHeight;
		setHasNewContent(false);
	};

	return (
		<div className={`${styles.root} ${className || ""}`}>
			<div className={styles.toolbar}>
				<span className={styles.status}>{status}</span>
				{metadata?.threadId ? <code>{metadata.threadId}</code> : null}
			</div>
			{error ? <div className={styles.error}>{error}</div> : null}
			<div className={styles.timeline} ref={scrollRef} onScroll={handleScroll}>
				{turns.length ? (
					turns.map((turn, index) => (
						<TurnView
							key={turn.index}
							turn={turn}
							status={status}
							isLastTurn={index === turns.length - 1}
							provider={metadata?.provider}
							labels={labels}
						/>
					))
				) : (
					<div className={styles.empty}>{labels.waiting}</div>
				)}
			</div>
			{hasNewContent ? (
				<button className={styles.jump} type="button" onClick={jumpToLatest}>
					{labels.jumpToLatest}
				</button>
			) : null}
		</div>
	);
};
