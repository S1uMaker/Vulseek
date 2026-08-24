import { describe, expect, it } from "vitest";
import {
	formStateToSchema,
	propertyTypeFromSchema,
	REFERENCE_PROPERTY_TYPE,
	schemaToFormState,
} from "@/lib/pipeline-editor/schema-form";

const PATH_SCHEMA: Record<string, unknown> = {
	type: "object",
	title: "Intake",
	required: ["modulePath"],
	properties: {
		modulePath: {
			$pathOf: "#/schemas/module",
			description: "Module artifact path",
			"x-keep": "preserve-path",
		},
		note: {
			type: "string",
			description: "Optional note",
		},
		scanJob: {
			$ref: "#/schemas/scan-job",
		},
		status: {
			anyOf: [{ type: "string" }, { type: "null" }],
		},
	},
};

describe("propertyTypeFromSchema", () => {
	it("maps $pathOf to path even when type is missing or string", () => {
		expect(propertyTypeFromSchema({ $pathOf: "#/schemas/module" })).toBe("path");
		expect(propertyTypeFromSchema({ type: "string", $pathOf: "#/schemas/module" })).toBe("path");
		expect(propertyTypeFromSchema({ type: "string" })).toBe("string");
		expect(propertyTypeFromSchema({})).toBe("string");
		expect(propertyTypeFromSchema({ $ref: "#/schemas/candidate" })).toBe(REFERENCE_PROPERTY_TYPE);
	});
});

describe("schema form $pathOf round-trip", () => {
	it("reads $pathOf properties as type path with the referenced schema id", () => {
		const form = schemaToFormState(PATH_SCHEMA);
		const modulePath = form.properties.find((property) => property.name === "modulePath");
		expect(modulePath).toMatchObject({
			type: "path",
			pathOf: "module",
			description: "Module artifact path",
		});
		expect(form.properties.find((property) => property.name === "note")?.type).toBe("string");
	});

	it("writes path properties as $pathOf without smashing type: string", () => {
		const next = formStateToSchema(schemaToFormState(PATH_SCHEMA), PATH_SCHEMA);
		const modulePath = (next.properties as Record<string, Record<string, unknown>>).modulePath;
		expect(modulePath).toMatchObject({
			$pathOf: "#/schemas/module",
			description: "Module artifact path",
			"x-keep": "preserve-path",
		});
		expect(modulePath).not.toHaveProperty("type");
		expect(next.properties).toMatchObject({
			note: { type: "string", description: "Optional note" },
			scanJob: { $ref: "#/schemas/scan-job" },
			status: { anyOf: [{ type: "string" }, { type: "null" }] },
		});
		expect(next.required).toEqual(["modulePath"]);
	});

	it("removes $pathOf when the type changes away from path", () => {
		const form = schemaToFormState(PATH_SCHEMA);
		form.properties = form.properties.map((property) =>
			property.name === "modulePath" ? { ...property, type: "string", pathOf: "module" } : property,
		);
		const next = formStateToSchema(form, PATH_SCHEMA);
		const modulePath = (next.properties as Record<string, Record<string, unknown>>).modulePath;
		expect(modulePath).toMatchObject({
			type: "string",
			description: "Module artifact path",
			"x-keep": "preserve-path",
		});
		expect(modulePath).not.toHaveProperty("$pathOf");
	});

	it("sets $pathOf when the type changes to path", () => {
		const form = schemaToFormState(PATH_SCHEMA);
		form.properties = form.properties.map((property) =>
			property.name === "note" ? { ...property, type: "path", pathOf: "finding" } : property,
		);
		const next = formStateToSchema(form, PATH_SCHEMA);
		const note = (next.properties as Record<string, Record<string, unknown>>).note;
		expect(note).toMatchObject({
			$pathOf: "#/schemas/finding",
			description: "Optional note",
		});
		expect(note).not.toHaveProperty("type");
	});

	it("updates the $pathOf target when the referenced schema changes", () => {
		const form = schemaToFormState(PATH_SCHEMA);
		form.properties = form.properties.map((property) =>
			property.name === "modulePath" ? { ...property, pathOf: "candidate" } : property,
		);
		const next = formStateToSchema(form, PATH_SCHEMA);
		expect(next.properties).toMatchObject({
			modulePath: { $pathOf: "#/schemas/candidate", "x-keep": "preserve-path" },
		});
	});

	it("preserves an unparseable $pathOf pointer until a schema is picked", () => {
		const base = {
			type: "object",
			properties: {
				report: { $pathOf: "file://local-schema" },
			},
		};
		const form = schemaToFormState(base);
		expect(form.properties[0]).toMatchObject({ type: "path", pathOf: "" });
		const next = formStateToSchema(form, base);
		expect(next.properties).toMatchObject({
			report: { $pathOf: "file://local-schema" },
		});
	});

	it("round-trips local schema references without converting them to strings", () => {
		const base = {
			type: "object",
			properties: {
				candidate: {
					$ref: "#/schemas/candidate",
					description: "Candidate output",
					"x-keep": "reference",
				},
			},
		};
		const form = schemaToFormState(base);
		expect(form.properties[0]).toMatchObject({
			type: REFERENCE_PROPERTY_TYPE,
			ref: "candidate",
			description: "Candidate output",
		});

		const next = formStateToSchema(form, base);
		expect(next.properties).toMatchObject({
			candidate: {
				$ref: "#/schemas/candidate",
				description: "Candidate output",
				"x-keep": "reference",
			},
		});
		expect((next.properties as Record<string, Record<string, unknown>>).candidate).not.toHaveProperty("type");
	});

	it("preserves an external schema reference until it is replaced", () => {
		const base = {
			type: "object",
			properties: {
				payload: { $ref: "https://example.com/schema.json" },
			},
		};
		const form = schemaToFormState(base);
		const next = formStateToSchema(form, base);
		expect(next.properties).toMatchObject({ payload: { $ref: "https://example.com/schema.json" } });
	});
});
