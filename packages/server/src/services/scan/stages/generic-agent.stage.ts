import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	bindStageLaneRuntimeRepo,
	findStageLaneRuntimeByActiveTaskIdRepo,
} from "../persistence/stage-lane-runtime.repo";
import {
	syncVulnerabilityCandidatesFromProducerTask,
	type CandidateSyncTransaction,
} from "../persistence/candidate.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { renderPipelineTemplate } from "../pipeline/scan-pipeline-edge-transform";
import { surfaceCoverageContainerPath } from "../pipeline/tob-goal-coverage";
import type { YamlPipelineStage } from "../pipeline/yaml-pipeline-runtime";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import {
	readTaskJsonArtifact,
	replaceTaskJsonArtifact,
	taskArtifactHostPath,
	writeTaskJsonArtifact,
} from "../artifacts/task-artifact-paths";
import { promises as fs } from "node:fs";
import {
	isJsonSchemaContract,
	validateJsonSchemaContractArtifacts,
	validateStructuredOutputSchemaSource,
} from "../pipeline/scan-pipeline-schema-contracts";
import { applySchemaTransforms } from "../pipeline/scan-pipeline-schema-transforms";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "../constants";
import { updateScanJobTargetContextRepo } from "../persistence/scan-job.repo";
import { findResearchTrackIdentityRepo } from "../persistence/research-track.repo";
import { prepareRepositoryForScanInContainer } from "../repository/prepare-repository";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
	resolveStageRuntimeCwd,
	resolveStageRuntimePrompt,
	resolveStageRuntimePromptTemplate,
} from "./agent-stage-runtime";
import {
	isSurfaceGoalReentry,
	resolveGoalStagePrompt,
} from "./goal-prompt";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";
import type { ScanJob } from "../types";
import {
	assertResearchTrackIdentity,
	enrichResearchTrackInput,
} from "./research-track-input";

type GenericStageContext = StageContext & { scanJob?: ScanJob };

const RESEARCH_STAGES = new Set([
	"research-scope", "surface-map", "track-plan", "vulnerability-discovery",
	"track-review", "finding-validation", "finding-review", "chain-synthesis",
	"chain-review", "exploit-validation", "exploit-review", "research-report",
]);
const isResearchStage = (stageName: string) =>
	stageName === "research" || RESEARCH_STAGES.has(stageName);
const getResearchMinimumDurationMs = () => {
	const configured = Number.parseInt(
		process.env.VULSEEK_RESEARCH_MIN_DURATION_MS || "10800000",
		10,
	);
	return Number.isFinite(configured) && configured > 0
		? configured
		: 3 * 60 * 60 * 1000;
};

export const resolveStageReuseContainer = (
	stageName: string,
	configured: boolean,
	goal = false,
	goalSession?: "shared" | "per-task",
) =>
	goalSession === "shared"
		? true
		: isResearchStage(stageName) || goal
			? false
			: configured;

export const resolveStageContainerNameParts = (
	stageName: string,
	taskId: string,
	configured: Array<string | null | undefined> | undefined,
	goal = false,
	goalSession?: "shared" | "per-task",
) =>
	goalSession === "shared"
		? configured
		: isResearchStage(stageName) || goal
		? [...(configured || []), taskId]
		: configured;

const buildResearchTaskContext = (
	ctx: GenericStageContext,
	stageInput: unknown,
) => ({
	taskId: ctx.taskId,
	scanJobId: ctx.scanJobId,
	stageName: ctx.stageName,
	stageInput,
});

const toPromptValues = (value: unknown): Record<string, string | number> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) => {
			if (typeof item === "string" || typeof item === "number") {
				return [[key, item]];
			}
			if (item === null || item === undefined) return [[key, "-"]];
			return [[key, JSON.stringify(item)]];
		}),
	);
};

const resolvePromptValues = async (
	ctx: GenericStageContext,
	input: unknown,
	config: YamlPipelineStage,
) => {
	const taskDir = await ctx.taskDir();
	const taskDirContainer = await ctx.taskDirContainer();
	const laneDirContainer =
		ctx.laneIndex !== null ? await ctx.laneDirContainer() : "";
	const agentProfile = await ctx.agentProfile();
	const templateContext = {
		...ctx,
		taskDir: taskDirContainer,
		taskDirHost: taskDir,
		laneDir: laneDirContainer,
	};
	const rendered = await renderPipelineTemplate(
		{
			taskId: ctx.taskId,
			taskName: ctx.taskName,
			taskDir: taskDirContainer,
			taskDirHost: taskDir,
			laneDir: laneDirContainer,
			laneCoveragePath: laneDirContainer
				? surfaceCoverageContainerPath(laneDirContainer)
				: "",
			scanJobId: ctx.scanJobId,
			taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
			thinkingInstruction: agentProfile?.thinkingLevelEnabled
				? `use_reasoning_effort: ${agentProfile.thinkingLevel}`
				: "",
			...config.promptValues,
			...(ctx.stageName === "research-scope"
				? {
						researchDeadlineAt: new Date(
							Date.now() + getResearchMinimumDurationMs(),
						).toISOString(),
				}
				: {}),
		},
		{
			ctx: templateContext,
			stageInput: input,
			stageOutput: null,
			readJsonFile: async (containerPath) =>
				await readTaskJsonArtifact({ taskDir, containerPath }),
			allowedRoots: [taskDir],
		},
	);
	return toPromptValues(rendered);
};

