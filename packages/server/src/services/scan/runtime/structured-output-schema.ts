import { zodToJsonSchema } from "zod-to-json-schema";
import {
	isJsonSchemaContract,
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

export const buildStructuredOutputJsonSchema = (
	schema: StructuredOutputSchemaSource,
	routeOutputSchemas?: RouteOutputSchema[],
	options?: {
		nullableOutput?: boolean;
	},
) => {
	const groupedRoutes = groupRouteOutputSchemas(routeOutputSchemas);
	const definitions: Record<string, JsonSchemaObject> = {};
	const wrapNullable = (jsonSchema: JsonSchemaObject) =>
		options?.nullableOutput
			? { anyOf: [jsonSchema, { type: "null" }] }
			: jsonSchema;
	const toOutputSchema = (outputSchema: StructuredOutputSchemaSource) => {
		const jsonSchema = outputSchemaSourceToJsonSchema(outputSchema);
		mergeDefinitions(definitions, jsonSchema);
		return wrapNullable(jsonSchema);
	};
	const body = groupedRoutes.length
		? {
				anyOf: groupedRoutes.map((item) => toOutputSchema(item.schema)),
			}
		: {
				...toOutputSchema(schema),
			};
	return {
		...body,
		$schema: "http://json-schema.org/draft-07/schema#",
		...(Object.keys(definitions).length ? { definitions } : {}),
	};
};

export const buildStructuredOutputPromptSuffix = (
	schemaFilePath: string,
	routeOutputSchemas?: RouteOutputSchema[],
	options?: {
		nullableOutput?: boolean;
	},
) => {
	const groupedRoutes = groupRouteOutputSchemas(routeOutputSchemas);
	const routeLines = groupedRoutes.map((item) => {
		const suffix = item.default ? " (default)" : "";
		const description = normalizeDescription(item.description);
		return `- ${item.routeKey}${suffix}${description ? `: ${description}` : ""}`;
	});
	const skillDirectory = "$VULSEEK_AGENT_HOME/skills/scan-runtime";
	const skillCommand = `python3 "${skillDirectory}/scan_runtime.py"`;
	return [
		"",
		"OUTPUT SUBMISSION:",
		`- Use ${skillDirectory} to submit every output. Read ${schemaFilePath} first; the submitted JSON must match its output data schema.`,
		`- Submit with ${skillCommand} submit-message [--route KEY] [--submission-key KEY] < payload.json.`,
		"- Submit as soon as you have a new discovery or other useful result. You may call submit-message multiple times; every accepted submission is an independent Message.",
		"- If you have no discovery or other result, still submit a schema-compatible empty object or array (or the minimal valid empty-result payload required by the schema).",
		...(options?.nullableOutput
			? ["- You may submit null only when the output schema permits it."]
			: []),
		...(groupedRoutes.length
			? [
					"- To target a specific downstream stage, pass its route key with --route. Choose the key whose description matches this output.",
					...routeLines,
				]
			: ["- This stage has no dynamic routes; omit --route."]),
		"",
	].join("\n");
};
