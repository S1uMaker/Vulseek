import { TRPCError } from "@trpc/server";
import {
	authorizeScanJobAccess,
	cancelScanJob,
	cancelScanTask,
	canRebuildCheckoutTools,
	deleteScanJobForOrganization,
	findApplicationById,
	findCandidateTaskLineage,
	findCheckoutImageStatus,
	findCheckoutStatus,
	findCheckoutToolsBuildStatus,
	findCheckoutToolsStatus,
	findComposeById,
	findFullScanStageGraph,
	findResearchFindingRepo,
	findRunningCheckoutTask,
	findScanJobById,
	findScanJobResultSummary,
	findScanJobStageGraph,
	findScanJobsByApplicationIdPage,
	findScanJobsByComposeIdPage,
	findScanJobTerminalTasksPage,
	findTaskById,
	findTobGoalCandidateRepo,
	findTobGoalFindingRepo,
	findVulnerabilityCandidateById,
	findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId,
	findVulnerabilityCandidateWithLatestAnalysisResultById,
	getScanHomeOverview,
	getScanHomeOverviewActivity,
	getScanHomeOverviewSummary,
	getScanHomeOverviewWorkload,
	getScanPipelineDefinitions,
	getScanPipelineYaml,
	listCandidateDirectory,
	listCandidateTags,
	listExploitChainsPageRepo,
	listExploitPrimitivesPageRepo,
	listMessagesPageBySourceTaskIdRepo,
	listResearchFindingsPageRepo,
	listResearchTracksPageRepo,
	listScanJobDirectory,
	listScanTaskDirectory,
	listTobGoalCandidatesPageRepo,
	listTobGoalFindingsPageRepo,
	pauseScanJob,
	queryJobTabData,
	queryJobTabDetail,
	readCandidateFileContent,
	readScanJobFileContent,
	readScanTaskFileContent,
	reconstructTaskInput,
	rerunScanTask,
	resumeScanJob,
	retryFailedScanJobTasks,
	startCandidateAnalysis,
	startCandidateReviewContainer,
	startCandidateVerification,
	startCheckoutScanEnvironment,
	startCheckoutToolsBuild,
	syncFullScanTasksFromArtifacts,
	updateScanJobNote,
	updateScanJobPipelineDefinitionSnapshot,
	updateScanJobRuntimeSettings,
	updateVulnerabilityCandidateMetadata,
} from "@vulseek/server";
import { z } from "zod";
import {
	apiCheckoutScanEnvironment,
	apiFindCheckoutStatus,
	apiFindOneScanJob,
	apiFindRunningCheckout,
	apiListScanJobsByApplication,
	apiListScanJobsByCompose,
	apiUpdateScanJobNote,
	ScanRuntimeSettingsSchema,
} from "@/server/db/schema";
import type { ScanQueueJob } from "@/server/queues/queue-types";
import { scansQueue } from "@/server/queues/queueSetup";
import { jobRuntimeStatusStore } from "../../scan/job-runtime-cache";
import { apiFindResearchRegistryPageByScanJob } from "../schemas/research-registry";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const apiFindVulnerabilityCandidatesPageByScanJob = z
	.object({
		scanJobId: z.string().min(1),
		page: z.number().int().min(1).default(1),
		pageSize: z.number().int().min(1).max(100).default(20),
		query: z.string().default(""),
		analysisResults: z.string().default(""),
		verifyResults: z.string().default(""),
		triageResults: z.string().default(""),
		sortKey: z
			.enum([
				"latestResultUpdatedAt",
				"createdAt",
				"candidate",
				"analysis",
				"verify",
				"score",
			])
			.default("latestResultUpdatedAt"),
		sortDirection: z.enum(["asc", "desc"]).default("desc"),
	})
	.required();

const parseCsvFilter = (value: string) =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const authorizeScanJobRuntimeAccess = async (
	scanJobId: string,
	activeOrganizationId: string | null | undefined,
) => {
	await authorizeScanJobAccess(scanJobId, activeOrganizationId);
};

const apiUpdateCandidateMetadata = z.object({
	vulnerabilityCandidateId: z.string().min(1),
	scanJobId: z.string().min(1),
	producerTaskId: z.string().min(1).optional(),
	note: z.string().max(10000).default(""),
	tags: z.array(z.string().min(1).max(64)).max(50).default([]),
});

