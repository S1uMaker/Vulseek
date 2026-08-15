import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { PipelineContext } from "../stages/full-scan-stage.runtime";
import {
	createPipelineDefinition,
	createPipelineEdge,
	getStageRouteOutputSchemas,
	selectDownstreamEdgesForRoute,
	validatePipelineRouteConfiguration,
} from "./pipeline-definition";
import { createStageDefinition } from "./stage-definition";
import type { StructuredOutputSchemaSource } from "./scan-pipeline-schema-contracts";

const makeStage = (
	name: string,
	outputSchema?: StructuredOutputSchemaSource,
) =>
	createStageDefinition<PipelineContext, unknown, unknown>({
		id: name,
		name,
		outputSchema,
		run: async () => ({
			completion: "immediate",
			rawOutput: "{}",
		}),
	});

const stageOutputSchema = z.object({
	kind: z.string(),
});
const fromStage = makeStage("from", stageOutputSchema);
const buildStage = makeStage("build");
const criticStage = makeStage("critic");
const verifyStage = makeStage("verify");

const buildSchema = z.object({
	kind: z.literal("build"),
	candidateId: z.string(),
});

const criticSchema = z.object({
	kind: z.literal("analysis"),
	analysisId: z.string(),
});

test("validatePipelineRouteConfiguration rejects mixed routed and non-routed edges", () => {
	const pipeline = createPipelineDefinition({
		name: "mixed-route-test",
		stages: [fromStage, buildStage, criticStage] as const,
		edges: [
			createPipelineEdge({
				name: "from-to-build",
				from: fromStage,
				to: buildStage,
				route: { key: "build", default: true },
			}),
			createPipelineEdge({
				name: "from-to-critic",
				from: fromStage,
				to: criticStage,
			}),
		] as const,
	});

	assert.throws(
		() => validatePipelineRouteConfiguration(pipeline),
		/mixes routed and non-routed downstream edges/,
	);
});

test("validatePipelineRouteConfiguration requires exactly one default route", () => {
	const pipeline = createPipelineDefinition({
		name: "missing-default-test",
		stages: [fromStage, buildStage, criticStage] as const,
		edges: [
			createPipelineEdge({
				name: "from-to-build",
				from: fromStage,
				to: buildStage,
				route: { key: "build" },
			}),
			createPipelineEdge({
				name: "from-to-critic",
				from: fromStage,
				to: criticStage,
				route: { key: "critic" },
			}),
		] as const,
	});

	assert.throws(
		() => validatePipelineRouteConfiguration(pipeline),
		/must define exactly one default route/,
	);
});

test("selectDownstreamEdgesForRoute selects matching route and only defaults without a route", () => {
	const pipeline = createPipelineDefinition({
		name: "route-selection-test",
		stages: [fromStage, buildStage, criticStage] as const,
		edges: [
			createPipelineEdge({
				name: "from-to-build",
				from: fromStage,
				to: buildStage,
				route: { key: "build", default: true },
			}),
			createPipelineEdge({
				name: "from-to-critic",
				from: fromStage,
				to: criticStage,
				route: { key: "critic" },
			}),
		] as const,
	});

	const matched = selectDownstreamEdgesForRoute(pipeline, "from", "critic");
	assert.equal(matched.edges.length, 1);
	assert.equal(matched.edges[0]?.name, "from-to-critic");
	assert.equal(matched.selectedRouteKey, "critic");
	assert.equal(matched.fallback, false);

	assert.throws(
		() => selectDownstreamEdgesForRoute(pipeline, "from", "unknown"),
		/Invalid route key unknown/,
	);

	const fallback = selectDownstreamEdgesForRoute(pipeline, "from", null);
	assert.equal(fallback.edges.length, 1);
	assert.equal(fallback.edges[0]?.name, "from-to-build");
	assert.equal(fallback.selectedRouteKey, "build");
	assert.equal(fallback.fallback, true);
});

test("getStageRouteOutputSchemas exposes edge schemas and falls back to stage schema", () => {
	const pipeline = createPipelineDefinition({
		name: "route-schema-test",
		stages: [fromStage, buildStage, criticStage, verifyStage] as const,
		edges: [
			createPipelineEdge({
				name: "from-to-build",
				from: fromStage,
				to: buildStage,
				route: {
					key: "build",
					default: true,
					description: "Build a fuzzer",
				},
				outputSchema: buildSchema,
			}),
			createPipelineEdge({
				name: "from-to-critic",
				from: fromStage,
				to: criticStage,
				route: { key: "critic" },
				outputSchema: criticSchema,
			}),
			createPipelineEdge({
				name: "from-to-verify",
				from: fromStage,
				to: verifyStage,
				route: { key: "verify" },
			}),
		] as const,
	});

	const routeSchemas = getStageRouteOutputSchemas(pipeline, "from");
	assert.equal(routeSchemas?.length, 3);
	assert.deepEqual(
		routeSchemas?.map((item) => ({
			routeKey: item.routeKey,
			description: item.description,
			default: item.default,
		})),
		[
			{
				routeKey: "build",
				description: "Build a fuzzer",
				default: true,
			},
			{
				routeKey: "critic",
				description: undefined,
				default: undefined,
			},
			{
				routeKey: "verify",
				description: undefined,
				default: undefined,
			},
		],
	);
	assert.equal(routeSchemas?.[0]?.schema, buildSchema);
	assert.equal(routeSchemas?.[1]?.schema, criticSchema);
	assert.equal(routeSchemas?.[2]?.schema, stageOutputSchema);
});

test("getStageRouteOutputSchemas rejects routed edges without any output schema", () => {
	const routeSource = makeStage("route-source");
	const pipeline = createPipelineDefinition({
		name: "missing-route-schema-test",
		stages: [routeSource, buildStage] as const,
		edges: [
			createPipelineEdge({
				name: "route-source-to-build",
				from: routeSource,
				to: buildStage,
				route: { key: "build", default: true },
			}),
		] as const,
	});

	assert.throws(
		() => getStageRouteOutputSchemas(pipeline, "route-source"),
		/no edge or stage output schema/,
	);
});
