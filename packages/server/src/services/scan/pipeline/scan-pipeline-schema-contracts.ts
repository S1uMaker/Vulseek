import type { ZodTypeAny } from "zod";

export type JsonSchemaObject = Record<string, unknown>;

export type JsonSchemaArtifactAnnotation = {
	path: string;
	kind: "path" | "path_list";
	jsonSchema: JsonSchemaObject;
	valueAnnotations: JsonSchemaValueAnnotation[];
	artifactAnnotations: JsonSchemaArtifactAnnotation[];
};

export type JsonSchemaValueAnnotation =
	| {
			path: string;
			kind: "generate";
			generator: "uuid";
			length: number;
			prefix: string;
	  }
	| {
			path: string;
			kind: "normalize";
			steps: Array<"trim" | "remove-empty" | "unique">;
	  };

export type JsonSchemaContract = {
	kind: "json-schema";
	schema: JsonSchemaObject;
	artifactAnnotations: JsonSchemaArtifactAnnotation[];
	valueAnnotations: JsonSchemaValueAnnotation[];
	validate: (value: unknown) => void;
};

export type StructuredOutputSchemaSource = ZodTypeAny | JsonSchemaContract;

const PATH_OF_KEY = "$pathOf";

const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const resolveInternalSchemaRef = (
	ref: string,
	schemas: Record<string, JsonSchemaObject>,
) => {
	const prefix = "#/schemas/";
	if (!ref.startsWith(prefix)) {
		throw new Error(`Unsupported schema reference ${ref}`);
	}
	const schemaName = ref.slice(prefix.length);
	const schema = schemas[schemaName];
	if (!schema) {
		throw new Error(`Unknown schema reference ${ref}`);
	}
	return schema;
};

const normalizeJsonSchema = (input: {
	schema: unknown;
	schemas: Record<string, JsonSchemaObject>;
	path: string;
}): {
	schema: unknown;
	artifactAnnotations: JsonSchemaArtifactAnnotation[];
	valueAnnotations: JsonSchemaValueAnnotation[];
} => {
	if (!isObject(input.schema)) {
		return {
			schema: input.schema,
			artifactAnnotations: [],
			valueAnnotations: [],
		};
	}

	const ref = input.schema.$ref;
	if (typeof ref === "string") {
		return normalizeJsonSchema({
			schema: resolveInternalSchemaRef(ref, input.schemas),
			schemas: input.schemas,
			path: input.path,
		});
	}

	return normalizePathOfSchema(input);
};

const normalizeValueAnnotations = (
	schema: unknown,
	schemas: Record<string, JsonSchemaObject>,
	path = "",
): JsonSchemaValueAnnotation[] => {
	if (!isObject(schema)) return [];
	if (typeof schema.$ref === "string") {
		return normalizeValueAnnotations(
			resolveInternalSchemaRef(schema.$ref, schemas),
			schemas,
			path,
		);
	}

	const annotations: JsonSchemaValueAnnotation[] = [];
	const generate = schema.$generate;
	if (generate !== undefined) {
		if (!isObject(generate) || generate.function !== "uuid") {
			throw new Error(`Unsupported schema generator at ${path || "root"}`);
		}
		const length = generate.length;
		if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 32) {
			throw new Error(`UUID length must be an integer between 1 and 32 at ${path}`);
		}
		const prefix = generate.prefix ?? "";
		if (typeof prefix !== "string") {
			throw new Error(`UUID prefix must be a string at ${path}`);
		}
		annotations.push({
			path,
			kind: "generate",
			generator: "uuid",
			length,
			prefix,
		});
	}

	const normalize = schema.$normalize;
	if (normalize !== undefined) {
		if (
			!Array.isArray(normalize) ||
			!normalize.every((step) =>
				["trim", "remove-empty", "unique"].includes(step as string),
			)
		) {
			throw new Error(`Invalid normalize annotation at ${path || "root"}`);
		}
		annotations.push({
			path,
			kind: "normalize",
			steps: normalize as Array<"trim" | "remove-empty" | "unique">,
		});
	}

	const properties = isObject(schema.properties) ? schema.properties : {};
	for (const [key, child] of Object.entries(properties)) {
		annotations.push(
			...normalizeValueAnnotations(
				child,
				schemas,
				path ? `${path}.${key}` : key,
			),
		);
	}
	if (schema.items !== undefined) {
		annotations.push(
			...normalizeValueAnnotations(schema.items, schemas, `${path}[]`),
		);
	}
	return annotations;
};

const jsonTypeOf = (value: unknown) => {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	if (Number.isInteger(value)) {
		return "integer";
	}
	return typeof value === "object" ? "object" : typeof value;
};

const isJsonType = (value: unknown, type: unknown) => {
	const types = Array.isArray(type) ? type : [type];
	const valueType = jsonTypeOf(value);
	return types.some(
		(item) =>
			item === valueType ||
			(item === "number" &&
				(valueType === "number" || valueType === "integer")),
	);
};

