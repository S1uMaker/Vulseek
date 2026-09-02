import {
	cancelScanJob,
	findScanJobById,
	scoreDatasetEvaluationTrial,
} from "@vulseek/server";
import {
	datasetEvaluations,
	datasetEvaluationTrials,
	datasetProfiles,
	datasetSamples,
	datasets,
	scanJobs,
} from "@vulseek/server/db/schema";
import { createPipelineRun } from "@vulseek/server/services/scan/api/pipeline-runs";
import { type Job, Worker } from "bullmq";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db";
import type { DatasetEvaluationQueueJob } from "./queue-types";
import { datasetEvaluationQueue } from "./queueSetup";
import { redisConfig } from "./redis-connection";

const TERMINAL_SCAN_STATUSES = new Set([
	"finished",
	"partially_finished",
	"failed",
	"canceled",
]);
const activeEvaluations = new Set<string>();

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const getEvaluation = async (evaluationId: string) =>
	await db
		.select({
			evaluation: datasetEvaluations,
			dataset: datasets,
			profile: datasetProfiles,
		})
		.from(datasetEvaluations)
		.innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId))
		.innerJoin(
			datasetProfiles,
			eq(datasetEvaluations.profileId, datasetProfiles.profileId),
		)
		.where(eq(datasetEvaluations.evaluationId, evaluationId))
		.limit(1)
		.then((rows) => rows[0] ?? null);

const getCurrentTrial = async (evaluationId: string) =>
	await db
		.select({ trial: datasetEvaluationTrials, sample: datasetSamples })
		.from(datasetEvaluationTrials)
		.innerJoin(
			datasetSamples,
			eq(datasetEvaluationTrials.sampleId, datasetSamples.sampleId),
		)
		.where(
			and(
				eq(datasetEvaluationTrials.evaluationId, evaluationId),
				inArray(datasetEvaluationTrials.status, ["preparing", "running"]),
			),
		)
		.orderBy(asc(datasetEvaluationTrials.ordinal))
		.limit(1)
		.then((rows) => rows[0] ?? null);

const claimNextTrial = async (evaluationId: string) => {
	const pending = await db
		.select({ trial: datasetEvaluationTrials, sample: datasetSamples })
		.from(datasetEvaluationTrials)
		.innerJoin(
			datasetSamples,
			eq(datasetEvaluationTrials.sampleId, datasetSamples.sampleId),
		)
		.where(
			and(
				eq(datasetEvaluationTrials.evaluationId, evaluationId),
				eq(datasetEvaluationTrials.status, "pending"),
			),
		)
		.orderBy(asc(datasetEvaluationTrials.ordinal))
		.limit(1)
		.then((rows) => rows[0] ?? null);
	if (!pending) return null;
	const claimed = await db
		.update(datasetEvaluationTrials)
		.set({
			status: "preparing",
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(datasetEvaluationTrials.trialId, pending.trial.trialId),
				eq(datasetEvaluationTrials.status, "pending"),
			),
		)
		.returning({ trialId: datasetEvaluationTrials.trialId });
	return claimed[0] ? pending : null;
};

const finishTrial = async (input: {
	trialId: string;
	scanJobId: string;
	status:
		| "completed"
		| "scan_failed"
		| "scoring_failed"
		| "timed_out"
		| "canceled";
	scanJob: Awaited<ReturnType<typeof findScanJobById>>;
	result?: Record<string, unknown>;
	postScanStatus?: "pending" | "running" | "completed" | "failed";
	postScanResult?: Record<string, unknown> | null;
	errorMessage?: string | null;
}) => {
	const startedAt = input.scanJob.startedAt
		? Date.parse(input.scanJob.startedAt)
		: Date.now();
	const finishedAt = input.scanJob.finishedAt
		? Date.parse(input.scanJob.finishedAt)
		: Date.now();
	await db
		.update(datasetEvaluationTrials)
		.set({
			status: input.status,
			scanJobId: input.scanJobId,
			durationMs: Math.max(0, finishedAt - startedAt),
			inputTokens: input.scanJob.inputTokens,
			outputTokens: input.scanJob.outputTokens,
			thoughtTokens: input.scanJob.thoughtTokens,
			totalTokens: input.scanJob.totalTokens,
			estimatedCost: input.scanJob.estimatedCost ?? 0,
			result: {
				scanJobId: input.scanJobId,
				scanStatus: input.scanJob.status,
				...(input.result ?? {}),
			},
			...(input.postScanStatus
				? {
						postScanStatus: input.postScanStatus,
						postScanResult: input.postScanResult ?? null,
					}
				: {}),
			errorMessage: input.errorMessage ?? input.scanJob.errorMessage,
			finishedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(datasetEvaluationTrials.trialId, input.trialId),
				inArray(datasetEvaluationTrials.status, ["preparing", "running"]),
			),
		);
};

