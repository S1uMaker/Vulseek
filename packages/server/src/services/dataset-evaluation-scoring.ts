import { promises as fs } from "node:fs";
import path from "node:path";
import { getAgentProfileById } from "./ai";
import { resolveDatasetTrialRuntime } from "./dataset";
import {
	buildDatasetTrialScoringPrompt,
	type DatasetTrialScoringInputOutput,
	datasetTrialScoringAgentOutputSchema,
	selectScorableJobOutputs,
	validateDatasetTrialScoringAgentOutput,
} from "./dataset-evaluation-scoring-contract";
import { taskArtifactHostPath } from "./scan/artifacts/task-artifact-paths";
import { inspectRequiredToolsImageReference } from "./scan/checkout-tools";
import { findScanJobByIdRepo } from "./scan/persistence/scan-job.repo";
import { findMessageByIdRepo } from "./scan/persistence/message.repo";
import {
	findTaskByIdRepo,
	listTasksByScanJobIdRepo,
} from "./scan/persistence/task.repo";
import {
	removeContainer,
	resolveJobRootFromRuntimeDir,
	runSingleTurnAgentInContainer,
	startContainer,
} from "./scan/runtime/run-single-turn-agent";
import { AGENT_RUNTIME_FILE_NAMES } from "./scan/runtime/agent-runtime-files";
import { parseDriverStdout } from "./scan/runtime/driver-stdout-protocol";
import { resolveTaskRuntimeDirForTask } from "./scan/stages/full-scan-stage.runtime";
import type { AgentProfileLike } from "./scan/types";
import { execAsync } from "../utils/process/execAsync";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const TASK_ROOT_IN_CONTAINER = "/task";
const JOB_OUTPUT_ROOT_IN_CONTAINER = "/task/job-output";
const SCORING_MANIFEST_NAME = "comparison-manifest.json";
const SCORING_OUTPUT_NAME = "output.json";
const DEFAULT_SCORING_TIMEOUT_MS = 30 * 60 * 1000;

type PreparedJobOutput = DatasetTrialScoringInputOutput & {
	localArtifacts: Array<{ path: string; localPath: string }>;
};

const sanitizePathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

const scoringTimeoutMs = () => {
	const configured = Number.parseInt(
		process.env.VULSEEK_DATASET_SCORING_TIMEOUT_MS || "",
		10,
	);
	return Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_SCORING_TIMEOUT_MS;
};

const resolveJobRoot = (taskDir: string, scanJobId: string) =>
	resolveJobRootFromRuntimeDir(taskDir, scanJobId);

const resolveProfileHostDir = (projectName: string, serviceName: string) => {
	const scanContextHostRoot =
		process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";
	if (!scanContextHostRoot) {
		throw new Error(
			"Scan context host path is not configured for Dataset Trial scoring",
		);
	}
	return path.join(
		scanContextHostRoot,
		"projects",
		sanitizePathPart(projectName),
		"profiles",
		sanitizePathPart(serviceName),
	);
};

const resolveProfileContainerDir = (projectName: string, serviceName: string) =>
	path.posix.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"projects",
		sanitizePathPart(projectName),
		"profiles",
		sanitizePathPart(serviceName),
	);