export function createGenericAgentStageDefinition<
	TPipelineContext extends PipelineContext & { scanJob?: ScanJob },
>(input: {
	config: YamlPipelineStage;
	outputSchema?: StructuredOutputSchemaSource;
	queue?: StageQueueBinding<TPipelineContext, unknown>;
}): StageDefinition<TPipelineContext, unknown, unknown, StageContext> {
	return createStageDefinition({
		id: input.config.id,
		name: input.config.name,
		persistent: input.config.runtime.persistent ?? undefined,
		reuseContainer: input.config.runtime.reuseContainer ?? undefined,
		nullableOutput: input.config.runtime.nullableOutput ?? undefined,
		jobOutput: input.config.jobOutput,
		goal: input.config.goal ?? false,
		allowAgentExit: input.config.allowAgentExit,
		outputSchema: input.outputSchema,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				input.config.id,
				() => input.config.concurrency,
			),
		launch: async (ctx) => {
			const stageCtx = ctx as GenericStageContext;
			const scanJob = stageCtx.scanJob;
			if (!scanJob) throw new Error("Generic stage requires scanJob context");
			const reuseContainer = resolveStageReuseContainer(
				stageCtx.stageName,
				stageCtx.reuseContainer,
				input.config.goal,
				input.config.runtime.goalSession,
			);
			const containerNameParts = resolveStageContainerNameParts(
				stageCtx.stageName,
				stageCtx.taskId,
				input.config.containerNameParts,
				input.config.goal,
				input.config.runtime.goalSession,
			);
			const runtime = await launchAgentStageRuntime({
				ctx: stageCtx,
				scanJob,
				containerNameParts,
				reuseContainer,
			});
			if (input.config.runtime.prepareRepository) {
				const repositoryState = await prepareRepositoryForScanInContainer({
					containerName: runtime.containerName,
					pipelineId: scanJob.pipelineId,
					targetRef: scanJob.targetRef,
					targetTag: scanJob.targetTag,
					commitSha: scanJob.commitSha,
					baseSha: scanJob.baseSha,
					commitWindow:
						scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
					scanRootDir: runtime.taskStageRootInContainer,
					datasetRepository: Boolean(scanJob.datasetEvaluationTrialId),
				});
				if (!scanJob.datasetEvaluationTrialId) {
					await updateScanJobTargetContextRepo(scanJob.scanJobId, {
					targetRef: repositoryState.currentBranch || repositoryState.targetRef,
					targetTag:
						repositoryState.currentExactTag || repositoryState.targetTag,
					commitSha: repositoryState.resolvedTargetSha,
					baseSha: repositoryState.resolvedBaseSha,
					commitWindow: repositoryState.commitWindow,
				});
			}
			}
		},
	run: async (ctx, stageInput) => {
			const stageCtx = ctx as GenericStageContext;
			const scanJob = stageCtx.scanJob;
			if (!scanJob) throw new Error("Generic stage requires scanJob context");
			let effectiveStageInput =
				isResearchStage(stageCtx.stageName)
					? await enrichResearchTrackInput({
							stageName: stageCtx.stageName,
							stageInput,
							resolveTrack: (trackKey, approachFamily) =>
								findResearchTrackIdentityRepo({
									scanJobId: stageCtx.scanJobId,
									trackKey,
									approachFamily,
								}),
						})
					: stageInput;
			const containerNameParts = resolveStageContainerNameParts(
				stageCtx.stageName,
				stageCtx.taskId,
				input.config.containerNameParts,
				input.config.goal,
				input.config.runtime.goalSession,
			);
			const runtime = await resolveAgentStageRuntime({
				ctx: stageCtx,
				containerNameParts,
			});
			await writeTaskJsonArtifact({
				taskDir: await stageCtx.taskDir(),
				relativePath: "inputs/task-input.json",
				value: effectiveStageInput,
			});
			if (isResearchStage(stageCtx.stageName)) {
				await replaceTaskJsonArtifact({
					taskDir: await stageCtx.taskDir(),
					containerPath: "/task/task-context.json",
					value: buildResearchTaskContext(stageCtx, effectiveStageInput),
				});
			}
			const promptTemplate = await resolveStageRuntimePromptTemplate(stageCtx);
			const promptValues = await resolvePromptValues(
				stageCtx,
				effectiveStageInput,
				input.config,
			);
			const renderedPrompt = await resolveStageRuntimePrompt(
				stageCtx,
				promptTemplate,
				promptValues,
				{ injectSkills: !input.config.goal },
			);
			const sharedSession = input.config.runtime.goalSession === "shared";
			const reentry = Boolean(
				input.config.goal &&
					sharedSession &&
					isSurfaceGoalReentry(effectiveStageInput),
			);
			const stagePrompt = input.config.goal
				? resolveGoalStagePrompt({
						renderedPrompt,
						stageInput: effectiveStageInput,
						sharedSession,
					})
				: renderedPrompt;
			const followUpPrompt = reentry ? stagePrompt : null;
			const standingPrompt = reentry ? "" : stagePrompt;
			const lane = await findStageLaneRuntimeByActiveTaskIdRepo(
				stageCtx.taskId,
			).catch(() => null);
			let initialGoalPrompt = lane?.initialGoalPrompt ?? null;
			if (
				input.config.goal &&
				input.config.goalPreserving &&
				standingPrompt &&
				!initialGoalPrompt &&
				lane
			) {
				await bindStageLaneRuntimeRepo({
					scanJobId: stageCtx.scanJobId,
					stageName: stageCtx.stageName,
					laneIndex: lane.laneIndex,
					initialGoalPrompt: standingPrompt,
				});
				initialGoalPrompt = standingPrompt;
			}
			const result = await runSingleTurnAgentInContainer({
				scanJob,
				agentProfile: runtime.agentProfile,
				containerName: runtime.containerName,
				codexHome: runtime.codexHome,
				stageDirPath: runtime.stageDirPath,
				stageRootInContainer: runtime.stageRootInContainer,
				taskId: stageCtx.taskId,
				taskStageDirPath: runtime.taskStageDirPath,
				taskStageRootInContainer: runtime.taskStageRootInContainer,
				taskRealRootInContainer: runtime.taskRealRootInContainer,
				persistent: stageCtx.persistent,
				reuseContainer: resolveStageReuseContainer(
					stageCtx.stageName,
					stageCtx.reuseContainer,
					input.config.goal,
					input.config.runtime.goalSession,
				),
				groupedPersistent: stageCtx.groupedPersistent,
				allowAgentExit: input.config.allowAgentExit,
				includePolicy: Boolean(input.config.runtime?.includePolicy),
				goalPreserving: Boolean(input.config.goalPreserving),
				followUpPrompt,
				initialGoalPrompt,
				stageName: stageCtx.stageName,
				laneIndex: stageCtx.laneIndex,
				laneThreadId: stageCtx.laneThreadId,
				laneDriverPid: stageCtx.laneDriverPid,
				cwd: await resolveStageRuntimeCwd(stageCtx),
				sessionMode: stageCtx.sessionMode,
				parentSessionId: stageCtx.parentSessionId,
				parentTaskId: stageCtx.parentTaskId,
				goal: Boolean(input.config.goal),
				prompt: standingPrompt,
				outputSchema: input.outputSchema,
				routeOutputSchemas: stageCtx.routeOutputSchemas,
				onThreadId: async (threadId) => {
					await bindTaskRuntimeRepo({ taskId: stageCtx.taskId, threadId });
				},
			});
			return { completion: "deferred", threadId: result.threadId };
		},
		validateOutput: async (_ctx, _stageInput, rawOutput) => {
			try {
				const taskDir = await _ctx.taskDir();
				let output = JSON.parse(rawOutput) as unknown;
				const scanJob = (_ctx as GenericStageContext).scanJob;
				if (isResearchStage(_ctx.stageName)) {
					await assertResearchTrackIdentity({
						stageName: _ctx.stageName,
						stageInput: _stageInput,
						stageOutput: output,
						resolveTrack: (trackKey, approachFamily) =>
							findResearchTrackIdentityRepo({
								scanJobId: _ctx.scanJobId,
								trackKey,
								approachFamily,
							}),
					});
				}
				if (input.outputSchema && isJsonSchemaContract(input.outputSchema)) {
					output = await applySchemaTransforms({
						contract: input.outputSchema,
						taskDir,
						value: output,
					});
					validateStructuredOutputSchemaSource(input.outputSchema, output);
					await validateJsonSchemaContractArtifacts(
						input.outputSchema,
						output,
						async (containerPath) =>
							await readTaskJsonArtifact({ taskDir, containerPath }),
					);
				} else if (input.outputSchema) {
					validateStructuredOutputSchemaSource(input.outputSchema, output);
				}
				if (input.config.report) {
					const reportPath = taskArtifactHostPath({
						taskDir,
						containerPath: input.config.report.path,
					});
					const reportExists = await fs
						.stat(reportPath)
						.then(() => true)
						.catch(() => false);
					if (input.config.report.required && !reportExists) {
						throw new Error(`Required report is missing: ${input.config.report.path}`);
					}
				}
				return output;
			} catch (error) {
				throw new Error(
					`Generic stage returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		onSuccess: async (ctx, stageInput, output, transaction) => {
			for (const effect of input.config.effects) {
				if (effect.type === "sync-candidates") {
					await syncVulnerabilityCandidatesFromProducerTask(
						ctx.taskId,
						transaction as CandidateSyncTransaction | undefined,
					);
				}
				if (effect.type === "tob-goal-registry") {
					const { applyTobGoalRegistryEffect } = await import(
						"../persistence/tob-goal-registry.repo"
					);
					await applyTobGoalRegistryEffect({
						scanJobId: ctx.scanJobId,
						taskId: ctx.taskId,
						operation: effect.operation,
						stageOutput: output,
						stageInput,
					});
				}
			}
		},
	});
}