const waitForScan = async (
	scanJobId: string,
	evaluationId: string,
	budgetSeconds: number | null,
) => {
	const startedAt = Date.now();
	let pausedAt: number | null = null;
	let pausedDurationMs = 0;
	while (true) {
		const evaluation = await db
			.select({ status: datasetEvaluations.status })
			.from(datasetEvaluations)
			.where(eq(datasetEvaluations.evaluationId, evaluationId))
			.limit(1)
			.then((rows) => rows[0]);
		if (!evaluation || evaluation.status === "canceled") {
			await cancelScanJob(scanJobId, {
				reason: "manual_cancel",
				message: "Evaluation canceled",
			}).catch((error) => {
				console.warn(
					"[dataset-evaluations] scan cancellation failed",
					JSON.stringify({ scanJobId, evaluationId, error: String(error) }),
				);
			});
			return { scanJob: await findScanJobById(scanJobId), timedOut: false };
		}
		if (evaluation.status === "paused") {
			pausedAt ??= Date.now();
			await sleep(1000);
			continue;
		}
		if (pausedAt !== null) {
			pausedDurationMs += Date.now() - pausedAt;
			pausedAt = null;
		}
		const scanJob = await findScanJobById(scanJobId);
		if (TERMINAL_SCAN_STATUSES.has(scanJob.status))
			return { scanJob, timedOut: false };
		if (
			budgetSeconds &&
			Date.now() - startedAt - pausedDurationMs >= budgetSeconds * 1000
		) {
			await cancelScanJob(scanJobId, {
				reason: "evaluation_time_budget",
				message: "Evaluation time budget exceeded",
			}).catch((error) => {
				console.warn(
					"[dataset-evaluations] scan timeout cancellation failed",
					JSON.stringify({ scanJobId, evaluationId, error: String(error) }),
				);
			});
			return { scanJob: await findScanJobById(scanJobId), timedOut: true };
		}
		await sleep(2000);
	}
};

