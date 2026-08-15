import { zodToJsonSchema } from "zod-to-json-schema";
import { getArtifactSchemaAnnotations } from "../artifacts/artifact-schema-annotations";
import {
	getJsonSchemaArtifactAnnotations,
	isJsonSchemaContract,
	type JsonSchemaArtifactAnnotation,
	type StructuredOutputSchemaSource,
} from "../pipeline/scan-pipeline-schema-contracts";

export type RouteOutputSchema = {
	routeKey: string;
	description?: string;
	schema: StructuredOutputSchemaSource;
	default?: boolean;
};

type JsonSchemaObject = Record<string, unknown>;

const outputSchemaSourceToJsonSchema = (
	outputSchema: StructuredOutputSchemaSource,
): JsonSchemaObject =>
	isJsonSchemaContract(outputSchema)
		? outputSchema.schema
		: (zodToJsonSchema(outputSchema, {
				target: "jsonSchema7",
				$refStrategy: "none",
			}) as JsonSchemaObject);

const normalizeDescription = (description: string | undefined) => {
	const value = description?.trim();
	return value ? value : undefined;
};

/**
 * A route key identifies one downstream decision even when it fans out to
 * multiple edges. The first schema is used here; publish validation rejects
 * conflicting schemas for the same source stage and route key.
 */
export const groupRouteOutputSchemas = (
	routeOutputSchemas?: RouteOutputSchema[],
): RouteOutputSchema[] => {
	if (!routeOutputSchemas?.length) return [];
	const grouped = new Map<string, RouteOutputSchema>();
	for (const item of routeOutputSchemas) {
		const description = normalizeDescription(item.description);
		const existing = grouped.get(item.routeKey);
		if (!existing) {
			grouped.set(item.routeKey, {
				...item,
				...(description ? { description } : {}),
				default: Boolean(item.default),
			});
			continue;
		}
		if (!existing.description && description) {
			existing.description = description;
		}
		existing.default = Boolean(existing.default || item.default);
	}
	return [...grouped.values()];
};

const collectArtifactAnnotations = (
	schema: StructuredOutputSchemaSource,
	routeOutputSchemas?: RouteOutputSchema[],
) => {
	const entries = routeOutputSchemas?.length
		? groupRouteOutputSchemas(routeOutputSchemas).flatMap((route) =>
				(isJsonSchemaContract(route.schema)
					? getJsonSchemaArtifactAnnotations(route.schema)
					: getArtifactSchemaAnnotations(route.schema)
				).map((annotation) => ({ routeKey: route.routeKey, annotation })),
			)
		: (isJsonSchemaContract(schema)
				? getJsonSchemaArtifactAnnotations(schema)
				: getArtifactSchemaAnnotations(schema)
			).map((annotation) => ({ routeKey: null, annotation }));
	return entries;
};

const mergeDefinitions = (
	target: Record<string, JsonSchemaObject>,
	schema: JsonSchemaObject,
) => {
	const definitions = schema.definitions;
	if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) {
		return;
	}
	for (const [key, value] of Object.entries(definitions)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			target[key] = value as JsonSchemaObject;
		}
	}
};

const buildArtifactMetadata = (
	schema: StructuredOutputSchemaSource,
	routeOutputSchemas?: RouteOutputSchema[],
) => {
	const definitions: Record<string, JsonSchemaObject> = {};
	const artifacts: Array<{
		route: string | null;
		path: string;
		kind: JsonSchemaArtifactAnnotation["kind"];
		schemaRef: string;
	}> = [];
	for (const [index, entry] of collectArtifactAnnotations(
		schema,
		routeOutputSchemas,
	).entries()) {
		const definitionName = `vulseek_artifact_${index}`;
		const artifactSchema = entry.annotation.jsonSchema;
		if (
			!artifactSchema ||
			typeof artifactSchema !== "object" ||
			Array.isArray(artifactSchema)
		) {
			continue;
		}
		definitions[definitionName] = artifactSchema as JsonSchemaObject;
		artifacts.push({
			route: entry.routeKey,
			path: entry.annotation.path,
			kind: entry.annotation.kind,
			schemaRef: `#/definitions/${definitionName}`,
		});
	}
	return { definitions, artifacts };
};

const buildRouteMetadata = (routeOutputSchemas?: RouteOutputSchema[]) =>
	groupRouteOutputSchemas(routeOutputSchemas).map((item) => ({
		key: item.routeKey,
		...(normalizeDescription(item.description)
			? { description: normalizeDescription(item.description) }
			: {}),
		default: Boolean(item.default),
	}));

