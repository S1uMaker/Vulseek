import { schemaIdFromPointer, schemaPointer } from "./definition-helpers";

/**
 * Form-mode mapping for the schema workbench. JSON Schema `type` is shown as
 * itself; `$pathOf: "#/schemas/<id>"` is a distinct UI type `path` so the
 * form never serializes those properties as `type: string`.
 */

export const SCHEMA_TYPES = [
	{ value: "object", label: "object" },
	{ value: "array", label: "array" },
	{ value: "string", label: "string" },
	{ value: "number", label: "number" },
	{ value: "integer", label: "integer" },
	{ value: "boolean", label: "boolean" },
	{ value: "null", label: "null" },
] as const;

export const PROPERTY_TYPES = [
	...SCHEMA_TYPES,
	{ value: "path", label: "path" },
	{ value: "reference", label: "schema reference" },
] as const;

export const PATH_PROPERTY_TYPE = "path";
export const REFERENCE_PROPERTY_TYPE = "reference";

export type SchemaPropertyDraft = {
	name: string;
	originalName: string;
	type: string;
	description: string;
	enumValues: unknown[];
	/** Document schema id referenced by `$pathOf`, or empty if unset. */
	pathOf: string;
	/** Document schema id referenced by `$ref`, or empty if unset. */
	ref: string;
};

export type SchemaFormState = {
	type: string;
	title: string;
	description: string;
	properties: SchemaPropertyDraft[];
	required: string[];
	itemsType: string;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const propertyTypeFromSchema = (property: Record<string, unknown>): string => {
	if (typeof property.$ref === "string" && property.$ref.length > 0) {
		return REFERENCE_PROPERTY_TYPE;
	}
	if (typeof property.$pathOf === "string" && property.$pathOf.length > 0) {
		return PATH_PROPERTY_TYPE;
	}
	return typeof property.type === "string" ? property.type : "string";
};

export const schemaToFormState = (schema: Record<string, unknown>): SchemaFormState => {
	const properties = (schema.properties as Record<string, unknown>) ?? {};
	return {
		type: typeof schema.type === "string" ? schema.type : "object",
		title: typeof schema.title === "string" ? schema.title : "",
		description: typeof schema.description === "string" ? schema.description : "",
		properties: Object.entries(properties).map(([name, value]) => {
			const property = (value ?? {}) as Record<string, unknown>;
			return {
				name,
				originalName: name,
				type: propertyTypeFromSchema(property),
				description: typeof property.description === "string" ? property.description : "",
				enumValues: Array.isArray(property.enum) ? property.enum : [],
				pathOf: schemaIdFromPointer(property.$pathOf) ?? "",
				ref: schemaIdFromPointer(property.$ref) ?? "",
			};
		}),
		required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
		itemsType:
			typeof (schema.items as Record<string, unknown> | undefined)?.type === "string"
				? ((schema.items as Record<string, unknown>).type as string)
				: "string",
	};
};

const applyPropertyForm = (
	property: SchemaPropertyDraft,
	baseProperty: Record<string, unknown>,
): Record<string, unknown> => {
	const entry: Record<string, unknown> = { ...baseProperty };
	if (property.type === PATH_PROPERTY_TYPE) {
		delete entry.type;
		if (property.pathOf.trim()) {
			entry.$pathOf = schemaPointer(property.pathOf.trim());
		} else if (
			typeof baseProperty.$pathOf === "string" &&
			!schemaIdFromPointer(baseProperty.$pathOf)
		) {
			entry.$pathOf = baseProperty.$pathOf;
		} else {
			delete entry.$pathOf;
		}
	} else if (property.type === REFERENCE_PROPERTY_TYPE) {
		delete entry.type;
		delete entry.$pathOf;
		if (property.ref.trim()) {
			entry.$ref = schemaPointer(property.ref.trim());
		} else if (typeof baseProperty.$ref === "string" && !schemaIdFromPointer(baseProperty.$ref)) {
			entry.$ref = baseProperty.$ref;
		} else {
			delete entry.$ref;
		}
	} else {
		entry.type = property.type;
		delete entry.$pathOf;
		delete entry.$ref;
	}
	if (property.description.trim()) entry.description = property.description;
	else delete entry.description;
	if (property.enumValues.length > 0) entry.enum = property.enumValues;
	else delete entry.enum;
	return entry;
};

export const formStateToSchema = (
	form: SchemaFormState,
	base: Record<string, unknown>,
): Record<string, unknown> => {
	const baseProperties = isRecord(base.properties) ? base.properties : {};
	const properties: Record<string, unknown> = {};
	for (const property of form.properties) {
		if (!property.name.trim()) continue;
		const basePropertyValue = baseProperties[property.originalName];
		const baseProperty = isRecord(basePropertyValue) ? basePropertyValue : {};
		properties[property.name] = applyPropertyForm(property, baseProperty);
	}
	const next: Record<string, unknown> = {
		...base,
		type: form.type,
	};
	if (form.title) next.title = form.title;
	else delete next.title;
	if (form.description) next.description = form.description;
	else delete next.description;
	if (form.type === "object") {
		next.properties = properties;
		next.required = form.required.filter((name) => name in properties);
		delete next.items;
	} else if (form.type === "array") {
		next.items = { type: form.itemsType };
		delete next.properties;
		delete next.required;
	} else {
		delete next.properties;
		delete next.required;
		delete next.items;
	}
	return next;
};

export const emptyPropertyDraft = (name = "newProperty"): SchemaPropertyDraft => ({
	name,
	originalName: "",
	type: "string",
	description: "",
	enumValues: [],
	pathOf: "",
	ref: "",
});