const processTrial = async (input: {
	evaluation: NonNullable<Awaited<ReturnType<typeof getEvaluation>>>;
	trial: typeof datasetEvaluationTrials.$inferSelect;
	sample: typeof datasetSamples.$inferSelect;
}) => {
	let scanJobId = input.trial.scanJobId;
	if (!scanJobId) {
		const existing = await db
			.select({ scanJobId: scanJobs.scanJobId })
			.from(scanJobs)
			.where(eq(scanJobs.datasetEvaluationTrialId, input.trial.trialId))
			.limit(1)
			.then((rows) => rows[0]);
		if (existing) {
			scanJobId = existing.scanJobId;
		} else {
			const title = `${input.evaluation.evaluation.name}: ${input.sample.title || input.sample.id}`;
			const description = `Dataset evaluation trial ${input.trial.trialId}`;
			if (
				!input.evaluation.evaluation.pipelineId ||
				!input.evaluation.evaluation.pipelineVersionId
			) {
				throw new Error("Evaluation has no executable pipeline version");
			}
			const scanJob = await createPipelineRun({
					organizationId: input.evaluation.dataset.organizationId,
					target: { type: "datasetTrial", trialId: input.trial.trialId },
					pipelineId: input.evaluation.evaluation.pipelineId,
					pipelineVersionId: input.evaluation.evaluation.pipelineVersionId,
					pipelineProfileId:
						input.evaluation.evaluation.pipelineProfileId ?? undefined,
					title,
					description,
					scanRuntimeSettings:
						input.evaluation.evaluation.scanRuntimeSettings,
			});
			scanJobId = scanJob.scanJobId;
		}
		await db
			.update(datasetEvaluationTrials)
			.set({
				scanJobId,
				status: "running",
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(datasetEvaluationTrials.trialId, input.trial.trialId),
					eq(datasetEvaluationTrials.status, "preparing"),
				),
			);
	}
	await import("./queueSetup").then(({ scansQueue }) =>
		scansQueue.add(
			"dataset-trial-scan",
			{
				scanJobId: scanJobId as string,
			},
			{
				jobId: `dataset-trial-${scanJobId}`,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
		),
	);
	const outcome = await waitForScan(
		scanJobId,
		input.evaluation.evaluation.evaluationId,
		input.evaluation.evaluation.timeBudgetSeconds,
	);
	const scanJob = outcome.scanJob;
	const shouldRunPostScan =
		outcome.timedOut ||
		scanJob.status === "finished" ||
		scanJob.status === "partially_finished";
	if (shouldRunPostScan) {
		await db
			.update(datasetEvaluationTrials)
			.set({ postScanStatus: "running", updatedAt: new Date().toISOString() })
			.where(
				and(
					eq(datasetEvaluationTrials.trialId, input.trial.trialId),
					inArray(datasetEvaluationTrials.status, ["preparing", "running"]),
				),
			);
		console.log(
			"[dataset-evaluations-worker]",
			JSON.stringify({
				event: "trial.scoring_started",
				evaluationId: input.evaluation.evaluation.evaluationId,
				trialId: input.trial.trialId,
				scanJobId,
			}),
		);
		try {
			const scoring = await scoreDatasetEvaluationTrial({
				trialId: input.trial.trialId,
				scanJobId,
			});
			await finishTrial({
				trialId: input.trial.trialId,
				scanJobId,
				status: outcome.timedOut ? "timed_out" : "completed",
				scanJob,
				result: { scoring },
				postScanStatus: "completed",
				postScanResult: { scoring },
			});
			console.log(
				"[dataset-evaluations-worker]",
				JSON.stringify({
					event: "trial.scoring_completed",
					evaluationId: input.evaluation.evaluation.evaluationId,
					trialId: input.trial.trialId,
					scanJobId,
					jobOutputCount: scoring.jobOutputs.length,
					hitCount: scoring.jobOutputs.filter((output) => output.hit).length,
				}),
			);
			return;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			await finishTrial({
				trialId: input.trial.trialId,
				scanJobId,
				status: outcome.timedOut ? "timed_out" : "scoring_failed",
				scanJob,
				result: { scoring: { status: "failed" } },
				postScanStatus: "failed",
				postScanResult: { status: "failed", errorMessage },
				errorMessage,
			});
			console.error(
				"[dataset-evaluations-worker]",
				JSON.stringify({
					event: "trial.scoring_failed",
					evaluationId: input.evaluation.evaluation.evaluationId,
					trialId: input.trial.trialId,
					scanJobId,
					errorMessage,
				}),
			);
			return;
		}
	}
	await finishTrial({
		trialId: input.trial.trialId,
		scanJobId,
		status: outcome.timedOut
			? "timed_out"
			: scanJob.status === "canceled"
				? "canceled"
				: "scan_failed",
		scanJob,
	});
};

export const runDatasetEvaluation = async (evaluationId: string) => {
	if (activeEvaluations.has(evaluationId)) return;
	activeEvaluations.add(evaluationId);
	try {
		const initial = await getEvaluation(evaluationId);
		if (
			!initial ||
			[
				"canceled",
				"paused",
				"completed",
				"completed_with_errors",
				"failed",
			].includes(initial.evaluation.status)
		)
			return;
		await db
			.update(datasetEvaluations)
			.set({
				status: "running",
				startedAt: initial.evaluation.startedAt || new Date().toISOString(),
				errorMessage: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(datasetEvaluations.evaluationId, evaluationId));
		while (true) {
			const current = await getEvaluation(evaluationId);
			if (!current || current.evaluation.status === "canceled") return;
			if (current.evaluation.status === "paused") {
				await sleep(1000);
				continue;
			}
			const active = await getCurrentTrial(evaluationId);
			const claimed = active || (await claimNextTrial(evaluationId));
			if (!claimed) break;
			const stateBeforeLaunch = await getEvaluation(evaluationId);
			if (stateBeforeLaunch?.evaluation.status === "paused" && !active) {
				await db
					.update(datasetEvaluationTrials)
					.set({
						status: "pending",
						startedAt: null,
						updatedAt: new Date().toISOString(),
					})
					.where(
						and(
							eq(datasetEvaluationTrials.trialId, claimed.trial.trialId),
							eq(datasetEvaluationTrials.status, "preparing"),
						),
					);
				continue;
			}
			await processTrial({
				evaluation: current,
				trial: claimed.trial,
				sample: claimed.sample,
			});
		}
		const finalEvaluation = await getEvaluation(evaluationId);
		if (!finalEvaluation || finalEvaluation.evaluation.status === "canceled")
			return;
		const trialRows = await db
			.select()
			.from(datasetEvaluationTrials)
			.where(eq(datasetEvaluationTrials.evaluationId, evaluationId))
			.orderBy(asc(datasetEvaluationTrials.ordinal));
		const completedWithErrors = trialRows.some(
			(row) => row.status !== "completed",
		);
		await db
			.update(datasetEvaluations)
			.set({
				status: completedWithErrors ? "completed_with_errors" : "completed",
				finishedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(datasetEvaluations.evaluationId, evaluationId));
	} catch (error) {
		await db
			.update(datasetEvaluations)
			.set({
				status: "failed",
				errorMessage: (error instanceof Error
					? error.message
					: String(error)
				).slice(0, 4000),
				finishedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(datasetEvaluations.evaluationId, evaluationId))
			.catch(() => {});
		throw error;
	} finally {
		activeEvaluations.delete(evaluationId);
	}
};

export const recoverPendingDatasetEvaluations = async () => {
	const rows = await db
		.select({ evaluationId: datasetEvaluations.evaluationId })
		.from(datasetEvaluations)
		.where(inArray(datasetEvaluations.status, ["pending", "running"]));
	for (const row of rows) {
		await datasetEvaluationQueue
			.add(
				"dataset-evaluation-recovery",
				{ evaluationId: row.evaluationId },
				{
					jobId: `recovery-${row.evaluationId}`,
					removeOnComplete: 100,
					removeOnFail: 100,
				},
			)
			.catch(() => {});
	}
};

export const datasetEvaluationsWorker = new Worker<DatasetEvaluationQueueJob>(
	"dataset-evaluations",
	async (job: Job<DatasetEvaluationQueueJob>) => {
		await runDatasetEvaluation(job.data.evaluationId);
	},
	{ autorun: false, connection: redisConfig, concurrency: 1 },
);
