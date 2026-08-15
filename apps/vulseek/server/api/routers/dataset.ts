import { TRPCError } from "@trpc/server";
import {
	cancelScanJob,
	findDatasetProfileCheckoutStatus,
	pauseScanJob,
	pruneDatasetProfile,
	resumeScanJob,
	startDatasetProfileCheckout,
} from "@vulseek/server";
import {
	apiCreateDataset,
	apiCreateDatasetEvaluation,
	apiCreateDatasetProfile,
	apiDatasetProfileCheckoutId,
	apiDatasetEvaluationId,
	apiDatasetId,
	apiDatasetProfileId,
	apiListDatasetEvaluations,
	apiListDatasetProfiles,
	apiListDatasetSamples,
	apiListDatasets,
	apiListDatasetTrials,
	apiUpdateDataset,
	apiUpdateDatasetProfileHostRoot,
	apiUpdateDatasetProfileSamples,
	datasetEvaluations,
	datasetEvaluationTrials,
	datasetProfiles,
	datasetSamples,
	datasets,
	scanPipelineProfiles,
	scanPipelines,
	scanPipelineVersions,
} from "@vulseek/server/db/schema";
import { resolveCompiledDefinition } from "@vulseek/server/services/scan/api/pipeline-runs";
import { inspectRequiredToolsImageReference } from "@vulseek/server/services/scan/checkout-tools";
import {
	and,
	asc,
	desc,
	eq,
	ilike,
	inArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { db } from "@/server/db";
import { datasetEvaluationQueue } from "@/server/queues/queueSetup";

const isDatasetManager = (role: string) => role === "owner" || role === "admin";

const requireDatasetManager = (role: string) => {
	if (!isDatasetManager(role)) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Only organization owners and admins can manage datasets",
		});
	}
};

