import type { CompiledPipelineDefinition } from "@vulseek/server/services/scan/pipeline/document-v3/pipeline-v3-compiler";
import {
	reconstructTaskInput,
	reconstructTaskInputFromSource,
	reconstructTaskLaunchInput,
} from "@vulseek/server/services/scan/runtime/reconstruct-task-input";
import type {
	Message,
	ScanJob,
	Task,
} from "@vulseek/server/services/scan/types";
import { describe, expect, it } from "vitest";

/**
 * Contract under test: dispatch-time edge artifacts are copied into the child
 * task dir at `/task/<artifact.to>` and the input fields pointing at them must
 * be rewritten to those copies when a task LAUNCHES (prompt expressions read
 * files relative to the task's own dir), while the raw reconstruction keeps
 * the producer-relative paths so dispatch-time copies can still resolve
 * against the producer. The chain itself must resolve producer inputs with
 * launch semantics, or hop>=2 templates render stale grandparent paths.
 */

const snapshot = {
	version: 3,
	pipelineId: "p1",
	name: "test-pipeline",
	supportedTargets: ["application"],
	root: "root",
	limits: {},
	prepareRepository: "none",
	presentation: {},
	schemas: {},
	stages: [
		{ id: "root", name: "Root", key: "root", role: "scan", group: "g" },
		{
			id: "asm",
			name: "Attack Surface",
			key: "asm",
			role: "scan",
			group: "g",
		},
		{
			id: "identify",
			name: "Identify",
			key: "identify",
			role: "scan",
			group: "g",
		},
	],
	edges: [
		{
			id: "root-to-asm",
			name: "root-to-asm",
			from: "root",
			to: "asm",
			mode: "fanOut",
			foreach: "$.modules[*]",
			input: {
				repositoryPath: "$input.repositoryPath",
				modulePath: "$item",
			},
			artifacts: [
				{
					from: "$input.repositoryPath",
					to: "inputs/repository.json",
					inputField: "repositoryPath",
					required: true,
				},
				{
					from: "$input.modulePath",
					to: "inputs/module.json",
					inputField: "modulePath",
					required: true,
				},
			],
		},
		{
			id: "asm-to-identify",
			name: "asm-to-identify",
			from: "asm",
			to: "identify",
			mode: "map",
			input: {
				repositoryPath: "$input.repositoryPath",
				modulePath: "$input.modulePath",
			},
			artifacts: [
				{
					from: "$input.repositoryPath",
					to: "inputs/repository.json",
					inputField: "repositoryPath",
					required: true,
				},
				{
					from: "$input.modulePath",
					to: "inputs/module.json",
					inputField: "modulePath",
					required: true,
				},
			],
		},
	],
} as unknown as CompiledPipelineDefinition;

const tasks: Record<string, Partial<Task>> = {
	root: {
		taskId: "root",
		scanJobId: "job1",
		stageName: "root",
		name: "Root",
		sourceMessageId: null,
		sourceEdgeName: null,
		sourceItemIndex: null,
		rerunOfTaskId: null,
	},
	asm: {
		taskId: "asm",
		scanJobId: "job1",
		stageName: "asm",
		name: "Asm",
		sourceMessageId: "m1",
		sourceEdgeName: "root-to-asm",
		sourceItemIndex: 0,
		rerunOfTaskId: null,
	},
	identify: {
		taskId: "identify",
		scanJobId: "job1",
		stageName: "identify",
		name: "Identify",
		sourceMessageId: "m2",
		sourceEdgeName: "asm-to-identify",
		sourceItemIndex: 0,
		rerunOfTaskId: null,
	},
};

const messages: Record<string, Partial<Message>> = {
	m1: {
		messageId: "m1",
		scanJobId: "job1",
		sourceTaskId: "root",
		payload: {
			modules: ["/task/modules/a.json"],
			repository: "/task/repository.json",
		},
	},
	m2: {
		messageId: "m2",
		scanJobId: "job1",
		sourceTaskId: "asm",
		payload: { threatModelPath: "/task/outputs/threat-model.json" },
	},
};

const job = {
	scanJobId: "job1",
	pipelineCompiledSnapshot: snapshot,
} as unknown as ScanJob;

