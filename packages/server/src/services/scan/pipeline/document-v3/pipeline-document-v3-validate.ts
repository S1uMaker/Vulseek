import {
	PIPELINE_HARD_LIMITS,
	PIPELINE_DEFAULT_LIMITS,
	type PipelineDiagnostic,
	type PipelineDocumentV3,
} from "./pipeline-document-v3";

/**
 * Semantic validation of a parsed V3 document.
 *
 * Runs after structural parsing (Zod). Errors block publishing; warnings are
 * shown in the publish dialog but do not block. The same validators are used
 * by the browser editor (shared module — no Node imports).
 */

const error = (
	code: string,
	message: string,
	extra?: Pick<PipelineDiagnostic, "path" | "entity">,
): PipelineDiagnostic => ({
	severity: "error",
	code,
	message,
	...(extra?.path ? { path: extra.path } : {}),
	...(extra?.entity ? { entity: extra.entity } : {}),
});

const warn = (
	code: string,
	message: string,
	extra?: Pick<PipelineDiagnostic, "path" | "entity">,
): PipelineDiagnostic => ({
	severity: "warning",
	code,
	message,
	...(extra?.path ? { path: extra.path } : {}),
	...(extra?.entity ? { entity: extra.entity } : {}),
});

const EXPRESSION_PREFIXES = [
	"$item",
	"$input.",
	"$ctx.",
	"$computed.",
	"$output",
	"$.",
	"$file(",
] as const;

const isExpression = (value: string): boolean =>
	value === "$item" ||
	value === "$output" ||
	EXPRESSION_PREFIXES.some((prefix) => value.startsWith(prefix));

const EXPRESSION_TOKEN_PATTERN = /\$[A-Za-z_][A-Za-z0-9_.()\[\]*]*/g;

/**
 * A value may mix plain text with embedded expressions (e.g. task names like
 * `Candidate Analysis: $file($input.candidatePath).title`). Every `$…` token
 * must start with a supported expression prefix; plain text is fine.
 */
const hasUnsupportedExpressionToken = (value: string): boolean => {
	const tokens = value.match(EXPRESSION_TOKEN_PATTERN) ?? [];
	return tokens.some((token) => !isExpression(token));
};

const isInternalSchemaRef = (value: string): boolean =>
	/^#\/schemas\/[A-Za-z0-9_-]+$/.test(value);

/** Collect schema dependencies from nested JSON Schema and pipeline annotations. */
const collectSchemaRefs = (value: unknown, refs: Set<string>): void => {
	if (Array.isArray(value)) {
		for (const item of value) collectSchemaRefs(item, refs);
		return;
	}
	if (!value || typeof value !== "object") return;

	for (const [key, child] of Object.entries(value)) {
		if ((key === "$ref" || key === "$pathOf") && typeof child === "string" && isInternalSchemaRef(child)) {
			refs.add(child.slice("#/schemas/".length));
		}
		collectSchemaRefs(child, refs);
	}
};

const CONTAINER_WORK_DIRS = [
	"/workspace",
	"/workspace/repo",
	"/scan-context",
	"/task",
	"/lane",
];

/** Paths inside the sandbox must stay within allowed work dirs (no `..`). */
const isSafeContainerPath = (value: string): boolean => {
	if (value.includes("..")) return false;
	if (value.startsWith("/")) {
		return CONTAINER_WORK_DIRS.some(
			(dir) => value === dir || value.startsWith(`${dir}/`),
		);
	}
	return true;
};

