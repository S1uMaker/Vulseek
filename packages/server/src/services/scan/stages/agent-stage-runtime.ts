import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import { createStageRuntimeConfig } from "../pipeline/scan-stage-runtime-config";
import { injectSkillListIntoPrompt } from "../prompts/inject-skill-list";
import {
	type PromptTemplateValues,
	renderPromptTemplateString,
} from "../prompts/prompt-template";
import { startContainer } from "../runtime/run-single-turn-agent";
import type { AgentProfileLike, ScanJob } from "../types";
import type { StageContext } from "./full-scan-stage.runtime";

const DEFAULT_RUNTIME_SKILLS = ["output-validator"] as const;

export type AgentStageRuntime = {
	agentProfile: AgentProfileLike | null;
	taskStageDirPath: string;
	taskStageRootInContainer: string;
	taskRealRootInContainer: string;
	stageDirPath: string;
	stageRootInContainer: string;
	containerName: string;
	codexHome: string;
};

export const resolveAgentStageRuntime = async (input: {
	ctx: StageContext;
	containerNameParts?: Array<string | null | undefined>;
	codexHomeName?: string;
}): Promise<AgentStageRuntime> => {
	const agentProfile = await input.ctx.agentProfile();
	const taskStageDirPath = await input.ctx.taskDir();
	const taskStageRootInContainer = await input.ctx.taskDirContainer();
	const taskRealRootInContainer = await input.ctx.taskDirRealContainer();
	const stageDirPath =
		input.ctx.laneIndex !== null ? await input.ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer =
		input.ctx.laneIndex !== null
			? await input.ctx.laneDirContainer()
			: taskRealRootInContainer;
	const containerName = input.ctx.containerName(
		...(input.containerNameParts || []),
	);
	const codexHome = `${stageRootInContainer}/${input.codexHomeName || ".codex"}`;
	return {
		agentProfile,
		taskStageDirPath,
		taskStageRootInContainer,
		taskRealRootInContainer,
		stageDirPath,
		stageRootInContainer,
		containerName,
		codexHome,
	};
};

export const launchAgentStageRuntime = async (input: {
	ctx: StageContext;
	scanJob: ScanJob;
	containerNameParts?: Array<string | null | undefined>;
	codexHomeName?: string;
	reuseContainer?: boolean;
}) => {
	const runtime = await resolveAgentStageRuntime(input);
	await bindTaskRuntimeRepo({
		taskId: input.ctx.taskId,
		containerName: runtime.containerName,
		containerIndex: input.ctx.containerIndex,
		agentProfile: buildTaskAgentProfileSnapshot(runtime.agentProfile)
			.agentProfile,
	});
	await startContainer({
		scanJob: input.scanJob,
		taskId: input.ctx.taskId,
		agentProfile: runtime.agentProfile,
		containerName: runtime.containerName,
		codexHome: runtime.codexHome,
		stageDirPath: runtime.stageDirPath,
		stageRootInContainer: runtime.stageRootInContainer,
		taskRealRootInContainer: runtime.taskRealRootInContainer,
		laneHostPath:
			input.ctx.laneIndex !== null ? runtime.stageDirPath : undefined,
		persistent: input.ctx.persistent,
		reuseContainer: input.reuseContainer ?? input.ctx.reuseContainer,
	});
	return runtime;
};

export const resolveStageRuntimeCwd = async (
	ctx: StageContext,
	fallback = "/workspace/repo",
) =>
	(await createStageRuntimeConfig(ctx.scanJobId, ctx.stageName).getCwd()) ||
	fallback;

export const resolveStageRuntimePromptTemplate = async (ctx: StageContext) => {
	const prompt = await createStageRuntimeConfig(
		ctx.scanJobId,
		ctx.stageName,
	).getPrompt();
	if (prompt == null) {
		throw new Error(
			`Stage ${ctx.stageName} has no prompt or promptFile configured in the Stage Graph`,
		);
	}
	return prompt;
};

export const resolveStageRuntimePrompt = async (
	ctx: StageContext,
	promptTemplate: string,
	values: PromptTemplateValues,
	options?: { injectSkills?: boolean },
) => {
	const rendered = renderPromptTemplateString(promptTemplate, values);
	if (options?.injectSkills === false) {
		return rendered;
	}
	const skills = await createStageRuntimeConfig(
		ctx.scanJobId,
		ctx.stageName,
	).getSkills();
	return injectSkillListIntoPrompt(rendered, [
		...(skills ?? []),
		...DEFAULT_RUNTIME_SKILLS,
	]);
};
