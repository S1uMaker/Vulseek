import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "@vulseek/server/db";
import { scanPipelines, scanPipelineVersions } from "@vulseek/server/db/schema";
import type { ScanRuntimeSettings } from "@vulseek/server/db/schema/shared";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import {
	compilePipelineDocumentV3,
	parsePipelineDocumentV3,
	type CompiledPipelineDefinition,
	type PipelineDocumentV3,
} from "../pipeline/document-v3";
import { createScanJobRepo } from "../persistence/scan-job.repo";
import { findPipelineProfileForOrganization } from "../../pipeline-profiles";

/**
 * V3 run creation. Resolves the exact published version (explicit id or the
 * pipeline's current), freezes YAML + compiled definition onto the scan job,
 * derives the loop-safety budget and returns the job for queueing.
 *
 * The queue payload only carries `scanJobId`; the worker reads the immutable
 * snapshot from the database — later version switches, archival or agent
 * profile edits never affect an already-created run.
 */

export type PipelineRunTarget =
	| { type: "application"; applicationId: string }
	| { type: "compose"; composeId: string }
	| { type: "datasetTrial"; trialId: string };

export type CreatePipelineRunInput = {
	organizationId: string;
	userId?: string | null;
	target: PipelineRunTarget;
	pipelineId: string;
	pipelineVersionId?: string;
	repository?: {
		targetRef?: string;
		targetTag?: string;
		commitSha?: string;
		baseSha?: string;
		commitWindow?: number;
	};
	title?: string;
	description?: string;
	pipelineProfileId?: string;
	scanRuntimeSettings?: ScanRuntimeSettings;
	stageOverrides?: Record<
		string,
		{
			enabled?: boolean;
			concurrency?: number;
			agentProfileId?: string | null;
		}
	>;
};

const runtimeSettingsToStageOverrides = (
	settings: ScanRuntimeSettings,
): NonNullable<CreatePipelineRunInput["stageOverrides"]> => {
	const stages = settings.stages ?? {};
	return Object.fromEntries(
		Object.entries(stages).map(([stageId, setting]) => [
			stageId,
			{
				...(setting.disabled === undefined
					? {}
					: { enabled: setting.disabled !== true }),
				...(setting.concurrency == null
					? {}
					: { concurrency: setting.concurrency }),
				...(setting.agentProfileId === undefined
					? {}
					: { agentProfileId: setting.agentProfileId }),
			},
		]),
	);
};

const isCompiledDefinition = (value: unknown): value is CompiledPipelineDefinition =>
	Boolean(
		value &&
			typeof value === "object" &&
			Array.isArray((value as { stages?: unknown }).stages) &&
			typeof (value as { root?: unknown }).root === "string",
	);

const isDocumentShape = (value: unknown): value is PipelineDocumentV3 =>
	Boolean(
		value &&
			typeof value === "object" &&
			(value as { version?: unknown }).version === 3 &&
			!Array.isArray((value as { stages?: unknown }).stages) &&
			Boolean((value as { stages?: unknown }).stages),
	);

/**
 * The stored `compiledDefinition` on a version is either a full compiled
 * definition (new publishes) or the canonical document (Phase 2 seed rows).
 * Normalize both into the compiled shape.
 */
export const resolveCompiledDefinition = (
	stored: unknown,
	yaml: string,
): CompiledPipelineDefinition => {
	if (isCompiledDefinition(stored)) {
		return stored;
	}
	// Phase 2 seed rows stored the canonical document shape — compile it
	// directly without needing the raw YAML again.
	if (isDocumentShape(stored)) {
		return compilePipelineDocumentV3(stored);
	}
	const parsed = parsePipelineDocumentV3(yaml).document;
	if (!parsed) {
		throw new Error("Stored pipeline YAML no longer parses as a V3 document");
	}
	return compilePipelineDocumentV3(parsed);
};