const validateJsonSchemaValue = (
	schema: unknown,
	value: unknown,
	path = "/",
): string[] => {
	if (!isObject(schema)) {
		return [];
	}
	if (Array.isArray(schema.allOf)) {
		return schema.allOf.flatMap((item) =>
			validateJsonSchemaValue(item, value, path),
		);
	}
	if (Array.isArray(schema.anyOf)) {
		const failures = schema.anyOf.map((item) =>
			validateJsonSchemaValue(item, value, path),
		);
		return failures.some((errors) => errors.length === 0)
			? []
			: [`${path} must match at least one schema`];
	}
	if ("const" in schema && value !== schema.const) {
		return [`${path} must be ${JSON.stringify(schema.const)}`];
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		return [`${path} must be one of ${schema.enum.map(String).join(", ")}`];
	}
	if (schema.type !== undefined && !isJsonType(value, schema.type)) {
		return [`${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : String(schema.type)}`];
	}

	const errors: string[] = [];
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			errors.push(`${path} must be >= ${schema.minimum}`);
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			errors.push(`${path} must be <= ${schema.maximum}`);
		}
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			errors.push(`${path} length must be >= ${schema.minLength}`);
		}
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			errors.push(`${path} must contain at least ${schema.minItems} items`);
		}
		if (schema.items !== undefined) {
			value.forEach((item, index) => {
				errors.push(
					...validateJsonSchemaValue(schema.items, item, `${path}/${index}`),
				);
			});
		}
	}
	if (isObject(value)) {
		const required = Array.isArray(schema.required) ? schema.required : [];
		for (const key of required) {
			if (typeof key === "string" && !(key in value)) {
				errors.push(`${path}/${key} is required`);
			}
		}
		const properties = isObject(schema.properties) ? schema.properties : {};
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (key in value) {
				errors.push(
					...validateJsonSchemaValue(
						propertySchema,
						value[key],
						`${path}/${key}`,
					),
				);
			}
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!(key in properties)) {
					errors.push(`${path}/${key} is not allowed`);
				}
			}
		}
	}

	return errors;
};

const validateAgainstJsonSchema = (schema: JsonSchemaObject, value: unknown) => {
	const errors = validateJsonSchemaValue(schema, value);
	if (errors.length > 0) {
		throw new Error(`JSON Schema validation failed: ${errors.join("; ")}`);
	}
};

const normalizePathOfSchema = (input: {
	schema: unknown;
	schemas: Record<string, JsonSchemaObject>;
	path: string;
}): {
	schema: unknown;
	artifactAnnotations: JsonSchemaArtifactAnnotation[];
	valueAnnotations: JsonSchemaValueAnnotation[];
} => {
	if (!isObject(input.schema)) {
	return {
		schema: input.schema,
		artifactAnnotations: [],
		valueAnnotations: [],
	};
	}

	const pathOf = input.schema[PATH_OF_KEY];
	if (typeof pathOf === "string") {
		const artifactSchemaSource = resolveInternalSchemaRef(pathOf, input.schemas);
		const artifactSchema = normalizeJsonSchema({
			schema: artifactSchemaSource,
			schemas: input.schemas,
			path: "artifact",
		});
		return {
			schema: {
				type: "string",
				...Object.fromEntries(
					Object.entries(input.schema).filter(
						([key]) => key !== PATH_OF_KEY && key !== "type",
					),
				),
			},
			artifactAnnotations: [
				{
					path: input.path,
					kind: input.path.endsWith("[]") ? "path_list" : "path",
					jsonSchema: cloneJson(artifactSchema.schema) as JsonSchemaObject,
					valueAnnotations: normalizeValueAnnotations(
						artifactSchemaSource,
						input.schemas,
					),
					artifactAnnotations: artifactSchema.artifactAnnotations,
				},
			],
			valueAnnotations: [],
		};
	}

	const nextSchema: Record<string, unknown> = {};
	const annotations: JsonSchemaArtifactAnnotation[] = [];
	for (const [key, value] of Object.entries(input.schema)) {
		if (key === "$generate" || key === "$normalize") {
			continue;
		}
		if (key === "properties" && isObject(value)) {
			const properties: Record<string, unknown> = {};
			for (const [propertyName, propertySchema] of Object.entries(value)) {
				const normalized = normalizeJsonSchema({
					schema: propertySchema,
					schemas: input.schemas,
					path: `${input.path}.${propertyName}`,
				});
				properties[propertyName] = normalized.schema;
				annotations.push(...normalized.artifactAnnotations);
			}
			nextSchema[key] = properties;
			continue;
		}
		if (key === "items") {
			const normalized = normalizeJsonSchema({
				schema: value,
				schemas: input.schemas,
				path: `${input.path}[]`,
			});
			nextSchema[key] = normalized.schema;
			annotations.push(...normalized.artifactAnnotations);
			continue;
		}
		if (Array.isArray(value)) {
			nextSchema[key] = value.map((item) => {
				const normalized = normalizeJsonSchema({
					schema: item,
					schemas: input.schemas,
					path: input.path,
				});
				annotations.push(...normalized.artifactAnnotations);
				return normalized.schema;
			});
			continue;
		}
		if (isObject(value)) {
			const normalized = normalizeJsonSchema({
				schema: value,
				schemas: input.schemas,
				path: input.path,
			});
			nextSchema[key] = normalized.schema;
			annotations.push(...normalized.artifactAnnotations);
			continue;
		}
		nextSchema[key] = value;
	}

	return {
		schema: nextSchema,
		artifactAnnotations: annotations,
		valueAnnotations: normalizeValueAnnotations(
			input.schema,
			input.schemas,
			input.path,
		),
	};
};