const copyGroundTruthArtifacts = async (input: {
	sourceRoot: string;
	scoringDir: string;
	scoringHostDir: string;
	imageTag: string;
	artifacts: string[];
}) => {
	const copyPlan = input.artifacts.map((artifact, index) => ({
		source: artifact,
		target: path.posix.join(
			"inputs",
			"ground-truth",
			`${String(index).padStart(4, "0")}-${sanitizePathPart(
				path.posix.basename(artifact),
			)}`,
		),
	}));
	const copyPlanPath = path.join(input.scoringDir, "ground-truth-copy.json");
	await fs.writeFile(copyPlanPath, `${JSON.stringify(copyPlan, null, 2)}\n`);

	const script = [
		"import json, os, shutil",
		"source_root = os.path.realpath('/dataset')",
		"target_root = os.path.realpath('/evaluation')",
		"with open('/evaluation/ground-truth-copy.json', encoding='utf-8') as handle:",
		"    plan = json.load(handle)",
		"for item in plan:",
		"    relative = item['source']",
		"    if not isinstance(relative, str) or not relative or os.path.isabs(relative):",
		"        raise RuntimeError(f'Invalid ground-truth artifact path: {relative!r}')",
		"    source = os.path.realpath(os.path.join(source_root, relative))",
		"    if source != source_root and not source.startswith(source_root + os.sep):",
		"        raise RuntimeError(f'Ground-truth artifact escapes Dataset root: {relative}')",
		"    if not os.path.isfile(source):",
		"        raise RuntimeError(f'Ground-truth artifact is not a regular file: {relative}')",
		"    target_relative = item['target']",
		"    target = os.path.realpath(os.path.join(target_root, target_relative))",
		"    if target != target_root and not target.startswith(target_root + os.sep):",
		"        raise RuntimeError(f'Ground-truth copy target escapes scoring root: {target_relative}')",
		"    os.makedirs(os.path.dirname(target), exist_ok=True)",
		"    shutil.copyfile(source, target)",
	].join("\n");
	const command = [
		"docker run --rm --network none",
		`--mount ${shellQuote(`type=bind,source=${input.sourceRoot},target=/dataset,readonly`)}`,
		`--mount ${shellQuote(`type=bind,source=${input.scoringHostDir},target=/evaluation`)}`,
		"--entrypoint bash",
		shellQuote(input.imageTag),
		"-lc",
		shellQuote(["python3 - <<'PY'", script, "PY"].join("\n")),
	].join(" ");
	try {
		await execAsync(command);
	} finally {
		await fs.rm(copyPlanPath, { force: true });
	}

	return copyPlan.map((item) => ({
		path: item.source,
		localPath: path.posix.join(TASK_ROOT_IN_CONTAINER, item.target),
	}));
};

const copyJobOutputArtifacts = async (input: {
	scanJobId: string;
	projectName: string;
	serviceName: string;
	scoringDir: string;
	outputs: NonNullable<Awaited<ReturnType<typeof findScanJobByIdRepo>>["outputs"]>;
}) => {
	const prepared: PreparedJobOutput[] = [];
	const outputTasks = [];
	for (const [outputIndex, output] of input.outputs.entries()) {
		const { findMessageByIdRepo } = await import(
			"./scan/persistence/message.repo"
		);
		const taskOutput = await findMessageByIdRepo(output.messageId);
		if (!taskOutput) {
			throw new Error(`Job output Message ${output.messageId} not found`);
		}
		const task = await findTaskByIdRepo(taskOutput.sourceTaskId);
		if (task.scanJobId !== input.scanJobId) {
			throw new Error(
				`Job output task ${task.taskId} does not belong to scan ${input.scanJobId}`,
			);
		}
		if (task.stageName !== output.stageName) {
			throw new Error(
				`Job output stage mismatch for task ${task.taskId}: ${output.stageName} != ${task.stageName}`,
			);
		}
		outputTasks.push(task);
		const taskDir = await resolveTaskRuntimeDirForTask({
			scanJobId: input.scanJobId,
			projectName: input.projectName,
			serviceName: input.serviceName,
			stageName: task.stageName,
			taskName: task.name,
			taskId: task.taskId,
		});
		const localArtifacts: PreparedJobOutput["localArtifacts"] = [];
		const seenPaths = new Set<string>();
		for (const artifact of output.artifacts) {
			if (seenPaths.has(artifact.path)) continue;
			seenPaths.add(artifact.path);
			const relativePath = path.posix.relative(
				JOB_OUTPUT_ROOT_IN_CONTAINER,
				artifact.path,
			);
			if (
				!artifact.path.startsWith(`${JOB_OUTPUT_ROOT_IN_CONTAINER}/`) ||
				!relativePath ||
				relativePath === "." ||
				relativePath.startsWith("../") ||
				path.posix.isAbsolute(relativePath)
			) {
				throw new Error(`Invalid Job output artifact path: ${artifact.path}`);
			}
			const sourcePath = taskArtifactHostPath({
				taskDir,
				containerPath: artifact.path,
			});
			const sourceStat = await fs.lstat(sourcePath);
			if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
				throw new Error(
					`Job output artifact must be a regular non-symbolic file: ${artifact.path}`,
				);
			}
			const outputDirectory = `${String(outputIndex).padStart(4, "0")}-${sanitizePathPart(
				output.stageName,
			)}-${sanitizePathPart(output.messageId).slice(0, 12)}`;
			const targetRelativePath = path.join(
				"inputs",
				"job-outputs",
				outputDirectory,
				...relativePath.split("/"),
			);
			const targetPath = path.join(input.scoringDir, targetRelativePath);
			await fs.mkdir(path.dirname(targetPath), { recursive: true });
			await fs.copyFile(sourcePath, targetPath);
			localArtifacts.push({
				path: artifact.path,
				localPath: path.posix.join(
					TASK_ROOT_IN_CONTAINER,
					...targetRelativePath.split(path.sep),
				),
			});
		}
		prepared.push({
			taskId: task.taskId,
			stageName: output.stageName,
			artifacts: output.artifacts.map((artifact) => artifact.path),
			localArtifacts,
		});
	}
	return { prepared, outputTasks };
};