export const validatePipelineDocumentV3 = (
	document: PipelineDocumentV3,
): PipelineDiagnostic[] => {
	const diagnostics: PipelineDiagnostic[] = [];

	// --- limits -------------------------------------------------------------
	if (document.limits.maxTasks > PIPELINE_HARD_LIMITS.maxTasks) {
		diagnostics.push(
			error(
				"limits.max_tasks_exceeded",
				`maxTasks ${document.limits.maxTasks} exceeds the platform hard limit of ${PIPELINE_HARD_LIMITS.maxTasks}`,
				{ path: ["limits", "maxTasks"] },
			),
		);
	}
	if (document.limits.maxDurationSeconds > PIPELINE_HARD_LIMITS.maxDurationSeconds) {
		diagnostics.push(
			error(
				"limits.max_duration_exceeded",
				`maxDurationSeconds ${document.limits.maxDurationSeconds} exceeds the platform hard limit of ${PIPELINE_HARD_LIMITS.maxDurationSeconds}`,
				{ path: ["limits", "maxDurationSeconds"] },
			),
		);
	}
	if (
		document.limits.maxTasks > PIPELINE_DEFAULT_LIMITS.maxTasks ||
		document.limits.maxDurationSeconds > PIPELINE_DEFAULT_LIMITS.maxDurationSeconds
	) {
		diagnostics.push(
			warn(
				"limits.above_default",
				"Limits are above the default (10,000 tasks / 24h); make sure the loop topology cannot hit the cap.",
				{ path: ["limits"] },
			),
		);
	}

	const stageIds = new Set(Object.keys(document.stages));
	const edgeIds = new Set<string>();

	// --- root & stages ------------------------------------------------------
	if (!stageIds.has(document.root)) {
		diagnostics.push(
			error("root.unknown", `root stage "${document.root}" does not exist`, {
				path: ["root"],
				entity: { type: "pipeline", id: "pipeline" },
			}),
		);
	}

	// --- edges --------------------------------------------------------------
	for (const edge of document.edges) {
		if (edgeIds.has(edge.id)) {
			diagnostics.push(
				error("edge.duplicate_id", `duplicate edge id "${edge.id}"`, {
					path: ["edges"],
					entity: { type: "edge", id: edge.id },
				}),
			);
		}
		edgeIds.add(edge.id);

		if (!stageIds.has(edge.from)) {
			diagnostics.push(
				error("edge.unknown_source", `edge "${edge.id}" sources unknown stage "${edge.from}"`, {
					path: ["edges", edge.id, "from"],
					entity: { type: "edge", id: edge.id },
				}),
			);
		}
		if (!stageIds.has(edge.to)) {
			diagnostics.push(
				error("edge.unknown_target", `edge "${edge.id}" targets unknown stage "${edge.to}"`, {
					path: ["edges", edge.id, "to"],
					entity: { type: "edge", id: edge.id },
				}),
			);
		}
		if (edge.mode === "fanOut" && !edge.foreach) {
			diagnostics.push(
				error("edge.fanout_requires_foreach", `fanOut edge "${edge.id}" requires a foreach expression`, {
					path: ["edges", edge.id],
					entity: { type: "edge", id: edge.id },
				}),
			);
		}
		if (edge.mode === "map" && edge.foreach) {
			diagnostics.push(
				warn("edge.map_with_foreach", `map edge "${edge.id}" carries a foreach expression; map edges do not expand items`, {
					path: ["edges", edge.id],
					entity: { type: "edge", id: edge.id },
				}),
			);
		}
		if (edge.foreach && !isExpression(edge.foreach)) {
			diagnostics.push(
				error("edge.invalid_foreach", `foreach on edge "${edge.id}" is not a supported expression`, {
					path: ["edges", edge.id, "foreach"],
					entity: { type: "edge", id: edge.id },
				}),
			);
		}
		for (const artifact of edge.artifacts ?? []) {
			if (!isExpression(artifact.from)) {
				diagnostics.push(
					error("edge.invalid_artifact_expression", `artifact "from" on edge "${edge.id}" is not a supported expression`, {
						path: ["edges", edge.id, "artifacts"],
						entity: { type: "edge", id: edge.id },
					}),
				);
			}
		}
		if (edge.outputSchema && !isInternalSchemaRef(edge.outputSchema["$ref"] as string)) {
			const schemaRef = edge.outputSchema["$ref"];
			if (schemaRef && !isInternalSchemaRef(String(schemaRef))) {
				diagnostics.push(
					error("edge.invalid_schema_ref", `edge "${edge.id}" outputSchema references an unknown schema "${String(schemaRef)}"`, {
						path: ["edges", edge.id, "outputSchema"],
						entity: { type: "edge", id: edge.id },
					}),
				);
			}
		}
	}

	// --- route rules --------------------------------------------------------
	for (const stageId of stageIds) {
		const downstream = document.edges.filter((edge) => edge.from === stageId);
		const routed = downstream.filter((edge) => edge.route);
		if (routed.length === 0) continue;
		if (routed.length !== downstream.length) {
			diagnostics.push(
				error(
					"route.mixed_routed",
					`stage "${stageId}" mixes routed and non-routed downstream edges`,
					{
						path: ["stages", stageId],
						entity: { type: "stage", id: stageId },
					},
				),
			);
		}
		const defaultKeys = new Set(
			routed.filter((edge) => edge.route?.default).map((edge) => edge.route!.key),
		);
		if (defaultKeys.size !== 1) {
			diagnostics.push(
				error(
					"route.requires_single_default",
					`stage "${stageId}" must define exactly one default route key among its routed edges`,
					{
						path: ["stages", stageId],
						entity: { type: "stage", id: stageId },
					},
				),
			);
		}
		const routeDescriptions = new Map<string, string>();
		const routeSchemas = new Map<string, string>();
		for (const edge of routed) {
			const route = edge.route!;
			const description = route.description?.trim();
			if (description) {
				const previous = routeDescriptions.get(route.key);
				if (previous && previous !== description) {
					diagnostics.push(
						error(
							"route.conflicting_description",
							`route key "${route.key}" has conflicting descriptions on stage "${stageId}"`,
							{ path: ["edges", edge.id, "route", "description"] },
						),
					);
				}
				routeDescriptions.set(route.key, previous ?? description);
			}
			if (edge.outputSchema) {
				const serialized = JSON.stringify(edge.outputSchema);
				const previous = routeSchemas.get(route.key);
				if (previous && previous !== serialized) {
					diagnostics.push(
						error(
							"route.conflicting_output_schema",
							`route key "${route.key}" has conflicting output schemas on stage "${stageId}"`,
							{ path: ["edges", edge.id, "outputSchema"] },
						),
					);
				}
				routeSchemas.set(route.key, previous ?? serialized);
			}
		}
	}

	// --- reachability (loops allowed) ---------------------------------------
	const reachable = new Set<string>([document.root]);
	const queue = [document.root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const edge of document.edges) {
			if (edge.from === current && !reachable.has(edge.to)) {
				reachable.add(edge.to);
				queue.push(edge.to);
			}
		}
	}
	for (const stageId of stageIds) {
		if (!reachable.has(stageId)) {
			diagnostics.push(
				error("stage.unreachable", `stage "${stageId}" is not reachable from root "${document.root}"`, {
					path: ["stages", stageId],
					entity: { type: "stage", id: stageId },
				}),
			);
		}
	}

	// --- stages -------------------------------------------------------------
	// Stage and edge references are roots. A referenced schema may itself depend
	// on other schemas, so expand the complete dependency closure below before
	// reporting missing or unused schema diagnostics.
	const referencedSchemaIds = new Set<string>();
	for (const edge of document.edges) {
		collectSchemaRefs(edge.outputSchema, referencedSchemaIds);
	}
	for (const [stageId, stage] of Object.entries(document.stages)) {
		for (const schema of [stage.inputSchema, stage.outputSchema]) {
			if (!schema) continue;
			collectSchemaRefs(schema, referencedSchemaIds);
			const schemaRef = schema["$ref"];
			if (typeof schemaRef === "string") {
				if (isInternalSchemaRef(schemaRef)) {
					referencedSchemaIds.add(schemaRef.slice("#/schemas/".length));
				} else {
					diagnostics.push(
						error("stage.invalid_schema_ref", `stage "${stageId}" references unknown schema "${schemaRef}"`, {
							path: ["stages", stageId, "inputSchema"],
							entity: { type: "stage", id: stageId },
						}),
					);
				}
			} else if (typeof schemaRef !== "undefined") {
				diagnostics.push(
					error("stage.invalid_schema_ref", `stage "${stageId}" schema "$ref" must be a string`, {
						path: ["stages", stageId],
						entity: { type: "stage", id: stageId },
					}),
				);
			}
		}

		if (stage.runtime.cwd && !isSafeContainerPath(stage.runtime.cwd)) {
			diagnostics.push(
				error("stage.unsafe_cwd", `stage "${stageId}" cwd "${stage.runtime.cwd}" escapes the allowed work directories`, {
					path: ["stages", stageId, "runtime", "cwd"],
					entity: { type: "stage", id: stageId },
				}),
			);
		}
		if (stage.goalPreserving && stage.runtime.persistent !== true) {
			diagnostics.push(
				error(
					"stage.goal_preserving_requires_persistent",
					`stage "${stageId}" sets goalPreserving but is not persistent`,
					{
						path: ["stages", stageId, "goalPreserving"],
						entity: { type: "stage", id: stageId },
					},
				),
			);
		}
		for (const artifact of [
			...(stage.inputArtifacts ?? []),
			...(stage.outputArtifacts ?? []),
		]) {
			if (!isSafeContainerPath(artifact.to)) {
				diagnostics.push(
					error("stage.unsafe_artifact_path", `stage "${stageId}" artifact target "${artifact.to}" escapes the allowed work directories`, {
						path: ["stages", stageId],
						entity: { type: "stage", id: stageId },
					}),
				);
			}
			if (!isExpression(artifact.from)) {
				diagnostics.push(
					error("stage.invalid_artifact_expression", `stage "${stageId}" artifact "from" is not a supported expression`, {
						path: ["stages", stageId],
						entity: { type: "stage", id: stageId },
					}),
				);
			}
		}
		if (stage.report && !isSafeContainerPath(stage.report.path)) {
			diagnostics.push(
				error("stage.unsafe_report_path", `stage "${stageId}" report path "${stage.report.path}" escapes the allowed work directories`, {
					path: ["stages", stageId, "report", "path"],
					entity: { type: "stage", id: stageId },
				}),
			);
		}
		if (stage.taskName && hasUnsupportedExpressionToken(stage.taskName)) {
			diagnostics.push(
				error("stage.invalid_task_name", `stage "${stageId}" taskName contains an unsupported expression`, {
					path: ["stages", stageId, "taskName"],
					entity: { type: "stage", id: stageId },
				}),
			);
		}

		// plugin / effect compatibility ---------------------------------------
		const hasResearchRegistryEffect = (stage.effects ?? []).some(
			(effect) => effect.type === "research-registry",
		);
		if (
			((stage.runtime.plugins ?? []).includes("research-track") ||
				(stage.runtime.plugins ?? []).includes("research-deadline")) &&
			!hasResearchRegistryEffect
		) {
			diagnostics.push(
				error(
					"stage.plugin_requires_research_registry",
					`stage "${stageId}" uses a research plugin but has no research-registry effect`,
					{
						path: ["stages", stageId, "runtime", "plugins"],
						entity: { type: "stage", id: stageId },
					},
				),
			);
		}
	}
	const pendingSchemaIds = [...referencedSchemaIds];
	while (pendingSchemaIds.length > 0) {
		const schemaId = pendingSchemaIds.pop()!;
		const schema = document.schemas[schemaId];
		if (!schema) continue;
		const dependencies = new Set<string>();
		collectSchemaRefs(schema, dependencies);
		for (const dependency of dependencies) {
			if (referencedSchemaIds.has(dependency)) continue;
			referencedSchemaIds.add(dependency);
			pendingSchemaIds.push(dependency);
		}
	}

	// --- schema refs exist --------------------------------------------------
	for (const schemaId of referencedSchemaIds) {
		if (!document.schemas[schemaId]) {
			diagnostics.push(
				error("schema.missing", `schema "${schemaId}" is referenced but not defined`, {
					path: ["schemas"],
					entity: { type: "schema", id: schemaId },
				}),
			);
		}
	}
	for (const schemaId of Object.keys(document.schemas)) {
		if (!referencedSchemaIds.has(schemaId)) {
			diagnostics.push(
				warn("schema.unused", `schema "${schemaId}" is not reachable from any stage or edge schema reference`, {
					path: ["schemas", schemaId],
					entity: { type: "schema", id: schemaId },
				}),
			);
		}
	}

	// --- groups -------------------------------------------------------------
	for (const group of document.groups ?? []) {
		if (!stageIds.has(group.leader)) {
			diagnostics.push(
				error("group.unknown_leader", `group "${group.id}" leader "${group.leader}" does not exist`, {
					path: ["groups", group.id],
					entity: { type: "group", id: group.id },
				}),
			);
		}
		for (const member of group.members) {
			if (!stageIds.has(member)) {
				diagnostics.push(
					error("group.unknown_member", `group "${group.id}" member "${member}" does not exist`, {
						path: ["groups", group.id],
						entity: { type: "group", id: group.id },
					}),
				);
			}
		}
	}

	// --- ui layout refs -----------------------------------------------------
	if (document.ui) {
		for (const nodeId of Object.keys(document.ui.nodes)) {
			if (!stageIds.has(nodeId)) {
				diagnostics.push(
					warn("ui.unknown_node", `ui layout references unknown stage "${nodeId}"`, {
						path: ["ui", "nodes", nodeId],
					}),
				);
			}
		}
		for (const edgeId of Object.keys(document.ui.edges ?? {})) {
			if (!edgeIds.has(edgeId)) {
				diagnostics.push(
					warn("ui.unknown_edge", `ui layout references unknown edge "${edgeId}"`, {
						path: ["ui", "edges", edgeId],
					}),
				);
			}
		}
	}

	if (!document.ui) {
		diagnostics.push(
			warn("ui.missing_layout", "No canvas layout stored; the editor will auto-layout stages on first open.", {
				path: ["ui"],
			}),
		);
	}

	return diagnostics;
};

export const collectPipelineDiagnostics = (
	document: PipelineDocumentV3,
): PipelineDiagnostic[] => validatePipelineDocumentV3(document);

export const hasBlockingDiagnostics = (
	diagnostics: PipelineDiagnostic[],
): boolean => diagnostics.some((diagnostic) => diagnostic.severity === "error");
