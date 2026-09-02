import { closeDbConnection, db } from "@vulseek/server/db";
import { cancelScanJob } from "@vulseek/server";
import { scanJobs, messages, tasks } from "@vulseek/server/db/schema";
import { Queue } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redisConfig } from "../queues/redis-connection";

const execFileAsync = promisify(execFile);

const OPEN_TASK_STATUSES = [
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
] as const;
const OPEN_DISPATCH_STATUSES = ["pending", "processing"] as const;
const TERMINAL_JOB_STATUSES = [
	"finalizing",
	"finished",
	"partially_finished",
	"failed",
	"canceled",
] as const;
const isTerminalJobStatus = (
	status: string,
): status is (typeof TERMINAL_JOB_STATUSES)[number] =>
	(TERMINAL_JOB_STATUSES as readonly string[]).includes(status);

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const scanJobFlag = args.find((arg) => arg.startsWith("--scan-job-id="));
const scanJobId = scanJobFlag
	? scanJobFlag.slice("--scan-job-id=".length)
	: (() => {
			const index = args.indexOf("--scan-job-id");
			return index >= 0 ? args[index + 1] : undefined;
		})();

const fail = (message: string): never => {
	console.error(message);
	process.exitCode = 2;
	throw new Error(message);
};

const countOrDeleteRedisKeys = async (target: string, shouldDelete: boolean) => {
	const queue = new Queue("scan-job-consistency-repair", {
		connection: redisConfig,
	});
	try {
		const client = await queue.client;
		let cursor = "0";
		let count = 0;
		do {
			const [nextCursor, keys] = await client.scan(
				cursor,
				"MATCH",
				`*${target}*`,
				"COUNT",
				500,
			);
			cursor = nextCursor;
			count += keys.length;
			if (shouldDelete && keys.length > 0) {
				await client.del(...keys);
			}
		} while (cursor !== "0");
		return count;
	} finally {
		await queue.close();
	}
};

const removeMatchingContainers = async (target: string, shouldDelete: boolean) => {
	const { stdout } = await execFileAsync("docker", [
		"ps",
		"-aq",
		"--filter",
		`name=${target}`,
	]);
	const containerIds = stdout.split(/\s+/).filter(Boolean);
	if (shouldDelete && containerIds.length > 0) {
		await execFileAsync("docker", ["rm", "-f", ...containerIds]);
	}
	return containerIds.length;
};

const repairDbState = async (scanJobId: string) =>
	await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ scanJobId: scanJobs.scanJobId })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, scanJobId))
			.for("update");
		if (!locked) return { tasks: 0, dispatch: 0 };
		const canceledTasks = await tx
			.update(tasks)
			.set({
				status: "canceled",
				errorMessage: "Consistency repair",
				completedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(tasks.scanJobId, scanJobId),
					inArray(tasks.status, [...OPEN_TASK_STATUSES]),
				),
			)
			.returning({ taskId: tasks.taskId });
		const producerIds = canceledTasks.map((row) => row.taskId);
		const allProducerIds = (
			await tx
				.select({ taskId: tasks.taskId })
				.from(tasks)
				.where(eq(tasks.scanJobId, scanJobId))
		).map((row) => row.taskId);
		const closedDispatch =
			allProducerIds.length === 0
				? []
				: await tx
						.update(messages)
						.set({
							dispatchStatus: "failed",
							errorMessage: "Consistency repair",
							updatedAt: new Date().toISOString(),
						})
						.where(
							and(
								inArray(messages.sourceTaskId, allProducerIds),
								inArray(messages.status, [
									...OPEN_DISPATCH_STATUSES,
								]),
							),
						)
						.returning({ taskId: messages.sourceTaskId });
		void producerIds;
		return { tasks: canceledTasks.length, dispatch: closedDispatch.length };
	});

if (args.some((arg) => arg !== "--apply" && arg !== "--scan-job-id" && !arg.startsWith("--scan-job-id="))) {
	fail("Usage: repair-scan-job-consistency [--apply] [--scan-job-id <id>]");
}
if (args.includes("--scan-job-id") && !scanJobId) {
	fail("--scan-job-id requires a value");
}

	try {
		const jobs = await db
			.select({ scanJobId: scanJobs.scanJobId, status: scanJobs.status })
			.from(scanJobs)
			.where(
				scanJobId
					? eq(scanJobs.scanJobId, scanJobId)
					: inArray(scanJobs.status, [...TERMINAL_JOB_STATUSES]),
			);

		const report: Array<Record<string, unknown>> = [];
		for (const job of jobs) {
			const [counts] = await db
				.select({
					openTasks: sql<number>`count(*) filter (where ${inArray(tasks.status, [...OPEN_TASK_STATUSES])})`,
					openDispatch: sql<number>`count(*) filter (where ${inArray(messages.status, [...OPEN_DISPATCH_STATUSES])})`,
				})
				.from(tasks)
				.leftJoin(messages, eq(messages.sourceTaskId, tasks.taskId))
				.where(eq(tasks.scanJobId, job.scanJobId));
			const openTasks = Number(counts?.openTasks ?? 0);
			const openDispatch = Number(counts?.openDispatch ?? 0);
			const item = {
				scanJobId: job.scanJobId,
				status: job.status,
				openTasks,
				openDispatch,
				wouldChange: openTasks > 0 || openDispatch > 0,
			};
		if (!apply) {
			report.push(item);
			continue;
		}

		if (isTerminalJobStatus(job.status)) {
			const repaired = await repairDbState(job.scanJobId);
			const [redisKeys, containers] = await Promise.all([
				countOrDeleteRedisKeys(job.scanJobId, true),
				removeMatchingContainers(job.scanJobId, true),
			]);
			report.push({
				...item,
				applied: true,
				dbRepair: repaired,
				redisKeys,
				containers,
			});
			continue;
		}

		try {
			const result = await cancelScanJob(job.scanJobId, {
				reason: "manual_cancel",
				message: "Consistency repair",
			});
			const [redisKeys, containers] = await Promise.all([
				countOrDeleteRedisKeys(job.scanJobId, true),
				removeMatchingContainers(job.scanJobId, true),
			]);
			report.push({ ...item, applied: true, cleanup: result, redisKeys, containers });
		} catch (error) {
			// Keep the DB repair available even when an old pipeline snapshot cannot
			// be reconstructed for external queue/container cleanup.
			const repaired = await repairDbState(job.scanJobId);
			const [redisKeys, containers] = await Promise.all([
				countOrDeleteRedisKeys(job.scanJobId, true),
				removeMatchingContainers(job.scanJobId, true),
			]);
			report.push({
				...item,
				applied: true,
				cleanup: "unavailable",
				dbRepair: repaired,
				redisKeys,
				containers,
				error: String(error),
			});
		}
	}

	console.log(JSON.stringify({ apply, scanJobId: scanJobId ?? null, jobs: report }, null, 2));
} finally {
	await closeDbConnection();
}
