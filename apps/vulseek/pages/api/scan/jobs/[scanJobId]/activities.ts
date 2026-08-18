import {
	type AgentTaskRuntime,
	driverStdoutTailReader,
	findRunningAgentTaskRuntimesByScanJobId,
	findScanJobOrganizationId,
	findScanJobStatusById,
	validateRequest,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	type AgentActivityMetadata,
	idleAgentActivity,
} from "@/lib/scan/agent-activity";

const sendEvent = (res: NextApiResponse, event: string, payload: unknown) => {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
};

const readSnapshot = async (filePath: string) => {
	const protocol = await driverStdoutTailReader.read(filePath);
	return {
		activity: protocol.latestActivity,
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

const metadataFor = (runtime: AgentTaskRuntime): AgentActivityMetadata => ({
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
	const scanJobId =
		typeof req.query.scanJobId === "string" ? req.query.scanJobId : "";
	if (!scanJobId) {
		res.status(400).json({ message: "Invalid scan job id" });
		return;
	}
	const { user, session } = await validateRequest(req);
	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}
	if (
		(await findScanJobOrganizationId(scanJobId)) !==
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
	const revisions = new Map<string, string>();
	const activityRevisions = new Map<string, number>();
	const activeTaskIds = new Set<string>();
	let closed = false;
	const cleanup = () => {
		closed = true;
		clearInterval(heartbeat);
	};
	const loadTasks = async () =>
		await Promise.all(
			(await findRunningAgentTaskRuntimesByScanJobId(scanJobId)).map(
				async (runtime) => {
					const snapshot = await readSnapshot(runtime.stdoutPath);
					return {
						taskId: runtime.taskId,
						metadata: metadataFor(runtime),
						activity: snapshot?.activity || idleAgentActivity,
						activityRevision: snapshot?.activityRevision || 0,
						activityEvents: snapshot?.activityEvents || [],
						revision: snapshot?.signature || "",
					};
				},
			),
		);
	const publish = async (initial = false) => {
		const tasks = await loadTasks();
		const currentIds = new Set(tasks.map((task) => task.taskId));
		if (initial) {
			sendEvent(res, "snapshot", {
				tasks: tasks.map(({ activityRevision, activityEvents, ...task }) => task),
			});
		}
		for (const task of tasks) {
			if (!initial && revisions.get(task.taskId) !== task.revision) {
				const previousActivityRevision =
					task.activityRevision < (activityRevisions.get(task.taskId) || 0)
						? 0
						: activityRevisions.get(task.taskId) || 0;
				const nextActivities = task.activityEvents.filter(
					(event) => event.revision > previousActivityRevision,
				);
				if (nextActivities.length) {
					for (const next of nextActivities) {
						const { activityRevision, activityEvents, ...payload } = task;
						sendEvent(res, "activity", { ...payload, activity: next.activity });
					}
				} else {
					const { activityRevision, activityEvents, ...payload } = task;
					sendEvent(res, "activity", payload);
				}
			}
			revisions.set(task.taskId, task.revision);
			activityRevisions.set(task.taskId, task.activityRevision);
			activeTaskIds.add(task.taskId);
		}
		for (const taskId of activeTaskIds) {
			if (!currentIds.has(taskId)) {
				sendEvent(res, "done", { taskId });
				activeTaskIds.delete(taskId);
				revisions.delete(taskId);
				activityRevisions.delete(taskId);
			}
		}
		const status = await findScanJobStatusById(scanJobId);
		if (status !== "pending" && status !== "running") {
			sendEvent(res, "done", { taskId: null, status });
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
		}, 1000);
	};
	const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
	req.on("close", cleanup);
	await publish(true);
	if (closed) return;
	schedulePoll();
}