const findDataset = async (datasetId: string, organizationId: string) => {
	const dataset = await db
		.select()
		.from(datasets)
		.where(
			and(
				eq(datasets.datasetId, datasetId),
				eq(datasets.organizationId, organizationId),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!dataset)
		throw new TRPCError({ code: "NOT_FOUND", message: "Dataset not found" });
	return dataset;
};

const profileSummary = (
	profile: typeof datasetProfiles.$inferSelect,
	sampleCount = 0,
) => ({
	profileId: profile.profileId,
	datasetId: profile.datasetId,
	profileKey: profile.profileKey,
	status: profile.status,
	sourceDigest: profile.sourceDigest,
	toolsImageTag: profile.toolsImageTag,
	toolsImageDigest: profile.toolsImageDigest,
	errorMessage: profile.errorMessage,
	createdAt: profile.createdAt,
	updatedAt: profile.updatedAt,
	hostRootSummary: profile.hostRoot
		.split(/[\\/]/)
		.filter(Boolean)
		.slice(-2)
		.join("/"),
	sampleCount,
	selectedSampleCount: profile.selectedSampleIds.length,
});

export const datasetRouter = createTRPCRouter({
	list: protectedProcedure
		.input(apiListDatasets)
		.query(async ({ ctx, input }) => {
			const conditions: Array<SQL<unknown> | undefined> = [
				eq(datasets.organizationId, ctx.session.activeOrganizationId),
			];
			if (input.search) {
				const pattern = `%${input.search}%`;
				conditions.push(
					or(
						ilike(datasets.name, pattern),
						ilike(datasets.description, pattern),
					),
				);
			}
			const where = and(...conditions);
			const orderBy =
				input.sortKey === "name"
					? input.sortDirection === "asc"
						? asc(datasets.name)
						: desc(datasets.name)
					: input.sortKey === "createdAt"
						? input.sortDirection === "asc"
							? asc(datasets.createdAt)
							: desc(datasets.createdAt)
						: input.sortDirection === "asc"
							? asc(datasets.updatedAt)
							: desc(datasets.updatedAt);
			const [rows, count] = await Promise.all([
				db
					.select()
					.from(datasets)
					.where(where)
					.orderBy(orderBy)
					.limit(input.pageSize)
					.offset((input.page - 1) * input.pageSize),
				db
					.select({ count: sql<number>`count(*)` })
					.from(datasets)
					.where(where)
					.then((countRows) => Number(countRows[0]?.count ?? 0)),
			]);
			if (rows.length === 0) {
				return {
					items: [],
					total: count,
					page: input.page,
					pageSize: input.pageSize,
				};
			}
			const datasetIds = rows.map((row) => row.datasetId);
			const [evaluationCounts, sampleCounts] = await Promise.all([
				db
					.select({
						datasetId: datasetEvaluations.datasetId,
						count: sql<number>`count(*)`,
					})
					.from(datasetEvaluations)
					.where(inArray(datasetEvaluations.datasetId, datasetIds))
					.groupBy(datasetEvaluations.datasetId),
				db
					.select({
						datasetId: datasetProfiles.datasetId,
						count: sql<number>`count(*)`,
					})
					.from(datasetSamples)
					.innerJoin(
						datasetProfiles,
						eq(datasetSamples.profileId, datasetProfiles.profileId),
					)
					.where(inArray(datasetProfiles.datasetId, datasetIds))
					.groupBy(datasetProfiles.datasetId),
			]);
			const evaluationCountByDataset = new Map(
				evaluationCounts.map((row) => [row.datasetId, Number(row.count)]),
			);
			const sampleCountByDataset = new Map(
				sampleCounts.map((row) => [row.datasetId, Number(row.count)]),
			);
			return {
				items: rows.map((dataset) => ({
					...dataset,
					evaluationCount: evaluationCountByDataset.get(dataset.datasetId) ?? 0,
					sampleCount: sampleCountByDataset.get(dataset.datasetId) ?? 0,
				})),
				total: count,
				page: input.page,
				pageSize: input.pageSize,
			};
		}),

	one: protectedProcedure.input(apiDatasetId).query(async ({ ctx, input }) => {
		const dataset = await findDataset(
			input.datasetId,
			ctx.session.activeOrganizationId,
		);
		return { ...dataset, canManage: isDatasetManager(ctx.user.role) };
	}),

	create: protectedProcedure
		.input(apiCreateDataset)
		.mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			if (input.source.type === "local" && !input.source.path.startsWith("/")) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Local dataset paths must be absolute",
				});
			}
			return db
				.insert(datasets)
				.values({
					organizationId: ctx.session.activeOrganizationId,
					name: input.name,
					description: input.description,
					source: input.source,
				})
				.returning()
				.then((rows) => rows[0]);
		}),

	update: protectedProcedure
		.input(apiUpdateDataset)
		.mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			await findDataset(input.datasetId, ctx.session.activeOrganizationId);
			const { datasetId, ...values } = input;
			if (
				values.source?.type === "local" &&
				!values.source.path.startsWith("/")
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Local dataset paths must be absolute",
				});
			}
			return db
				.update(datasets)
				.set({ ...values, updatedAt: new Date().toISOString() })
				.where(eq(datasets.datasetId, datasetId))
				.returning()
				.then((rows) => rows[0]);
		}),

	remove: protectedProcedure
		.input(apiDatasetId)
		.mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			await findDataset(input.datasetId, ctx.session.activeOrganizationId);
			const referenced = await db
				.select({ id: datasetEvaluations.evaluationId })
				.from(datasetEvaluations)
				.where(eq(datasetEvaluations.datasetId, input.datasetId))
				.limit(1);
			if (referenced[0])
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Delete evaluations before deleting the dataset",
				});
			const profiles = await db
				.select({ profileId: datasetProfiles.profileId })
				.from(datasetProfiles)
				.where(eq(datasetProfiles.datasetId, input.datasetId));
			for (const profile of profiles)
				await pruneDatasetProfile(profile.profileId);
			return db
				.delete(datasets)
				.where(eq(datasets.datasetId, input.datasetId))
				.returning()
				.then((rows) => rows[0]);
		}),

	profiles: createTRPCRouter({
		list: protectedProcedure
			.input(apiListDatasetProfiles)
			.query(async ({ ctx, input }) => {
				await findDataset(input.datasetId, ctx.session.activeOrganizationId);
				const conditions = [eq(datasetProfiles.datasetId, input.datasetId)];
				if (input.status)
					conditions.push(eq(datasetProfiles.status, input.status));
				if (input.search) {
					conditions.push(
						ilike(datasetProfiles.profileKey, `%${input.search}%`),
					);
				}
				const where = and(...conditions);
				const [rows, count] = await Promise.all([
					db
						.select()
						.from(datasetProfiles)
						.where(where)
						.orderBy(desc(datasetProfiles.createdAt))
						.limit(input.pageSize)
						.offset((input.page - 1) * input.pageSize),
					db
						.select({ count: sql<number>`count(*)` })
						.from(datasetProfiles)
						.where(where)
						.then((countRows) => Number(countRows[0]?.count ?? 0)),
				]);
				const sampleCounts = rows.length
					? await db
							.select({
								profileId: datasetSamples.profileId,
								count: sql<number>`count(*)`,
							})
							.from(datasetSamples)
							.where(
								inArray(
									datasetSamples.profileId,
									rows.map((profile) => profile.profileId),
								),
							)
							.groupBy(datasetSamples.profileId)
					: [];
				const sampleCountByProfile = new Map(
					sampleCounts.map((row) => [row.profileId, Number(row.count)]),
				);
				return {
					items: rows.map((profile) =>
						profileSummary(
							profile,
							sampleCountByProfile.get(profile.profileId) ?? 0,
						),
					),
					total: count,
					page: input.page,
					pageSize: input.pageSize,
				};
			}),
		one: protectedProcedure
			.input(apiDatasetProfileId)
			.query(async ({ ctx, input }) => {
				const row = await db
					.select({ profile: datasetProfiles, dataset: datasets })
					.from(datasetProfiles)
					.innerJoin(
						datasets,
						eq(datasetProfiles.datasetId, datasets.datasetId),
					)
					.where(
						and(
							eq(datasetProfiles.profileId, input.profileId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!row)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Dataset profile not found",
					});
				const sampleCount = await db
					.select({ count: sql<number>`count(*)` })
					.from(datasetSamples)
					.where(eq(datasetSamples.profileId, input.profileId))
					.then((rows) => Number(rows[0]?.count ?? 0));
				const toolsImageAvailable =
					Boolean(row.profile.toolsImageTag && row.profile.toolsImageDigest) &&
					(await inspectRequiredToolsImageReference({
						imageTag: row.profile.toolsImageTag || "",
						imageId: row.profile.toolsImageDigest || "",
					}));
				return {
					...profileSummary(row.profile, sampleCount),
					hostRoot: row.profile.hostRoot,
					datasetName: row.dataset.name,
					selectedSampleIds: row.profile.selectedSampleIds,
					toolsImageAvailable,
					canManage: isDatasetManager(ctx.user.role),
				};
			}),
		create: protectedProcedure
			.input(apiCreateDatasetProfile)
			.mutation(async ({ ctx, input }) => {
				requireDatasetManager(ctx.user.role);
				await findDataset(input.datasetId, ctx.session.activeOrganizationId);
				const profileId = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				return db
					.insert(datasetProfiles)
					.values({
						profileId,
						datasetId: input.datasetId,
						profileKey: input.profileKey,
						hostRoot: "",
						status: "preparing",
					})
					.returning()
					.then((rows) => rows[0]);
			}),
		updateHostRoot: protectedProcedure
			.input(apiUpdateDatasetProfileHostRoot)
			.mutation(async ({ ctx, input }) => {
				requireDatasetManager(ctx.user.role);
				const row = await db
					.select({ profile: datasetProfiles, dataset: datasets })
					.from(datasetProfiles)
					.innerJoin(
						datasets,
						eq(datasetProfiles.datasetId, datasets.datasetId),
					)
					.where(
						and(
							eq(datasetProfiles.profileId, input.profileId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!row)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Dataset profile not found",
					});
				await db.transaction(async (tx) => {
					await tx
						.update(datasetProfiles)
						.set({
							hostRoot: input.hostRoot.trim(),
							status: "preparing",
							selectedSampleIds: [],
							errorMessage: null,
							configSnapshot: {},
							updatedAt: new Date().toISOString(),
						})
						.where(eq(datasetProfiles.profileId, input.profileId));
				});
				return {
					profileId: input.profileId,
					hostRoot: input.hostRoot.trim(),
					status: "preparing" as const,
				};
			}),
		updateSelectedSamples: protectedProcedure
			.input(apiUpdateDatasetProfileSamples)
			.mutation(async ({ ctx, input }) => {
				requireDatasetManager(ctx.user.role);
				const row = await db
					.select({ profile: datasetProfiles, dataset: datasets })
					.from(datasetProfiles)
					.innerJoin(
						datasets,
						eq(datasetProfiles.datasetId, datasets.datasetId),
					)
					.where(
						and(
							eq(datasetProfiles.profileId, input.profileId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!row)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Dataset profile not found",
					});
				if (row.profile.status !== "ready")
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "A ready Dataset Profile is required",
					});
				const samples = await db
					.select({ id: datasetSamples.id })
					.from(datasetSamples)
					.where(
						and(
							eq(datasetSamples.profileId, input.profileId),
							inArray(datasetSamples.id, input.sampleIds),
						),
					)
					.orderBy(asc(datasetSamples.ordinal));
				if (samples.length !== new Set(input.sampleIds).size)
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "One or more samples are not in the selected profile",
					});
				const selectedSampleIds = samples.map((sample) => sample.id);
				await db
					.update(datasetProfiles)
					.set({ selectedSampleIds, updatedAt: new Date().toISOString() })
					.where(eq(datasetProfiles.profileId, input.profileId));
				return { profileId: input.profileId, selectedSampleIds };
			}),
		checkout: protectedProcedure
			.input(apiDatasetProfileId)
			.mutation(async ({ ctx, input }) => {
				requireDatasetManager(ctx.user.role);
				const profile = await db
					.select({ profile: datasetProfiles, dataset: datasets })
					.from(datasetProfiles)
					.innerJoin(
						datasets,
						eq(datasetProfiles.datasetId, datasets.datasetId),
					)
					.where(
						and(
							eq(datasetProfiles.profileId, input.profileId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!profile)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Dataset profile not found",
					});
				const activeEvaluation = await db
					.select({ evaluationId: datasetEvaluations.evaluationId })
					.from(datasetEvaluations)
					.where(
						and(
							eq(datasetEvaluations.profileId, input.profileId),
							inArray(datasetEvaluations.status, [
								"pending",
								"running",
								"paused",
							]),
						),
					)
					.limit(1);
				if (activeEvaluation[0])
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Dataset profile is locked by an active evaluation",
					});
				return startDatasetProfileCheckout(input.profileId);
			}),
		checkoutStatus: protectedProcedure
			.input(apiDatasetProfileCheckoutId)
			.query(async ({ ctx, input }) => {
				const status = findDatasetProfileCheckoutStatus(input.checkoutId);
				if (!status) return null;
				const profile = await db
					.select({ profileId: datasetProfiles.profileId })
					.from(datasetProfiles)
					.innerJoin(
						datasets,
						eq(datasetProfiles.datasetId, datasets.datasetId),
					)
					.where(
						and(
							eq(datasetProfiles.profileId, status.profileId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1);
				if (!profile[0]) return null;
				return status;
			}),
		remove: protectedProcedure
			.input(apiDatasetProfileId)
			.mutation(async ({ ctx, input }) => {
				requireDatasetManager(ctx.user.role);
				const profile = await db
					.select({ profile: datasetProfiles, dataset: datasets })
					.from(datasetProfiles)
					.innerJoin(
						datasets,
						eq(datasetProfiles.datasetId, datasets.datasetId),
					)
					.where(
						and(
							eq(datasetProfiles.profileId, input.profileId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!profile)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Dataset profile not found",
					});
				try {
					return await pruneDatasetProfile(input.profileId);
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}),
	}),

	samples: createTRPCRouter({
		list: protectedProcedure
			.input(apiListDatasetSamples)
			.query(async ({ ctx, input }) => {
				const profile = await db
					.select({ profile: datasetProfiles, datasetId: datasets.datasetId })
					.from(datasetProfiles)
					.innerJoin(
						datasets,
						eq(datasetProfiles.datasetId, datasets.datasetId),
					)
					.where(
						and(
							eq(datasetProfiles.profileId, input.profileId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!profile)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Dataset profile not found",
					});
				const condition = input.search?.trim()
					? ilike(datasetSamples.id, `%${input.search.trim()}%`)
					: undefined;
				const where = condition
					? and(eq(datasetSamples.profileId, input.profileId), condition)
					: eq(datasetSamples.profileId, input.profileId);
				const [items, count] = await Promise.all([
					db
						.select()
						.from(datasetSamples)
						.where(where)
						.orderBy(asc(datasetSamples.ordinal))
						.limit(input.pageSize)
						.offset((input.page - 1) * input.pageSize),
					db
						.select({ count: sql<number>`count(*)` })
						.from(datasetSamples)
						.where(where)
						.then((rows) => Number(rows[0]?.count ?? 0)),
				]);
				return {
					items,
					total: count,
					page: input.page,
					pageSize: input.pageSize,
				};
			}),
	}),

	evaluations: createTRPCRouter({
		navigationByScanJob: protectedProcedure
			.input(z.object({ scanJobId: z.string().min(1) }))
			.query(async ({ ctx, input }) => {
				const context = await db
					.select({
						datasetId: datasets.datasetId,
						datasetName: datasets.name,
						profileId: datasetProfiles.profileId,
						profileName: datasetProfiles.profileKey,
						evaluationId: datasetEvaluations.evaluationId,
						evaluationName: datasetEvaluations.name,
						trialId: datasetEvaluationTrials.trialId,
					})
					.from(datasetEvaluationTrials)
					.innerJoin(
						datasetEvaluations,
						eq(
							datasetEvaluationTrials.evaluationId,
							datasetEvaluations.evaluationId,
						),
					)
					.innerJoin(
						datasetProfiles,
						eq(datasetEvaluations.profileId, datasetProfiles.profileId),
					)
					.innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId))
					.where(
						and(
							eq(datasetEvaluationTrials.scanJobId, input.scanJobId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);

				if (!context) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Dataset trial navigation context not found",
					});
				}

				return context;
			}),
		list: protectedProcedure
			.input(apiListDatasetEvaluations)
			.query(async ({ ctx, input }) => {
				const conditions = [
					eq(datasets.organizationId, ctx.session.activeOrganizationId),
				];
				if (input.datasetId) {
					conditions.push(eq(datasetEvaluations.datasetId, input.datasetId));
				}
				if (input.profileId) {
					conditions.push(eq(datasetEvaluations.profileId, input.profileId));
				}
				if (input.status) {
					conditions.push(eq(datasetEvaluations.status, input.status));
				}
				if (input.search) {
					conditions.push(ilike(datasetEvaluations.name, `%${input.search}%`));
				}
				const where = and(...conditions);
				const [rows, count] = await Promise.all([
					db
						.select({
							evaluation: datasetEvaluations,
							profileKey: datasetProfiles.profileKey,
						})
						.from(datasetEvaluations)
						.innerJoin(
							datasets,
							eq(datasetEvaluations.datasetId, datasets.datasetId),
						)
						.innerJoin(
							datasetProfiles,
							eq(datasetEvaluations.profileId, datasetProfiles.profileId),
						)
						.where(where)
						.orderBy(desc(datasetEvaluations.createdAt))
						.limit(input.pageSize)
						.offset((input.page - 1) * input.pageSize)
						.then((joined) =>
							joined.map((row) => ({
								...row.evaluation,
								profileKey: row.profileKey,
							})),
						),
					db
						.select({ count: sql<number>`count(*)` })
						.from(datasetEvaluations)
						.innerJoin(
							datasets,
							eq(datasetEvaluations.datasetId, datasets.datasetId),
						)
						.where(where)
						.then((countRows) => Number(countRows[0]?.count ?? 0)),
				]);
				return {
					items: rows,
					total: count,
					page: input.page,
					pageSize: input.pageSize,
				};
			}),
		one: protectedProcedure
			.input(apiDatasetEvaluationId)
			.query(async ({ ctx, input }) => {
				const evaluation = await db
					.select({
						evaluation: datasetEvaluations,
						dataset: datasets,
						profile: datasetProfiles,
					})
					.from(datasetEvaluations)
					.innerJoin(
						datasets,
						eq(datasetEvaluations.datasetId, datasets.datasetId),
					)
					.innerJoin(
						datasetProfiles,
						eq(datasetEvaluations.profileId, datasetProfiles.profileId),
					)
					.where(
						and(
							eq(datasetEvaluations.evaluationId, input.evaluationId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!evaluation)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Evaluation not found",
					});
				const trialTotals = await db
					.select({
						durationMs: sql<number>`coalesce(sum(${datasetEvaluationTrials.durationMs}), 0)`,
						totalTokens: sql<number>`coalesce(sum(${datasetEvaluationTrials.totalTokens}), 0)`,
						estimatedCost: sql<number>`coalesce(sum(${datasetEvaluationTrials.estimatedCost}), 0)`,
						count: sql<number>`count(*)`,
					})
					.from(datasetEvaluationTrials)
					.where(eq(datasetEvaluationTrials.evaluationId, input.evaluationId))
					.then((rows) => rows[0]);
				return {
					...evaluation.evaluation,
					datasetName: evaluation.dataset.name,
					profileKey: evaluation.profile.profileKey,
					trialCount: Number(trialTotals?.count ?? 0),
					totals: {
						durationMs: Number(trialTotals?.durationMs ?? 0),
						totalTokens: Number(trialTotals?.totalTokens ?? 0),
						estimatedCost: Number(trialTotals?.estimatedCost ?? 0),
					},
				};
			}),
		trialsList: protectedProcedure
			.input(apiListDatasetTrials)
			.query(async ({ ctx, input }) => {
				const evaluation = await db
					.select({ evaluationId: datasetEvaluations.evaluationId })
					.from(datasetEvaluations)
					.innerJoin(
						datasets,
						eq(datasetEvaluations.datasetId, datasets.datasetId),
					)
					.where(
						and(
							eq(datasetEvaluations.evaluationId, input.evaluationId),
							eq(datasets.organizationId, ctx.session.activeOrganizationId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!evaluation)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Evaluation not found",
					});
				const conditions: Array<SQL<unknown> | undefined> = [
					eq(datasetEvaluationTrials.evaluationId, input.evaluationId),
				];
				if (input.status) {
					conditions.push(eq(datasetEvaluationTrials.status, input.status));
				}
				if (input.search) {
					const pattern = `%${input.search}%`;
					conditions.push(
						or(
							ilike(datasetSamples.id, pattern),
							ilike(datasetSamples.title, pattern),
						),
					);
				}
				const where = and(...conditions);
				const [rows, count] = await Promise.all([
					db
						.select()
						.from(datasetEvaluationTrials)
						.leftJoin(
							datasetSamples,
							eq(datasetEvaluationTrials.sampleId, datasetSamples.sampleId),
						)
						.where(where)
						.orderBy(asc(datasetEvaluationTrials.ordinal))
						.limit(input.pageSize)
						.offset((input.page - 1) * input.pageSize)
						.then((joined) =>
							joined.map((row) => ({
								...row.dataset_evaluation_trials,
								sample: row.dataset_samples
									? {
											sampleId: row.dataset_samples.sampleId,
											id: row.dataset_samples.id,
											title: row.dataset_samples.title,
											groundTruthArtifacts:
												row.dataset_samples.groundTruthArtifacts,
										}
									: null,
							})),
						),
					db
						.select({ count: sql<number>`count(*)` })
						.from(datasetEvaluationTrials)
						.leftJoin(
							datasetSamples,
							eq(datasetEvaluationTrials.sampleId, datasetSamples.sampleId),
						)
						.where(where)
						.then((countRows) => Number(countRows[0]?.count ?? 0)),
				]);
				return {
					items: rows,
					total: count,
					page: input.page,
					pageSize: input.pageSize,
				};
			}),
		create: protectedProcedure
			.input(apiCreateDatasetEvaluation)
			.mutation(async ({ ctx, input }) => {
				requireDatasetManager(ctx.user.role);
				const dataset = await findDataset(
					input.datasetId,
					ctx.session.activeOrganizationId,
				);
				const profile = await db
					.select()
					.from(datasetProfiles)
					.where(
						and(
							eq(datasetProfiles.profileId, input.profileId),
							eq(datasetProfiles.datasetId, input.datasetId),
						),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (
					profile?.status !== "ready" ||
					!profile.toolsImageTag ||
					!profile.toolsImageDigest
				)
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"A checked-out Dataset Profile with a pinned tools image is required",
					});
				const samples = await db
					.select()
					.from(datasetSamples)
					.where(
						and(
							eq(datasetSamples.profileId, input.profileId),
							inArray(datasetSamples.id, input.sampleIds),
						),
					)
					.orderBy(asc(datasetSamples.ordinal));
				if (samples.length !== new Set(input.sampleIds).size)
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "One or more samples are not in the selected profile",
					});
				const pipeline = await db
						.select()
						.from(scanPipelines)
						.where(
							and(
								eq(scanPipelines.pipelineId, input.pipelineId),
								eq(
									scanPipelines.organizationId,
									ctx.session.activeOrganizationId,
								),
							),
						)
						.limit(1)
						.then((rows) => rows[0]);
					if (!pipeline || pipeline.archivedAt)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Published pipeline is not available",
						});
					const selectedProfile = input.pipelineProfileId
						? await db
								.select()
								.from(scanPipelineProfiles)
								.where(
									and(
										eq(
											scanPipelineProfiles.pipelineProfileId,
											input.pipelineProfileId,
										),
										eq(
											scanPipelineProfiles.pipelineId,
											pipeline.pipelineId,
										),
										eq(
											scanPipelineProfiles.organizationId,
											ctx.session.activeOrganizationId,
										),
									),
								)
								.limit(1)
								.then((rows) => rows[0])
						: null;
					if (input.pipelineProfileId && !selectedProfile)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Pipeline profile is not available for this pipeline",
						});
					const pipelineVersionId =
						selectedProfile?.pipelineVersionId ??
						pipeline.currentPublishedVersionId;
					if (!pipelineVersionId)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Pipeline has no published version",
						});
					const version = await db
						.select()
						.from(scanPipelineVersions)
						.where(
							and(
								eq(
									scanPipelineVersions.pipelineVersionId,
									pipelineVersionId,
								),
								eq(scanPipelineVersions.pipelineId, pipeline.pipelineId),
							),
						)
						.limit(1)
						.then((rows) => rows[0]);
					if (!version)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Pipeline version is not available",
						});
					const compiled = resolveCompiledDefinition(
						version.compiledDefinition,
						version.yaml,
					);
					if (!compiled.supportedTargets.includes("evaluation"))
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Pipeline does not support Dataset Evaluations",
						});
				const pipelineSnapshot = {
						pipelineId: pipeline.pipelineId,
						pipelineProfileId: selectedProfile?.pipelineProfileId ?? null,
						pipelineVersionId: version.pipelineVersionId,
						pipelineYamlSnapshot: version.yaml,
						pipelineCompiledSnapshot: compiled,
						scanRuntimeSettings: selectedProfile?.settings ?? {},
						scanPipelineDefinitionSnapshot: {},
					};
				const evaluationId = `evaluation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				const result = await db.transaction(async (tx) => {
					const evaluation = await tx
						.insert(datasetEvaluations)
						.values({
							evaluationId,
							datasetId: dataset.datasetId,
							profileId: profile.profileId,
							name: input.name,
							pipelineId: pipelineSnapshot.pipelineId,
							pipelineProfileId: pipelineSnapshot.pipelineProfileId,
							pipelineVersionId: pipelineSnapshot.pipelineVersionId,
							pipelineYamlSnapshot: pipelineSnapshot.pipelineYamlSnapshot,
							pipelineCompiledSnapshot:
								pipelineSnapshot.pipelineCompiledSnapshot,
							sampleIds: input.sampleIds,
							repetitions: input.repetitions,
							timeBudgetSeconds: input.timeBudgetSeconds ?? null,
							scanRuntimeSettings: pipelineSnapshot.scanRuntimeSettings,
							scanPipelineDefinitionSnapshot:
								pipelineSnapshot.scanPipelineDefinitionSnapshot,
						})
						.returning()
						.then((rows) => rows[0]);
					const ordered = [];
					for (
						let repetition = 1;
						repetition <= input.repetitions;
						repetition += 1
					) {
						for (const sample of samples)
							ordered.push({
								evaluationId,
								sampleId: sample.sampleId,
								repetition,
								ordinal: ordered.length,
							});
					}
					await tx.insert(datasetEvaluationTrials).values(ordered);
					return evaluation;
				});
				await datasetEvaluationQueue.add(
					"dataset-evaluation",
					{ evaluationId },
					{ jobId: evaluationId, removeOnComplete: 100, removeOnFail: 100 },
				);
				return result;
			}),
	}),

	start: protectedProcedure
		.input(apiDatasetEvaluationId)
		.mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			const evaluation = await db
				.select({ evaluation: datasetEvaluations, dataset: datasets })
				.from(datasetEvaluations)
				.innerJoin(
					datasets,
					eq(datasetEvaluations.datasetId, datasets.datasetId),
				)
				.where(
					and(
						eq(datasetEvaluations.evaluationId, input.evaluationId),
						eq(datasets.organizationId, ctx.session.activeOrganizationId),
					),
				)
				.limit(1)
				.then((rows) => rows[0]);
			if (!evaluation)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Evaluation not found",
				});
			if (evaluation.evaluation.status === "running") {
				return {
					evaluationId: input.evaluationId,
					status: evaluation.evaluation.status,
				};
			}
			const activeTrial = await db
				.select({ scanJobId: datasetEvaluationTrials.scanJobId })
				.from(datasetEvaluationTrials)
				.where(
					and(
						eq(datasetEvaluationTrials.evaluationId, input.evaluationId),
						inArray(datasetEvaluationTrials.status, ["preparing", "running"]),
					),
				)
				.orderBy(asc(datasetEvaluationTrials.ordinal))
				.limit(1)
				.then((rows) => rows[0]);
			if (evaluation.evaluation.status === "paused" && activeTrial?.scanJobId)
				await resumeScanJob(activeTrial.scanJobId).catch(() => {});
			await db
				.update(datasetEvaluations)
				.set({
					status: "pending",
					errorMessage: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(datasetEvaluations.evaluationId, input.evaluationId));
			await datasetEvaluationQueue.add(
				"dataset-evaluation",
				{ evaluationId: input.evaluationId },
				{
					jobId: `resume-${input.evaluationId}-${Date.now()}`,
					removeOnComplete: 100,
					removeOnFail: 100,
				},
			);
			return { evaluationId: input.evaluationId };
		}),

	pause: protectedProcedure
		.input(apiDatasetEvaluationId)
		.mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			const evaluation = await db
				.select({ evaluation: datasetEvaluations, dataset: datasets })
				.from(datasetEvaluations)
				.innerJoin(
					datasets,
					eq(datasetEvaluations.datasetId, datasets.datasetId),
				)
				.where(
					and(
						eq(datasetEvaluations.evaluationId, input.evaluationId),
						eq(datasets.organizationId, ctx.session.activeOrganizationId),
					),
				)
				.limit(1)
				.then((rows) => rows[0]);
			if (!evaluation)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Evaluation not found",
				});
			const activeTrial = await db
				.select({ scanJobId: datasetEvaluationTrials.scanJobId })
				.from(datasetEvaluationTrials)
				.where(
					and(
						eq(datasetEvaluationTrials.evaluationId, input.evaluationId),
						inArray(datasetEvaluationTrials.status, ["preparing", "running"]),
					),
				)
				.orderBy(asc(datasetEvaluationTrials.ordinal))
				.limit(1)
				.then((rows) => rows[0]);
			if (activeTrial?.scanJobId) {
				await pauseScanJob(activeTrial.scanJobId);
			}
			await db
				.update(datasetEvaluations)
				.set({ status: "paused", updatedAt: new Date().toISOString() })
				.where(eq(datasetEvaluations.evaluationId, input.evaluationId));
			return { evaluationId: input.evaluationId, status: "paused" as const };
		}),

	cancel: protectedProcedure
		.input(apiDatasetEvaluationId)
		.mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			const evaluation = await db
				.select({ evaluation: datasetEvaluations, dataset: datasets })
				.from(datasetEvaluations)
				.innerJoin(
					datasets,
					eq(datasetEvaluations.datasetId, datasets.datasetId),
				)
				.where(
					and(
						eq(datasetEvaluations.evaluationId, input.evaluationId),
						eq(datasets.organizationId, ctx.session.activeOrganizationId),
					),
				)
				.limit(1)
				.then((rows) => rows[0]);
			if (!evaluation)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Evaluation not found",
				});
			const activeTrial = await db
				.select({
					trialId: datasetEvaluationTrials.trialId,
					scanJobId: datasetEvaluationTrials.scanJobId,
				})
				.from(datasetEvaluationTrials)
				.where(
					and(
						eq(datasetEvaluationTrials.evaluationId, input.evaluationId),
						inArray(datasetEvaluationTrials.status, ["preparing", "running"]),
					),
				)
				.orderBy(asc(datasetEvaluationTrials.ordinal))
				.limit(1)
				.then((rows) => rows[0]);
			if (activeTrial?.scanJobId) {
				await cancelScanJob(activeTrial.scanJobId, {
					reason: "manual_cancel",
					message: "Evaluation canceled",
				});
			}
			await db
				.update(datasetEvaluationTrials)
				.set({
					status: "canceled",
					errorMessage: "Evaluation canceled",
					finishedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(datasetEvaluationTrials.evaluationId, input.evaluationId),
						inArray(datasetEvaluationTrials.status, [
							"pending",
							"preparing",
							"running",
						]),
					),
				);
			await db
				.update(datasetEvaluations)
				.set({
					status: "canceled",
					finishedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(datasetEvaluations.evaluationId, input.evaluationId));
			return { evaluationId: input.evaluationId, status: "canceled" as const };
		}),
});