export const resolvePipelineVersionSnapshot = async (input: {
	organizationId: string;
	pipelineId: string;
	pipelineVersionId?: string;
}) => {
	const pipeline = await db
		.select()
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.pipelineId, input.pipelineId),
				eq(scanPipelines.organizationId, input.organizationId),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!pipeline) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found" });
	}
	if (pipeline.archivedAt) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Archived pipelines cannot start new runs",
		});
	}

	const versionId = input.pipelineVersionId ?? pipeline.currentPublishedVersionId;
	if (!versionId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Pipeline has no published version to run",
		});
	}
	const version = await db
		.select()
		.from(scanPipelineVersions)
		.where(
			and(
				eq(scanPipelineVersions.pipelineVersionId, versionId),
				eq(scanPipelineVersions.pipelineId, input.pipelineId),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!version) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Pipeline version does not belong to this pipeline",
		});
	}
	return { pipeline, version };
};

const assertTargetInOrganization = async (
	organizationId: string,
	target: PipelineRunTarget,
) => {
	if (target.type === "application") {
		const application = await findApplicationById(target.applicationId).catch(
			() => null,
		);
		if (
			!application ||
			application.environment.project.organizationId !== organizationId
		) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "Application does not belong to this organization",
			});
		}
	}
	if (target.type === "compose") {
		const composeRow = await findComposeById(target.composeId).catch(() => null);
		if (
			!composeRow ||
			composeRow.environment.project.organizationId !== organizationId
		) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "Compose does not belong to this organization",
			});
		}
	}
};

export const createPipelineRun = async (
	input: CreatePipelineRunInput,
): Promise<{ scanJobId: string; pipelineVersionId: string; versionNumber: number }> => {
	const { pipeline, version } = await resolvePipelineVersionSnapshot(input);
	await assertTargetInOrganization(input.organizationId, input.target);

	const compiled = resolveCompiledDefinition(
		version.compiledDefinition,
		version.yaml,
	);
	const document = parsePipelineDocumentV3(version.yaml).document;
	if (!document) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Published pipeline YAML is no longer a valid V3 document",
		});
	}
	if (compiled.stages.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Published pipeline has no stages",
		});
	}

	const now = new Date();
	const deadlineAt = new Date(
		now.getTime() + compiled.limits.maxDurationSeconds * 1000,
	).toISOString();

	let scanRuntimeSettings = input.scanRuntimeSettings ?? {};
	let stageOverrides = input.stageOverrides;
	if (input.pipelineProfileId) {
		const profile = await findPipelineProfileForOrganization(
			input.organizationId,
			input.pipelineProfileId,
		);
		if (profile.pipelineId !== pipeline.pipelineId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Pipeline profile does not belong to this pipeline",
			});
		}
		scanRuntimeSettings = profile.settings ?? {};
		stageOverrides = runtimeSettingsToStageOverrides(scanRuntimeSettings);
	}

	const scanJob = await createScanJobRepo({
		applicationId: input.target.type === "application" ? input.target.applicationId : null,
		composeId: input.target.type === "compose" ? input.target.composeId : null,
		datasetEvaluationTrialId:
			input.target.type === "datasetTrial" ? input.target.trialId : null,
		title:
			input.title ||
			`${document.name}: ${input.target.type === "application" ? "application" : input.target.type === "compose" ? "compose" : "evaluation trial"}`,
		description: input.description || null,
		triggerSource: "manual",
		commitSha: input.repository?.commitSha ?? null,
		baseSha: input.repository?.baseSha ?? null,
		targetRef: input.repository?.targetRef ?? null,
		targetTag: input.repository?.targetTag ?? null,
		commitWindow: input.repository?.commitWindow ?? 3,
		scanRuntimeSettings,
		pipelineId: pipeline.pipelineId,
		pipelineVersionId: version.pipelineVersionId,
		pipelineYamlSnapshot: version.yaml,
		pipelineCompiledSnapshot: {
			...compiled,
			stageOverrides,
		} as unknown as Record<string, unknown>,
		maxTasks: compiled.limits.maxTasks,
		deadlineAt,
		defaultDeltaCommitWindow: 3,
	});

	return {
		scanJobId: scanJob.scanJobId,
		pipelineVersionId: version.pipelineVersionId,
		versionNumber: version.versionNumber,
	};
};
