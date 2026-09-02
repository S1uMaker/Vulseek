import {
	DriverPromptEventParser,
	findAgentStreamRuntimeByTaskId,
	findScanJobOrganizationId,
	validateRequest,
} from "@vulseek/server";
import { existsSync } from "node:fs";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	clipLatestText,
	getFileStreamBuffer,
} from "@/server/utils/file-stream-buffer";

const SNAPSHOT_CHUNK_SIZE = 64 * 1024;
const AGENT_STREAM_SNAPSHOT_MAX_CHARS = 512 * 1024;
const AGENT_STREAM_SNAPSHOT_MAX_PROMPTS = 32;

const agentStreamBuffer = (filePath: string) =>
	getFileStreamBuffer(filePath, {
		maxContentChars: AGENT_STREAM_SNAPSHOT_MAX_CHARS,
	});

const isLiveStatus = (status: string | null | undefined) =>
	status === "launching" ||
	status === "launched" ||
	status === "starting" ||
	status === "running";

const sendEvent = (res: NextApiResponse, event: string, payload: unknown) => {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const sendPrompt = (
	res: NextApiResponse,
	sourceTaskId: string,
	event: {
		promptId: string;
		taskId: string | null;
		sessionId: string | null;
		turnIndex: number;
		timestamp: string;
		text: string;
		offset: number;
	},
) => {
	sendEvent(res, "prompt", {
		promptId: event.promptId,
		taskId: event.taskId || sourceTaskId,
		sessionId: event.sessionId,
		turnIndex: event.turnIndex,
		timestamp: event.timestamp,
		text: event.text,
		offset: event.offset,
	});
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		res.status(405).json({ message: "Method not allowed" });
		return;
	}

	const taskId = req.query.taskId;
	if (typeof taskId !== "string" || !taskId) {
		res.status(400).json({ message: "Invalid task id" });
		return;
	}

	const { user, session } = await validateRequest(req);
	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}
	const streamRuntime = await findAgentStreamRuntimeByTaskId(taskId);
	if (!streamRuntime) {
		res.status(404).json({ message: "Task not found" });
		return;
	}

	const organizationId = await findScanJobOrganizationId(
		streamRuntime.runtime.scanJobId,
	);
	if (!organizationId || organizationId !== session.activeOrganizationId) {
		res.status(403).json({ message: "Forbidden" });
		return;
	}

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();

	let closed = false;
	let activeTranscriptPath: string | null = null;
	let activePromptSourceKey = "";
	let nextPromptTurnIndex = 0;
	let transcriptUnsubscribe: (() => void) | null = null;
	let promptUnsubscribes: Array<() => void> = [];
	let statusPoll: NodeJS.Timeout | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	let polling = false;

	const cleanup = () => {
		closed = true;
		transcriptUnsubscribe?.();
		transcriptUnsubscribe = null;
		for (const unsubscribe of promptUnsubscribes) unsubscribe();
		promptUnsubscribes = [];
		if (statusPoll) clearInterval(statusPoll);
		if (heartbeat) clearInterval(heartbeat);
	};

	const metadata = (current: typeof streamRuntime) => ({
		taskId: current.runtime.taskId,
		scanJobId: current.runtime.scanJobId,
		provider: current.provider,
		threadId: current.threadId,
		status: current.runtime.status,
	});

	sendEvent(res, "metadata", metadata(streamRuntime));

	const promptSourceKey = (current: typeof streamRuntime) =>
		current.promptSources
			.map((source) => `${source.taskId}:${source.stdoutPath}`)
			.join("|");

	const hasSessionSource = (current: typeof streamRuntime) => {
		if (current.transcriptPath) return true;
		return current.promptSources.some((source) => existsSync(source.stdoutPath));
	};

	const readPromptSnapshot = async (
		source: (typeof streamRuntime.promptSources)[number],
	) => {
		const buffer = agentStreamBuffer(source.stdoutPath);
		const snapshot = await buffer.getSnapshot();
		const parser = new DriverPromptEventParser();
		parser.reset(0);
		const events = parser.push(
			clipLatestText(snapshot.content, AGENT_STREAM_SNAPSHOT_MAX_CHARS),
		);
		return { buffer, parser, events };
	};

	const sendCombinedSnapshot = async (current: typeof streamRuntime) => {
		if (closed) return;
		const transcriptSnapshot = current.transcriptPath
			? await agentStreamBuffer(current.transcriptPath).getSnapshot()
			: { content: "", offset: 0 };
		const promptSnapshots = await Promise.all(
			current.promptSources.map(async (source) => ({
				source,
				...(await readPromptSnapshot(source)),
			})),
		);

		activeTranscriptPath = current.transcriptPath;
		activePromptSourceKey = promptSourceKey(current);

		const transcript = clipLatestText(
			transcriptSnapshot.content,
			AGENT_STREAM_SNAPSHOT_MAX_CHARS,
		);
		const prompts = promptSnapshots
			.flatMap(({ source, events }, sourceIndex) =>
				events.map((event) => ({
					sourceIndex,
					sourceTaskId: source.taskId,
					event,
				})),
			)
			.sort(
				(left, right) =>
					left.sourceIndex - right.sourceIndex ||
					left.event.turnIndex - right.event.turnIndex ||
					left.event.timestamp.localeCompare(right.event.timestamp) ||
					left.sourceTaskId.localeCompare(right.sourceTaskId),
			)
			.slice(-AGENT_STREAM_SNAPSHOT_MAX_PROMPTS);
		nextPromptTurnIndex = 0;

		sendEvent(res, "snapshot_start", metadata(current));
		for (
			let offset = 0;
			offset < transcript.length;
			offset += SNAPSHOT_CHUNK_SIZE
		) {
			sendEvent(res, "chunk", {
				text: transcript.slice(offset, offset + SNAPSHOT_CHUNK_SIZE),
				offset,
			});
		}
		for (const { sourceTaskId, event } of prompts) {
			sendPrompt(res, sourceTaskId, {
				...event,
				turnIndex: ++nextPromptTurnIndex,
			});
		}
		sendEvent(res, "snapshot_end", {
			length: transcript.length,
			truncated: transcript.length < transcriptSnapshot.content.length,
		});
	};

	const attachSessionSources = async (current: typeof streamRuntime) => {
		const nextTranscriptPath = current.transcriptPath;
		const nextPromptSourceKey = promptSourceKey(current);
		if (
			nextTranscriptPath === activeTranscriptPath &&
			nextPromptSourceKey === activePromptSourceKey &&
			(nextTranscriptPath || nextPromptSourceKey)
		) {
			return true;
		}

		transcriptUnsubscribe?.();
		transcriptUnsubscribe = null;
		for (const unsubscribe of promptUnsubscribes) unsubscribe();
		promptUnsubscribes = [];
		activeTranscriptPath = nextTranscriptPath;
		activePromptSourceKey = nextPromptSourceKey;

		await sendCombinedSnapshot(current);
		if (closed) return true;

		if (current.transcriptPath) {
			const transcriptBuffer = agentStreamBuffer(current.transcriptPath);
			transcriptUnsubscribe = transcriptBuffer.subscribe((event) => {
				if (closed) return;
				if (event.type === "append") {
					sendEvent(res, "append", {
						text: event.content,
						offset: event.offset,
					});
					return;
				}
				void sendCombinedSnapshot(current);
			});
		}

		for (const source of current.promptSources) {
			const buffer = agentStreamBuffer(source.stdoutPath);
			const parser = new DriverPromptEventParser();
			const snapshot = await buffer.getSnapshot();
			parser.reset(0);
			parser.push(
				clipLatestText(snapshot.content, AGENT_STREAM_SNAPSHOT_MAX_CHARS),
			);
			const unsubscribe = buffer.subscribe((event) => {
				if (closed) return;
				if (event.type === "append") {
					for (const prompt of parser.push(event.content)) {
						sendPrompt(res, source.taskId, {
							...prompt,
							turnIndex: ++nextPromptTurnIndex,
						});
					}
					return;
				}
				parser.reset(0);
				parser.push(event.content);
				void sendCombinedSnapshot(current);
			});
			promptUnsubscribes.push(unsubscribe);
		}
		return true;
	};

	if (hasSessionSource(streamRuntime)) {
		await attachSessionSources(streamRuntime);
	} else {
		sendEvent(res, "waiting", {
			reason: streamRuntime.threadId ? "transcript_not_found" : "thread_id",
		});
	}

	const poll = async () => {
		if (closed || polling) return;
		polling = true;
		try {
			const current = await findAgentStreamRuntimeByTaskId(taskId);
			if (!current) {
				sendEvent(res, "stream_error", { code: "task_not_found" });
				cleanup();
				res.end();
				return;
			}
			if (hasSessionSource(current)) {
				await attachSessionSources(current);
			} else {
				sendEvent(res, "waiting", {
					reason: current.threadId ? "transcript_not_found" : "thread_id",
				});
			}
			if (!isLiveStatus(current.runtime.status)) {
				if (!activeTranscriptPath && !activePromptSourceKey) {
					sendEvent(res, "stream_error", {
						code: "source_unavailable",
						message: "Native agent transcript is unavailable",
					});
				}
				sendEvent(res, "done", {
					status: current.runtime.status,
					taskId,
				});
				cleanup();
				res.end();
			}
		} catch (error) {
			sendEvent(res, "stream_error", {
				code: "stream_failure",
				message:
					error instanceof Error ? error.message : "Unknown stream error",
			});
			cleanup();
			res.end();
		} finally {
			polling = false;
		}
	};

	heartbeat = setInterval(() => {
		if (!closed) res.write(": keepalive\n\n");
	}, 15_000);
	statusPoll = setInterval(() => void poll(), 1_000);
	req.on("close", () => {
		cleanup();
		if (!res.writableEnded) res.end();
	});
}
