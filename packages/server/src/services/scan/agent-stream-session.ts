import {
	type AgentTaskRuntime,
	buildAgentTaskRuntime,
	findAgentTaskRuntimeByTaskId,
} from "./live-session";
import { listTaskSessionRuntimeMetadataByThreadRepo } from "./persistence/task.repo";
import { findStageLaneRuntimeByTaskIdRepo } from "./persistence/stage-lane-runtime.repo";
import {
	buildNativeAgentTranscriptRoots,
	findNativeAgentTranscript,
	type NativeAgentTranscriptProvider,
} from "./native-agent-transcript";

export type AgentStreamRuntime = {
	runtime: AgentTaskRuntime;
	provider: NativeAgentTranscriptProvider;
	threadId: string | null;
	roots: string[];
	transcriptPath: string | null;
	promptSources: AgentTaskRuntime[];
};

export const findAgentStreamRuntimeByTaskId = async (
	taskId: string,
): Promise<AgentStreamRuntime | null> => {
	const runtime = await findAgentTaskRuntimeByTaskId(taskId);
	if (!runtime) {
		return null;
	}

	const roots = buildNativeAgentTranscriptRoots({
		runtimeDir: runtime.runtimeDir,
		scanJobId: runtime.scanJobId,
	});

	const provider: NativeAgentTranscriptProvider =
		runtime.provider === "claude"
			? "claude-code"
			: runtime.provider === "grok"
				? "grok"
				: "codex";
	const transcriptPath = await findNativeAgentTranscript({
		roots,
		provider,
		threadId: runtime.sessionId,
	});

	let promptSources = [runtime];
	if (runtime.sessionId) {
		const lane = await findStageLaneRuntimeByTaskIdRepo({
			scanJobId: runtime.scanJobId,
			stageName: runtime.stageName,
			taskId: runtime.taskId,
		}).catch(() => null);
		if (lane) {
			const sessionTasks = await listTaskSessionRuntimeMetadataByThreadRepo({
				scanJobId: runtime.scanJobId,
				stageName: runtime.stageName,
				threadId: runtime.sessionId,
			}).catch(() => []);
			const builtSources = await Promise.all(
				sessionTasks.map((task) =>
					buildAgentTaskRuntime(task, runtime.baseDir),
				),
			);
			if (builtSources.length > 0) {
				promptSources = builtSources.some(
					(source) => source.taskId === runtime.taskId,
				)
					? builtSources
					: [...builtSources, runtime];
				promptSources.sort((left, right) => {
					const leftAt = left.createdAt || left.updatedAt || "";
					const rightAt = right.createdAt || right.updatedAt || "";
					return (
						leftAt.localeCompare(rightAt) ||
						left.taskId.localeCompare(right.taskId)
					);
				});
			}
		}
	}

	return {
		runtime,
		provider,
		threadId: runtime.sessionId,
		roots,
		transcriptPath,
		promptSources,
	};
};
