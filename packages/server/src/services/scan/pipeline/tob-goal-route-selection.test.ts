import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsePipelineDocumentV3 } from "./document-v3";
import {
	createPipelineDefinition,
	selectDownstreamEdgesForRoute,
} from "./pipeline-definition";
import { loadScanPipelineDefinitions } from "./scan-pipeline-definitions";

const stage = (id: string) => ({
	id,
	name: id,
	run: async () =>
		({
			completion: "immediate" as const,
			rawOutput: "{}",
		}),
});

test("selectDownstreamEdgesForRoute returns all edges sharing a route key", () => {
	const hunt = stage("goal-hunt");
	const judge = stage("goal-judge");
	const surface = stage("goal-surface");
	const pipeline = createPipelineDefinition({
		name: "tob-goal-route",
		stages: [hunt, judge, surface],
		edges: [
			{
				name: "hunt-judge",
				from: hunt,
				to: judge,
				route: { key: "candidate", default: true },
			},
			{
				name: "hunt-exhausted",
				from: hunt,
				to: surface,
				route: { key: "exhausted" },
			},
		],
	});

	const candidate = selectDownstreamEdgesForRoute(pipeline, "goal-hunt", "candidate");
	assert.deepEqual(
		candidate.edges.map((edge) => edge.name).sort(),
		["hunt-judge"],
	);

	const exhausted = selectDownstreamEdgesForRoute(pipeline, "goal-hunt", "exhausted");
	assert.deepEqual(
		exhausted.edges.map((edge) => edge.name),
		["hunt-exhausted"],
	);
});

const tobGoalYaml = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"definitions/pipelines-v3/tob-goal.yaml",
	),
	"utf-8",
);

test("tob-goal YAML drops inline GoalSpec and hunt-candidate re-entry", () => {
	const { document, diagnostics } = parsePipelineDocumentV3(tobGoalYaml);
	assert.ok(document);
	assert.equal(
		diagnostics.filter((item) => item.severity === "error").length,
		0,
	);

	const huntGoal = document.schemas["hunt-goal"] as Record<string, unknown>;
	const huntRequired = huntGoal.required as string[];
	assert.ok(huntRequired.includes("scopeStatement"));
	assert.ok(!huntRequired.includes("objective"));
	assert.ok(!JSON.stringify(huntGoal).includes('"objective"'));

	const goalSpec = document.schemas["goal-spec"] as Record<string, unknown>;
	assert.ok(!JSON.stringify(goalSpec).includes("goalPrompt"));

	const craftOutput = document.schemas["goal-craft-output"] as Record<
		string,
		unknown
	>;
	assert.deepEqual(craftOutput.required, ["goalSpecPath"]);
	assert.equal(
		(craftOutput.properties as Record<string, unknown>).goalSpec,
		undefined,
	);

	const feedback = document.schemas["surface-feedback"] as {
		properties: { kind: { enum: string[] } };
	};
	assert.ok(!feedback.properties.kind.enum.includes("hunt-candidate"));

	const huntOutput = document.schemas["goal-hunt-output"] as {
		required: string[];
		properties: Record<string, unknown>;
	};
	assert.deepEqual(huntOutput.required, ["candidate", "exhaustion"]);
	assert.equal(huntOutput.properties.outcome, undefined);

	assert.equal(document.stages["goal-surface"]?.goal, true);
	assert.equal(document.stages["goal-surface"]?.runtime.goalSession, "shared");
	assert.deepEqual(document.stages["goal-craft"]?.inputSchema, {
		$ref: "#/schemas/goal-craft-input",
	});
	assert.deepEqual(document.stages["goal-surface"]?.inputSchema, {
		$ref: "#/schemas/goal-surface-input",
	});
	assert.deepEqual(document.stages["goal-hunt"]?.inputSchema, {
		$ref: "#/schemas/goal-hunt-input",
	});

	const edgeNames = document.edges.map((edge) => edge.name);
	assert.ok(!edgeNames.includes("goal-hunt-candidate-to-goal-surface"));

	const craftToSurface = document.edges.find(
		(edge) => edge.name === "goal-craft-to-goal-surface",
	);
	assert.ok(craftToSurface);
	assert.equal(
		(craftToSurface.input as Record<string, unknown>).goalSpec,
		undefined,
	);

	const candidateEdges = document.edges.filter(
		(edge) => edge.from === "goal-hunt" && edge.route?.key === "candidate",
	);
	assert.deepEqual(
		candidateEdges.map((edge) => edge.to),
		["goal-judge"],
	);
	const exhaustedEdges = document.edges.filter(
		(edge) => edge.from === "goal-hunt" && edge.route?.key === "exhausted",
	);
	assert.deepEqual(
		exhaustedEdges.map((edge) => edge.to),
		["goal-surface"],
	);
});

test("V2 tob-goal hunt-goal schema uses scopeStatement instead of objective", () => {
	const definitions = loadScanPipelineDefinitions();
	const huntGoal = definitions.schemas.HuntGoal as {
		required?: string[];
		properties?: Record<string, unknown>;
	};
	assert.ok(huntGoal.required?.includes("scopeStatement"));
	assert.ok(!huntGoal.required?.includes("objective"));
	assert.equal(huntGoal.properties?.objective, undefined);
	assert.equal(
		(definitions.schemas.GoalCraftOutput as { required?: string[] }).required?.includes(
			"goalSpec",
		),
		false,
	);
});