const apiFindScanJobTerminalTasksPage = z
	.object({
		scanJobId: z.string().min(1),
		page: z.number().int().min(1).default(1),
		pageSize: z.number().int().min(1).max(100).default(20),
		query: z.string().default(""),
		stage: z.string().default("all"),
		status: z.string().default("all"),
	})
	.required();

const apiFindFullScanStageGraph = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		pipelineId: z.string().min(1),
	})
	.refine(
		(value) => Boolean(value.applicationId) !== Boolean(value.composeId),
		{
			message: "Provide exactly one target: applicationId or composeId",
			path: ["applicationId"],
		},
	);

const apiUpdateScanRuntimeSettings = z.object({
	scanJobId: z.string().min(1),
	scanRuntimeSettings: ScanRuntimeSettingsSchema,
});

const apiUpdateScanPipelineDefinitionSnapshot = z.object({
	scanJobId: z.string().min(1),
	scanPipelineDefinitionSnapshot: z.record(z.unknown()),
});

const apiStartCandidateReviewContainer = z.object({
	scanJobId: z.string().min(1),
	candidateIds: z.array(z.string().min(1)).min(1),
});

export const scanRouter = createTRPCRouter({
	pipelineDefinitions: protectedProcedure.query(async () =>
		getScanPipelineDefinitions(),
	),

	pipelineYaml: protectedProcedure.query(async () => ({
		yaml: getScanPipelineYaml(),
	})),

	homeSummary: protectedProcedure.query(async ({ ctx }) => {
		if (!ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "No active organization selected",
			});
		}
		return await getScanHomeOverviewSummary(ctx.session.activeOrganizationId);
	}),

	homeActivity: protectedProcedure
		.input(
			z
				.object({
					days: z.number().int().min(1).max(366).optional(),
				})
				.optional(),
		)
		.query(async ({ input, ctx }) => {
			if (!ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "No active organization selected",
				});
			}
			return await getScanHomeOverviewActivity({
				organizationId: ctx.session.activeOrganizationId,
				days: input?.days,
			});
		}),

	homeWorkload: protectedProcedure.query(async ({ ctx }) => {
		if (!ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "No active organization selected",
			});
		}
		return await getScanHomeOverviewWorkload(ctx.session.activeOrganizationId);
	}),

	homeOverview: protectedProcedure
		.input(
			z
				.object({
					days: z.number().int().min(1).max(366).optional(),
				})
				.optional(),
		)
		.query(async ({ input, ctx }) => {
			if (!ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "No active organization selected",
				});
			}
			return await getScanHomeOverview({
				organizationId: ctx.session.activeOrganizationId,
				days: input?.days,
			});
		}),

	checkoutToolsStatus: protectedProcedure.query(
		async ({ ctx }) =>
			await findCheckoutToolsStatus(canRebuildCheckoutTools(ctx.user.role)),
	),

	rebuildCheckoutTools: protectedProcedure.mutation(async ({ ctx }) => {
		if (!canRebuildCheckoutTools(ctx.user.role)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to rebuild checkout tools",
			});
		}
		const build = await startCheckoutToolsBuild();
		return {
			buildId: build.buildId,
			version: build.version,
			imageTag: build.imageTag,
			status: build.status,
		};
	}),

	checkoutToolsBuildStatus: protectedProcedure
		.input(z.object({ buildId: z.string().min(1) }).required())
		.query(({ input }) => findCheckoutToolsBuildStatus(input.buildId)),

	delete: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			if (ctx.user.role === "member") {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Only owners and admins can delete scan jobs",
				});
			}
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return deleteScanJobForOrganization({
				scanJobId: input.scanJobId,
				organizationId: ctx.session.activeOrganizationId,
			});
		}),

	checkout: protectedProcedure
		.input(apiCheckoutScanEnvironment)
		.mutation(async ({ input, ctx }) => {
			const toolsStatus = await findCheckoutToolsStatus(false);
			if (!toolsStatus.exists) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Checkout tools image ${toolsStatus.imageTag} is not available; build the tools image before checkout`,
				});
			}
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to checkout this application",
					});
				}
			}
			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to checkout this compose",
					});
				}
			}

			return await startCheckoutScanEnvironment(input);
		}),

	checkoutStatus: protectedProcedure
		.input(apiFindCheckoutStatus)
		.query(async ({ input, ctx }) => {
			const status = await findCheckoutStatus(input.checkoutId);
			if (!status) {
				return null;
			}
			if (status.applicationId) {
				const application = await findApplicationById(status.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this checkout task",
					});
				}
			}
			if (status.composeId) {
				const compose = await findComposeById(status.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this checkout task",
					});
				}
			}
			return status;
		}),
	checkoutImageStatus: protectedProcedure
		.input(apiCheckoutScanEnvironment)
		.query(async ({ input, ctx }) => {
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this application",
					});
				}
			}
			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this compose",
					});
				}
			}
			return await findCheckoutImageStatus(input);
		}),
	runningCheckout: protectedProcedure
		.input(apiFindRunningCheckout)
		.query(async ({ input, ctx }) => {
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this application",
					});
				}
			}
			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this compose",
					});
				}
			}
			return await findRunningCheckoutTask(input);
		}),

	listByApplication: protectedProcedure
		.input(apiListScanJobsByApplication)
		.query(async ({ input, ctx }) => {
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access scan jobs for this application",
				});
			}

			return await findScanJobsByApplicationIdPage(input.applicationId, {
				page: input.page,
				pageSize: input.pageSize,
				search: input.search,
				status: input.status,
			});
		}),

	listByCompose: protectedProcedure
		.input(apiListScanJobsByCompose)
		.query(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);
			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access scan jobs for this compose",
				});
			}

			return await findScanJobsByComposeIdPage(input.composeId, {
				page: input.page,
				pageSize: input.pageSize,
				search: input.search,
				status: input.status,
			});
		}),

	one: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined = scanJob.datasetEvaluationTrialId
				? (ctx.session.activeOrganizationId ?? undefined)
				: undefined;
			if (scanJob.datasetEvaluationTrialId)
				await authorizeScanJobAccess(
					scanJob.scanJobId,
					ctx.session.activeOrganizationId,
				);
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this scan job",
				});
			}

			return scanJob;
		}),

	task: protectedProcedure
		.input(
			z.object({
				taskId: z.string().min(1),
				scanJobId: z.string().min(1).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const task = await findTaskById(input.taskId);
			if (input.scanJobId && task.scanJobId !== input.scanJobId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Task not found for this scan job",
				});
			}

			const scanJob = await findScanJobById(task.scanJobId);
			let organizationId: string | undefined = scanJob.datasetEvaluationTrialId
				? (ctx.session.activeOrganizationId ?? undefined)
				: undefined;
			if (scanJob.datasetEvaluationTrialId)
				await authorizeScanJobAccess(
					scanJob.scanJobId,
					ctx.session.activeOrganizationId,
				);
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this scan task",
				});
			}

			let reconstructedInput: unknown = null;
			try {
				reconstructedInput = await reconstructTaskInput(task);
			} catch {
				reconstructedInput = null;
			}
			const taskOutputPage = await listMessagesPageBySourceTaskIdRepo({
				sourceTaskId: task.taskId,
				limit: 50,
				offset: 0,
			});
			return {
				task,
				scanJob,
				reconstructedInput,
				messages: {
					items: taskOutputPage.rows,
					total: taskOutputPage.total,
				},
			};
		}),

	messages: protectedProcedure
		.input(
			z.object({
				taskId: z.string().min(1),
				page: z.number().int().min(1).default(1),
				pageSize: z.number().int().min(1).max(100).default(20),
			}),
		)
		.query(async ({ input, ctx }) => {
			const task = await findTaskById(input.taskId);
			await authorizeScanJobAccess(
				task.scanJobId,
				ctx.session.activeOrganizationId,
			);
			const offset = (input.page - 1) * input.pageSize;
			const result = await listMessagesPageBySourceTaskIdRepo({
				sourceTaskId: task.taskId,
				limit: input.pageSize,
				offset,
			});
			return {
				items: result.rows,
				total: result.total,
				page: input.page,
				pageSize: input.pageSize,
			};
		}),

	cancelTask: protectedProcedure
		.input(z.object({ taskId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const task = await findTaskById(input.taskId);
			await authorizeScanJobAccess(
				task.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await cancelScanTask(input.taskId);
		}),

	updateNote: protectedProcedure
		.input(apiUpdateScanJobNote)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this scan job",
				});
			}

			const note = input.note?.trim() ? input.note.trim() : null;
			return await updateScanJobNote(input.scanJobId, note);
		}),

	updateRuntimeSettings: protectedProcedure
		.input(apiUpdateScanRuntimeSettings)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this scan job",
				});
			}

			const updated = await updateScanJobRuntimeSettings(
				input.scanJobId,
				input.scanRuntimeSettings,
			);
			jobRuntimeStatusStore.invalidateOverview(input.scanJobId);
			jobRuntimeStatusStore.invalidatePipeline(input.scanJobId);
			return updated;
		}),

	updatePipelineDefinitionSnapshot: protectedProcedure
		.input(apiUpdateScanPipelineDefinitionSnapshot)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this scan job",
				});
			}

			const updated = await updateScanJobPipelineDefinitionSnapshot(
				input.scanJobId,
				input.scanPipelineDefinitionSnapshot,
			);
			jobRuntimeStatusStore.invalidatePipeline(input.scanJobId);
			return updated;
		}),

	cancel: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);

			const cancellation = await cancelScanJob(input.scanJobId);
			await Promise.all([
				scansQueue
					.getJob(`scan:${input.scanJobId}`)
					.then((job) => job?.remove())
					.catch((error) =>
						console.warn(
							"[scan-cancel] root queue cleanup failed",
							JSON.stringify({
								scanJobId: input.scanJobId,
								error: String(error),
							}),
						),
					),
				scansQueue
					.getJob(`scan:retry:${input.scanJobId}`)
					.then((job) => job?.remove())
					.catch((error) =>
						console.warn(
							"[scan-cancel] retry queue cleanup failed",
							JSON.stringify({
								scanJobId: input.scanJobId,
								error: String(error),
							}),
						),
					),
				scansQueue
					.getJob(`scan:retry-analysis:${input.scanJobId}`)
					.then((job) => job?.remove())
					.catch((error) =>
						console.warn(
							"[scan-cancel] analysis retry queue cleanup failed",
							JSON.stringify({
								scanJobId: input.scanJobId,
								error: String(error),
							}),
						),
					),
				scansQueue
					.getJob(`scan:retry-verification:${input.scanJobId}`)
					.then((job) => job?.remove())
					.catch((error) =>
						console.warn(
							"[scan-cancel] verification retry queue cleanup failed",
							JSON.stringify({
								scanJobId: input.scanJobId,
								error: String(error),
							}),
						),
					),
			]);

			return cancellation;
		}),

	pause: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await pauseScanJob(input.scanJobId);
		}),

	resume: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await resumeScanJob(input.scanJobId);
		}),

	syncArtifacts: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to sync this scan job",
				});
			}

			return await syncFullScanTasksFromArtifacts(input.scanJobId);
		}),

	retryFailedTasks: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			const scanJob = await findScanJobById(input.scanJobId);

			const result = await retryFailedScanJobTasks(input.scanJobId);
			const queueData: ScanQueueJob = { scanJobId: scanJob.scanJobId };

			await scansQueue.add("scans", queueData, {
				jobId: `scan:retry:${scanJob.scanJobId}`,
				removeOnComplete: true,
				removeOnFail: true,
			});

			return result;
		}),

	rerunTask: protectedProcedure
		.input(z.object({ taskId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const sourceTask = await findTaskById(input.taskId);
			await authorizeScanJobAccess(
				sourceTask.scanJobId,
				ctx.session.activeOrganizationId,
			);

			const result = await rerunScanTask(input.taskId);
			const queueData: ScanQueueJob = { scanJobId: result.task.scanJobId };

			await scansQueue.add("scans", queueData, {
				jobId: `scan:rerun-task:${result.task.scanJobId}:${result.task.taskId}`,
				removeOnComplete: true,
				removeOnFail: true,
			});

			return result;
		}),

	candidates: protectedProcedure
		.input(apiFindVulnerabilityCandidatesPageByScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);

			return await findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId(
				{
					...input,
					analysisResults: parseCsvFilter(input.analysisResults),
					verifyResults: parseCsvFilter(input.verifyResults),
					triageResults: parseCsvFilter(input.triageResults),
				},
			);
		}),

	researchTracks: protectedProcedure
		.input(apiFindResearchRegistryPageByScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await listResearchTracksPageRepo(input);
		}),

	researchFindings: protectedProcedure
		.input(apiFindResearchRegistryPageByScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await listResearchFindingsPageRepo(input);
		}),

	tobGoalCandidates: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				page: z.number().int().min(1).default(1),
				pageSize: z.number().int().min(1).max(100).default(20),
				status: z.string().optional(),
				huntGoalId: z.string().optional(),
				query: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await listTobGoalCandidatesPageRepo(input);
		}),

	tobGoalFindings: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				page: z.number().int().min(1).default(1),
				pageSize: z.number().int().min(1).max(100).default(20),
				status: z.string().optional(),
				huntGoalId: z.string().optional(),
				query: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await listTobGoalFindingsPageRepo(input);
		}),

	tobGoalCandidate: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				candidateId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await findTobGoalCandidateRepo(input);
		}),

	tobGoalFinding: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				findingId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await findTobGoalFindingRepo(input);
		}),

	researchFinding: protectedProcedure
		.input(
			z.object({ scanJobId: z.string().min(1), findingId: z.string().min(1) }),
		)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await findResearchFindingRepo(input);
		}),

	exploitPrimitives: protectedProcedure
		.input(apiFindResearchRegistryPageByScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await listExploitPrimitivesPageRepo(input);
		}),

	exploitChains: protectedProcedure
		.input(apiFindResearchRegistryPageByScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await listExploitChainsPageRepo(input);
		}),

	jobTabData: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				tabId: z.string().min(1),
				page: z.number().int().min(1).default(1),
				pageSize: z.number().int().min(1).max(100).default(20),
				query: z.string().optional(),
				sortField: z.string().optional(),
				sortDirection: z.enum(["asc", "desc"]).optional(),
				filters: z.record(z.array(z.string())).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return queryJobTabData(input);
		}),

	jobTabDetail: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				tabId: z.string().min(1),
				itemId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return queryJobTabDetail(input);
		}),

	resultSummary: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined = scanJob.datasetEvaluationTrialId
				? await authorizeScanJobAccess(
						scanJob.scanJobId,
						ctx.session.activeOrganizationId,
					)
				: undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access result summary for this scan job",
				});
			}

			return await findScanJobResultSummary(input.scanJobId);
		}),

	listDirectory: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string(),
				directoryPath: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined = scanJob.datasetEvaluationTrialId
				? await authorizeScanJobAccess(
						scanJob.scanJobId,
						ctx.session.activeOrganizationId,
					)
				: undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access files for this scan job",
				});
			}

			return await listScanJobDirectory(input);
		}),

	readFile: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string(),
				filePath: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined = scanJob.datasetEvaluationTrialId
				? await authorizeScanJobAccess(
						scanJob.scanJobId,
						ctx.session.activeOrganizationId,
					)
				: undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access files for this scan job",
				});
			}

			return await readScanJobFileContent(input);
		}),

	listTaskDirectory: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				taskId: z.string().min(1),
				directoryPath: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const task = await findTaskById(input.taskId);
			if (task.scanJobId !== input.scanJobId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Task not found for this scan job",
				});
			}
			const scanJob = await findScanJobById(task.scanJobId);
			let organizationId: string | undefined = scanJob.datasetEvaluationTrialId
				? await authorizeScanJobAccess(
						scanJob.scanJobId,
						ctx.session.activeOrganizationId,
					)
				: undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access files for this scan task",
				});
			}

			return await listScanTaskDirectory(input);
		}),

	readTaskFile: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				taskId: z.string().min(1),
				filePath: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			const task = await findTaskById(input.taskId);
			if (task.scanJobId !== input.scanJobId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Task not found for this scan job",
				});
			}
			const scanJob = await findScanJobById(task.scanJobId);
			let organizationId: string | undefined = scanJob.datasetEvaluationTrialId
				? await authorizeScanJobAccess(
						scanJob.scanJobId,
						ctx.session.activeOrganizationId,
					)
				: undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access files for this scan task",
				});
			}

			return await readScanTaskFileContent(input);
		}),

	candidate: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				scanJobId: z.string().min(1).optional(),
				producerTaskId: z.string().min(1).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const candidate = input.scanJobId
				? null
				: await findVulnerabilityCandidateById(input.vulnerabilityCandidateId);
			const candidateScanJobId = input.scanJobId || candidate?.scanJobId || "";
			await authorizeScanJobAccess(
				candidateScanJobId,
				ctx.session.activeOrganizationId,
			);

			const enrichedCandidate =
				await findVulnerabilityCandidateWithLatestAnalysisResultById({
					vulnerabilityCandidateId: input.vulnerabilityCandidateId,
					scanJobId: candidateScanJobId,
					producerTaskId: input.producerTaskId,
				});
			if (!enrichedCandidate) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Candidate not found",
				});
			}

			return enrichedCandidate;
		}),

	candidateTags: protectedProcedure.query(async () => {
		return await listCandidateTags();
	}),

	updateCandidateMetadata: protectedProcedure
		.input(apiUpdateCandidateMetadata)
		.mutation(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);

			await findVulnerabilityCandidateWithLatestAnalysisResultById({
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
				scanJobId: input.scanJobId,
				producerTaskId: input.producerTaskId,
			});

			return await updateVulnerabilityCandidateMetadata(input);
		}),

	candidateTaskLineage: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				scanJobId: z.string().min(1).optional(),
				producerTaskId: z.string().min(1).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const candidate = input.scanJobId
				? null
				: await findVulnerabilityCandidateById(input.vulnerabilityCandidateId);
			const candidateScanJobId = input.scanJobId || candidate?.scanJobId || "";
			await authorizeScanJobAccess(
				candidateScanJobId,
				ctx.session.activeOrganizationId,
			);

			return await findCandidateTaskLineage({
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
				scanJobId: candidateScanJobId,
				producerTaskId: input.producerTaskId,
			});
		}),

	analyzeCandidate: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				scanJobId: z.string().min(1),
				producerTaskId: z.string().min(1).optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);

			const result = await startCandidateAnalysis(input);
			const queueData: ScanQueueJob = { scanJobId: result.scanJobId };

			await scansQueue.add("scans", queueData, {
				jobId: `scan:reanalyze:${result.scanJobId}:${result.taskId}`,
				removeOnComplete: true,
				removeOnFail: true,
			});

			return result;
		}),

	startCandidateReviewContainer: protectedProcedure
		.input(apiStartCandidateReviewContainer)
		.mutation(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);

			return await startCandidateReviewContainer(input);
		}),

	verifyCandidate: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const candidate = await findVulnerabilityCandidateById(
				input.vulnerabilityCandidateId,
			);
			await authorizeScanJobAccess(
				candidate.scanJobId,
				ctx.session.activeOrganizationId,
			);

			return await startCandidateVerification(input.vulnerabilityCandidateId);
		}),

	listCandidateDirectory: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				scanJobId: z.string().min(1),
				directoryPath: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			const candidate = await findVulnerabilityCandidateById(
				input.vulnerabilityCandidateId,
			);
			if (candidate.scanJobId !== input.scanJobId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Candidate not found for this scan job",
				});
			}
			return await listCandidateDirectory({
				scanJobId: input.scanJobId,
				candidateId: input.vulnerabilityCandidateId,
				directoryPath: input.directoryPath,
			});
		}),

	readCandidateFile: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				scanJobId: z.string().min(1).optional(),
				filePath: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			const candidate = await findVulnerabilityCandidateById(
				input.vulnerabilityCandidateId,
			);
			const candidateScanJobId = input.scanJobId || candidate?.scanJobId || "";
			await authorizeScanJobAccess(
				candidateScanJobId,
				ctx.session.activeOrganizationId,
			);
			if (!candidate || candidate.scanJobId !== candidateScanJobId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Candidate not found for this scan job",
				});
			}

			return await readCandidateFileContent({
				scanJobId: candidateScanJobId,
				candidateId: input.vulnerabilityCandidateId,
				filePath: input.filePath,
			});
		}),

	jobOverview: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobRuntimeAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await jobRuntimeStatusStore.readOverview(input.scanJobId);
		}),

	jobRunningTasks: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobRuntimeAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await jobRuntimeStatusStore.readRunningTasks(input.scanJobId);
		}),

	jobQueueCounts: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobRuntimeAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await jobRuntimeStatusStore.readQueueCounts(input.scanJobId);
		}),

	jobPipeline: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobRuntimeAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await jobRuntimeStatusStore.readPipeline(input.scanJobId);
		}),

	terminalTasks: protectedProcedure
		.input(apiFindScanJobTerminalTasksPage)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await findScanJobTerminalTasksPage(input);
		}),

	fullScanStageGraph: protectedProcedure
		.input(apiFindFullScanStageGraph)
		.query(async ({ input, ctx }) => {
			let organizationId: string | undefined;
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access stage graph for this scan target",
				});
			}

			return await findFullScanStageGraph(input);
		}),

	stageGraph: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await findScanJobStageGraph(input.scanJobId);
		}),
});