const resolveScoringAgentProfile = async (input: {
	outputTasks: Awaited<ReturnType<typeof findTaskByIdRepo>>[];
	scanJobId: string;
}): Promise<AgentProfileLike> => {
	const allTasks = await listTasksByScanJobIdRepo(input.scanJobId);
	const profileId = [...input.outputTasks, ...allTasks]
		.map((task) => task.agentProfile?.agentProfileId)
		.find((value): value is string => Boolean(value));
	if (!profileId) {
		throw new Error(
			"Dataset Trial scoring requires an Agent Profile from a scan task",
		);
	}
	const profile = await getAgentProfileById(profileId);
	if (!profile.isEnabled) {
		throw new Error(`Dataset Trial scoring Agent Profile is disabled: ${profileId}`);
	}
	return profile;
};

const readScoringAgentOutput = async (scoringDir: string) => {
	const content = await fs.readFile(path.join(scoringDir, SCORING_OUTPUT_NAME), "utf8");
	const parsed: unknown = JSON.parse(content);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Dataset Trial scoring output.json must be an object");
	}
	return datasetTrialScoringAgentOutputSchema.parse(
		(parsed as { output?: unknown }).output,
	);
};

const waitForScoringAgentOutput = async (scoringDir: string) => {
	const outputPath = path.join(scoringDir, SCORING_OUTPUT_NAME);
	const stdoutPath = path.join(scoringDir, AGENT_RUNTIME_FILE_NAMES.stdout);
	const deadline = Date.now() + scoringTimeoutMs();
	let lastOutputError: unknown = null;
	let completedWithInvalidOutputPolls = 0;
	while (Date.now() < deadline) {
		try {
			const stat = await fs.stat(outputPath);
			if (stat.isFile() && stat.size > 0) {
				return await readScoringAgentOutput(scoringDir);
			}
		} catch (error) {
			lastOutputError = error;
		}
		const stdout = await fs.readFile(stdoutPath, "utf8").catch(() => "");
		const taskEvent = parseDriverStdout(stdout).latestTask;
		if (
			taskEvent?.type === "task_done" &&
			taskEvent.status &&
			taskEvent.status !== "completed"
		) {
			throw new Error(
				`Dataset Trial scoring agent failed: ${taskEvent.stopReason || taskEvent.status}`,
			);
		}
		if (taskEvent?.type === "task_done" && taskEvent.status === "completed") {
			completedWithInvalidOutputPolls += 1;
			if (completedWithInvalidOutputPolls >= 3) {
				throw new Error(
					`Dataset Trial scoring agent completed with invalid output.json${
						lastOutputError instanceof Error
							? `: ${lastOutputError.message}`
							: ""
					}`,
				);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(
		`Dataset Trial scoring timed out waiting for output.json${
			lastOutputError instanceof Error ? `: ${lastOutputError.message}` : ""
		}`,
	);
};

export const scoreDatasetEvaluationTrial = async (input: {
	trialId: string;
	scanJobId: string;
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	const runtime = await resolveDatasetTrialRuntime(input.scanJobId);
	if (!runtime || runtime.trial.trialId !== input.trialId) {
		throw new Error("Dataset Trial scoring context does not match the scan Job");
	}
	const groundTruthArtifacts = [
		...new Set(runtime.sample.groundTruthArtifacts),
	].sort();
	if (!runtime.toolsImageTag || !runtime.toolsImageDigest) {
		throw new Error(
			`Dataset Profile ${runtime.profile.profileId} requires re-checkout to pin a scan tools image`,
		);
	}
	if (
		!(await inspectRequiredToolsImageReference({
			imageTag: runtime.toolsImageTag,
			imageId: runtime.toolsImageDigest,
		}))
	) {
		throw new Error(
			`Dataset scoring tools image is missing or changed: ${runtime.toolsImageTag}`,
		);
	}
	if (groundTruthArtifacts.length === 0) {
		throw new Error("Dataset sample has no ground-truth artifacts to score");
	}
	const outputs = selectScorableJobOutputs([...scanJob.outputs]).sort(
		(left, right) =>
			left.stageName.localeCompare(right.stageName) ||
			left.messageId.localeCompare(right.messageId),
	);
	if (outputs.length === 0) {
		throw new Error("Scan Job produced no Job output artifacts to score");
	}

	const projectName = `dataset-${runtime.dataset.datasetId}`;
	const serviceName = `${runtime.profile.profileId}-${runtime.sample.id}`;
	const firstOutput = await findMessageByIdRepo(outputs[0]!.messageId);
	if (!firstOutput) {
		throw new Error(
			`Job output Message ${outputs[0]!.messageId} not found`,
		);
	}
	const firstTask = await findTaskByIdRepo(firstOutput.sourceTaskId);
	const firstTaskDir = await resolveTaskRuntimeDirForTask({
		scanJobId: input.scanJobId,
		projectName,
		serviceName,
		stageName: firstTask.stageName,
		taskName: firstTask.name,
		taskId: firstTask.taskId,
	});
	const jobRoot = resolveJobRoot(firstTaskDir, input.scanJobId);
	const scoringDirectoryName = `trial-${sanitizePathPart(input.trialId)}`;
	const scoringDir = path.join(jobRoot, "evaluations", scoringDirectoryName);
	const scoringHostDir = path.join(
		resolveProfileHostDir(projectName, serviceName),
		"jobs",
		input.scanJobId,
		"evaluations",
		scoringDirectoryName,
	);
	const scoringContainerDir = path.posix.join(
		resolveProfileContainerDir(projectName, serviceName),
		"jobs",
		input.scanJobId,
		"evaluations",
		scoringDirectoryName,
	);
	await fs.rm(scoringDir, { recursive: true, force: true });
	await fs.mkdir(scoringDir, { recursive: true });

	const groundTruth = await copyGroundTruthArtifacts({
		sourceRoot: runtime.profileHostRoot,
		scoringDir,
		scoringHostDir,
		imageTag: runtime.toolsImageTag,
		artifacts: groundTruthArtifacts,
	});
	const { prepared: preparedOutputs, outputTasks } =
		await copyJobOutputArtifacts({
			scanJobId: input.scanJobId,
			projectName,
			serviceName,
			scoringDir,
			outputs,
		});
	const manifestPath = path.join(scoringDir, SCORING_MANIFEST_NAME);
	await fs.writeFile(
		manifestPath,
		`${JSON.stringify(
			{
				groundTruthArtifacts: groundTruth,
				jobOutputs: preparedOutputs.map((output) => ({
					taskId: output.taskId,
					stageName: output.stageName,
					artifacts: output.localArtifacts,
				})),
			},
			null,
			2,
		)}\n`,
	);
	const agentProfile = await resolveScoringAgentProfile({
		outputTasks,
		scanJobId: input.scanJobId,
	});
	const containerName = [
		"vulseek-dataset-score",
		sanitizePathPart(input.scanJobId).slice(0, 20),
		sanitizePathPart(input.trialId).slice(0, 16),
	].join("-");

	await startContainer({
		scanJob,
		agentProfile,
		containerName,
		codexHome: path.posix.join(scoringContainerDir, ".agent-home"),
		stageDirPath: scoringDir,
		stageRootInContainer: scoringContainerDir,
		taskRealRootInContainer: scoringContainerDir,
		persistent: false,
		reuseContainer: false,
	});
	try {
		await runSingleTurnAgentInContainer({
			scanJob,
			agentProfile,
			containerName,
			codexHome: path.posix.join(scoringContainerDir, ".agent-home"),
			stageDirPath: scoringDir,
			stageRootInContainer: scoringContainerDir,
			taskStageDirPath: scoringDir,
			taskStageRootInContainer: scoringContainerDir,
			taskRealRootInContainer: scoringContainerDir,
			persistent: false,
			reuseContainer: true,
			cwd: "/workspace/repo",
			prompt: buildDatasetTrialScoringPrompt(
				path.posix.join(TASK_ROOT_IN_CONTAINER, SCORING_MANIFEST_NAME),
			),
			outputSchema: datasetTrialScoringAgentOutputSchema,
			sessionMode: "new",
		});
		const rawOutput = await waitForScoringAgentOutput(scoringDir);
		const result = validateDatasetTrialScoringAgentOutput({
			rawOutput,
			groundTruthArtifacts,
			jobOutputs: preparedOutputs.map(({ localArtifacts: _, ...output }) => output),
		});
		return {
			...result,
			evaluator: {
				agentProfileId: agentProfile.agentProfileId,
				provider: agentProfile.provider,
				model: agentProfile.model,
			},
		};
	} finally {
		await removeContainer(containerName);
	}
};