export const buildStructuredOutputEnvelopeJsonSchema = (
	schema: StructuredOutputSchemaSource,
	routeOutputSchemas?: RouteOutputSchema[],
	options?: {
		nullableOutput?: boolean;
		allowAgentExit?: boolean;
	},
) => {
	const groupedRoutes = groupRouteOutputSchemas(routeOutputSchemas);
	const definitions: Record<string, JsonSchemaObject> = {};
	const buildEnvelopeOutputSchema = (
		outputSchema: StructuredOutputSchemaSource,
	) => {
		const jsonSchema = outputSchemaSourceToJsonSchema(outputSchema);
		mergeDefinitions(definitions, jsonSchema);
		return jsonSchema;
	};
	const exitSchema = options?.allowAgentExit
		? {
				type: "boolean",
				description:
					"Set true only to exit the current persistent lane or group; this does not select a route or indicate failure.",
			}
		: {
				type: "boolean",
				const: false,
				description:
					"This stage does not allow agent-controlled lane exit; the value must be false.",
			};
	const buildEnvelopeSchema = (input: {
		route: string | null;
		routeDescription?: string;
		outputSchema: StructuredOutputSchemaSource;
	}) => ({
		type: "object",
		properties: {
			route:
				input.route === null
					? {
							type: "null",
							description:
								"No dynamic downstream route is configured for this stage.",
						}
					: {
							type: "string",
							const: input.route,
							...(normalizeDescription(input.routeDescription)
								? { description: normalizeDescription(input.routeDescription) }
								: {}),
						},
			exit: exitSchema,
			output: {
				...(options?.nullableOutput
					? { anyOf: [buildEnvelopeOutputSchema(input.outputSchema), { type: "null" }] }
					: buildEnvelopeOutputSchema(input.outputSchema)),
				description:
					"Structured stage result matching the output schema for the selected route.",
			},
		},
		required: ["route", "exit", "output"],
		additionalProperties: false,
		$schema: "http://json-schema.org/draft-07/schema#",
	});

	const envelope = groupedRoutes.length
		? {
				anyOf: groupedRoutes.map((item) =>
					buildEnvelopeSchema({
						route: item.routeKey,
						routeDescription: item.description,
						outputSchema: item.schema,
					}),
				),
				$schema: "http://json-schema.org/draft-07/schema#",
			}
		: buildEnvelopeSchema({ route: null, outputSchema: schema });
	const artifactMetadata = buildArtifactMetadata(schema, groupedRoutes);
	return {
		...envelope,
		...(Object.keys(definitions).length || Object.keys(artifactMetadata.definitions).length
			? {
					definitions: {
						...definitions,
						...artifactMetadata.definitions,
					},
				}
			: {}),
		"x-vulseek-artifacts": artifactMetadata.artifacts,
		"x-vulseek-routes": buildRouteMetadata(groupedRoutes),
	};
};

export const buildStructuredOutputPromptSuffix = (
	schema: StructuredOutputSchemaSource,
	schemaFilePath: string,
	outputFilePath: string,
	routeOutputSchemas?: RouteOutputSchema[],
	options?: {
		allowAgentExit?: boolean;
		nullableOutput?: boolean;
	},
) => {
	void schema;
	const groupedRoutes = groupRouteOutputSchemas(routeOutputSchemas);
	const routeLines = groupedRoutes.map((item) => {
		const suffix = item.default ? " (default)" : "";
		const description = normalizeDescription(item.description);
		return `- ${item.routeKey}${suffix}${description ? `: ${description}` : ""}`;
	});
	return [
		"",
		"Runtime output protocol (generated; do not duplicate this section in the stage prompt):",
		`- Before producing the final result, read ${schemaFilePath} and use it as the source of truth for the envelope and every output field description.`,
		`- Write the final result only to ${outputFilePath} as a JSON object; do not rely on the chat response.`,
		"- The envelope has exactly three fields: route selects a downstream decision, exit controls persistent lane/group lifetime when enabled, and output contains the structured result.",
		...(options?.nullableOutput
			? ["- This stage may use output=null only when the schema permits it."]
			: []),
		...(options?.allowAgentExit
			? [
					"- Set exit=true only when this task should release the current persistent lane/group; it is not a success/failure signal and does not replace route.",
				]
			: ["- This stage does not allow agent-controlled lane exit; set exit=false."]),
		...(groupedRoutes.length
			? [
					"- Choose exactly one route key below. The description is the condition for selecting it; use the default route only when no more specific route applies.",
					...routeLines,
				]
			: ["- This stage has no dynamic route; set route=null."]),
		"- Read $VULSEEK_AGENT_HOME/skills/output-validator/SKILL.md before validation.",
		`- After writing the output and all referenced artifacts, read ${schemaFilePath} again and run the output-validator Skill command before ending the turn.`,
		`- Run: python "$VULSEEK_AGENT_HOME/skills/output-validator/validate_output.py" --schema ${schemaFilePath} --output ${outputFilePath}`,
		"- If validation fails, fix the files and run the command again. End the turn only after it succeeds.",
		"- Do not add fields outside the schema or include runtime markers in the final response.",
		"",
	].join("\n");
};
