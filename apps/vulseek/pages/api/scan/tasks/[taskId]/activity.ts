import {
	driverStdoutTailReader,
	findAgentTaskRuntimeByTaskId,
	findScanJobOrganizationId,
	validateRequest,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	type AgentActivity,
	type AgentActivityMetadata,
	idleAgentActivity,
} from "@/lib/scan/agent-activity";

const ACTIVE_STATUSES = new Set([
	"launching",
	"launched",
	"starting",
	"running",
]);

const sendEvent = (res: NextApiResponse, event: string, payload: unknown) => {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
};

const readSnapshot = async (filePath: string) => {
	const protocol = await driverStdoutTailReader.read(filePath);
	return {
		activity: protocol.latestActivity as AgentActivity | null,
		activityRevision: protocol.activityRevision,
		activityEvents: protocol.activityEvents,
		signature: JSON.stringify({
			activity: protocol.latestActivity,
			activityRevision: protocol.activityRevision,
			usage: protocol.latestUsage,
			task: protocol.latestTask,
			log: protocol.latestLog,
			exitCode: protocol.exitCode,
		}),
	};
};

const metadataFor = (
	runtime: NonNullable<
		Awaited<ReturnType<typeof findAgentTaskRuntimeByTaskId>>
	>,
): AgentActivityMetadata => ({
	taskId: runtime.taskId,
	scanJobId: runtime.scanJobId,
	taskKind: runtime.taskKind,
	containerName: runtime.containerName,
	provider: runtime.provider,
	status: runtime.status,
	sessionId: runtime.sessionId,
});

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		res.status(405).json({ message: "Method not allowed" });
		return;
	}
	const taskId = typeof req.query.taskId === "string" ? req.query.taskId : "";
	if (!taskId) {
		res.status(400).json({ message: "Invalid task id" });
		return;
	}
	const [{ user, session }, runtime] = await Promise.all([
		validateRequest(req),
		findAgentTaskRuntimeByTaskId(taskId),
	]);
	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}
	if (!runtime) {
		res.status(404).json({ message: "Task not found" });
		return;
	}
	if (
		(await findScanJobOrganizationId(runtime.scanJobId)) !==
		session.activeOrganizationId
	) {
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
	let revision: string | null = null;
	let activityRevision = 0;
	const cleanup = () => {
		closed = true;
		clearInterval(heartbeat);
	};
	const publish = async (initial = false) => {
		const latest = await findAgentTaskRuntimeByTaskId(taskId);
		if (!latest) {
			sendEvent(res, "done", { taskId, status: "missing" });
			cleanup();
			res.end();
			return;
		}
		const snapshot = await readSnapshot(latest.stdoutPath);
		const activity: AgentActivity = snapshot?.activity || idleAgentActivity;
		if (initial) {
			sendEvent(res, "snapshot", { metadata: metadataFor(latest), activity });
			activityRevision = snapshot?.activityRevision || 0;
		} else if (snapshot && snapshot.signature !== revision) {
			if (snapshot.activityRevision < activityRevision) activityRevision = 0;
			const nextActivities = snapshot.activityEvents.filter(
				(event) => event.revision > activityRevision,
			);
			if (nextActivities.length) {
				for (const next of nextActivities) {
					sendEvent(res, "activity", {
						metadata: metadataFor(latest),
						activity: next.activity,
					});
				}
				activityRevision = snapshot.activityRevision;
			} else {
				sendEvent(res, "activity", { metadata: metadataFor(latest), activity });
			}
		}
		if (snapshot) revision = snapshot.signature;
		if (!ACTIVE_STATUSES.has(latest.status)) {
			sendEvent(res, "done", { taskId, status: latest.status });
			cleanup();
			res.end();
		}
	};
	const schedulePoll = () => {
		if (closed) return;
		setTimeout(() => {
			void publish()
				.catch((error) => {
					sendEvent(res, "activity_error", {
						message: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(schedulePoll);
		}, 750);
	};
	const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
	req.on("close", cleanup);
	await publish(true);
	if (closed) return;
	schedulePoll();
}