export const createJsonSchemaContract = (input: {
	schemas: Record<string, JsonSchemaObject>;
	schema: JsonSchemaObject;
}): JsonSchemaContract => {
	const normalized = normalizeJsonSchema({
		schema: input.schema,
		schemas: input.schemas,
		path: "output",
	});
	if (!isObject(normalized.schema)) {
		throw new Error("JSON Schema contract must normalize to an object schema");
	}
	const schema = normalized.schema;
	return {
		kind: "json-schema",
		schema,
		artifactAnnotations: normalized.artifactAnnotations,
		valueAnnotations: normalized.valueAnnotations,
		validate: (value) => validateAgainstJsonSchema(schema, value),
	};
};

export const getJsonSchemaArtifactAnnotations = (
	contract: JsonSchemaContract,
) => {
	const flatten = (
		annotations: readonly JsonSchemaArtifactAnnotation[],
	): JsonSchemaArtifactAnnotation[] =>
		annotations.flatMap((annotation) => [
			annotation,
			...flatten(annotation.artifactAnnotations),
		]);
	return flatten(contract.artifactAnnotations);
};

export const getJsonSchemaValueAnnotations = (
	contract: JsonSchemaContract,
) => contract.valueAnnotations;

export const validateJsonSchemaContract = (
	contract: JsonSchemaContract,
	value: unknown,
) => contract.validate(value);

const readOutputPath = (value: unknown, annotationPath: string) => {
	const path = annotationPath.replace(/^(?:output|artifact)\.?/, "");
	if (!path) {
		return value;
	}
	let current = value;
	for (const part of path.split(".")) {
		if (!part) {
			continue;
		}
		const isArray = part.endsWith("[]");
		const key = isArray ? part.slice(0, -2) : part;
		if (!isObject(current)) {
			throw new Error(`${annotationPath} parent is not an object`);
		}
		current = current[key];
		if (isArray) {
			if (!Array.isArray(current)) {
				throw new Error(`${annotationPath} must be an array of artifact paths`);
			}
			return current;
		}
	}
	return current;
};

export const validateJsonSchemaContractArtifacts = async (
	contract: JsonSchemaContract,
	value: unknown,
	readArtifactJson: (artifactPath: string) => Promise<unknown>,
) => {
	const validateAnnotations = async (
		annotations: readonly JsonSchemaArtifactAnnotation[],
		rootValue: unknown,
	): Promise<void> => {
		for (const annotation of annotations) {
			const artifactPaths = readOutputPath(rootValue, annotation.path);
			const paths =
				annotation.kind === "path_list" ? artifactPaths : [artifactPaths];
			if (!Array.isArray(paths)) {
				throw new Error(`${annotation.path} must be an array of artifact paths`);
			}
			for (const artifactPath of paths) {
				if (typeof artifactPath !== "string" || artifactPath.length === 0) {
					throw new Error(
						`${annotation.path} must contain artifact path strings`,
					);
				}
				const artifactJson = await readArtifactJson(artifactPath);
				try {
					validateAgainstJsonSchema(annotation.jsonSchema, artifactJson);
				} catch (error) {
					throw new Error(
						`${annotation.path} artifact ${artifactPath} ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				await validateAnnotations(
					annotation.artifactAnnotations,
					artifactJson,
				);
			}
		}
	};

	await validateAnnotations(contract.artifactAnnotations, value);
};

export const validateStructuredOutputSchemaSource = <T = unknown>(
	schema: StructuredOutputSchemaSource,
	value: unknown,
): T => {
	if (isJsonSchemaContract(schema)) {
		validateJsonSchemaContract(schema, value);
		return value as T;
	}
	return schema.parse(value) as T;
};

export const isJsonSchemaContract = (
	value: unknown,
): value is JsonSchemaContract =>
	isObject(value) && value.kind === "json-schema" && isObject(value.schema);