// Files that dispatch materialized inside each task's own dir.
const materializedFiles: Record<string, Record<string, unknown>> = {
	root: {
		"/task/inputs/repository.json": { id: "repo" },
		"/task/repository.json": { id: "repo" },
		"/task/modules/a.json": { name: "Module A" },
	},
	asm: {
		"/task/inputs/repository.json": { id: "repo" },
		"/task/inputs/module.json": { name: "Module A" },
		"/task/outputs/threat-model.json": { likelyVulnerabilityClasses: [] },
	},
	identify: {
		"/task/inputs/repository.json": { id: "repo" },
		"/task/inputs/module.json": { name: "Module A" },
	},
};

const makeDeps = () => ({
	findTaskById: async (taskId: string) => (tasks[taskId] ?? null) as Task,
	findMessageById: async (messageId: string) =>
		(messages[messageId] ?? null) as Message,
	findScanJobById: async () => job,
	readProducerArtifact: async (task: Task, containerPath: string) => {
		const file = materializedFiles[task.taskId]?.[containerPath];
		if (file === undefined) {
			throw new Error(`ENOENT: ${task.taskId} ${containerPath}`);
		}
		return file;
	},
	taskArtifactExists: async (taskId: string, containerPath: string) =>
		Boolean(materializedFiles[taskId]?.[containerPath]),
});

describe("reconstruct-task-input launch semantics", () => {
	it("raw reconstruction keeps producer-relative paths (copy-source semantics)", async () => {
		const input = (await reconstructTaskInput(
			tasks.asm as Task,
			makeDeps(),
		)) as Record<string, unknown>;
		// modulePath comes from the producer output's $item and stays
		// producer-relative; repositoryPath inherits the root input's value.
		// Neither is rewritten to the consumer copy paths at this stage.
		expect(input.modulePath).toBe("/task/modules/a.json");
		expect(input.repositoryPath).toBe("/task/inputs/repository.json");
	});

	it("launch input rewrites artifact fields to the task's own copies", async () => {
		const input = (await reconstructTaskLaunchInput(
			tasks.asm as Task,
			makeDeps(),
		)) as Record<string, unknown>;
		expect(input.repositoryPath).toBe("/task/inputs/repository.json");
		expect(input.modulePath).toBe("/task/inputs/module.json");
	});

	it("chain reconstruction renders producer inputs with launch semantics (hop>=2)", async () => {
		const mapped = (await reconstructTaskInputFromSource(
			{
				scanJobId: "job1",
				sourceMessageId: "m2",
				sourceEdgeName: "asm-to-identify",
				sourceItemIndex: 0,
				taskId: "identify",
			},
			makeDeps(),
		)) as Record<string, unknown>;
		// Pre-fix regression: this resolved to the grandparent's
		// /task/repository.json which does not exist in the producer's dir.
		expect(mapped.repositoryPath).toBe("/task/inputs/repository.json");
		expect(mapped.modulePath).toBe("/task/inputs/module.json");
	});

	it("optional artifacts are only rewritten when materialized", async () => {
		const { applyTaskEdgeArtifactInputFields } = await import(
			"@vulseek/server/services/scan/runtime/reconstruct-task-input"
		);
		const value = { modulePath: "/task/modules/a.json" };
		const rewritten = (await applyTaskEdgeArtifactInputFields({
			value,
			scanJobId: "job1",
			sourceMessageId: "m1",
			sourceEdgeName: "root-to-asm-optional",
			taskId: "asm",
			deps: {
				...makeDeps(),
				// Force the "copy never materialized" branch for this case.
				taskArtifactExists: async () => false,
				findScanJobById: async () =>
					({
						scanJobId: "job1",
						pipelineCompiledSnapshot: {
							...snapshot,
							edges: [
								{
									id: "root-to-asm-optional",
									name: "root-to-asm-optional",
									from: "root",
									to: "asm",
									mode: "fanOut",
									input: {},
									artifacts: [
										{
											from: "$item",
											to: "inputs/module.json",
											inputField: "modulePath",
											required: false,
										},
									],
								},
							],
						},
					}) as unknown as ScanJob,
			},
		})) as Record<string, unknown>;
		expect(rewritten.modulePath).toBe("/task/modules/a.json");
	});
});
