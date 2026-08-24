import * as React from "react";
import type {
	PipelineDiagnostic,
	PipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	collectSchemaRefs,
	deleteBlockers,
	schemaReferrers,
} from "@/lib/pipeline-editor/definition-helpers";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import {
	emptyPropertyDraft,
	formStateToSchema,
	isRecord,
	PATH_PROPERTY_TYPE,
	PROPERTY_TYPES,
	REFERENCE_PROPERTY_TYPE,
	SCHEMA_TYPES,
	schemaToFormState,
} from "@/lib/pipeline-editor/schema-form";
import { cn } from "@/lib/utils";
import {
	EntityDiagnostics,
	JsonField,
	PathOfReferenceField,
	SectionHeading,
	SelectField,
	TextField,
	TextAreaField,
} from "./workbench-fields";

/**
 * Schema editor: a bounded Form mode for common JSON Schema properties and
 * an unrestricted JSON Schema mode. "Used by" lists referencing stages and
 * edges; "References" lists schemas this schema points at (`$ref` / `$pathOf`).
 * Selecting either navigates directly to the entity. Arbitrary recursive JSON
 * Schema stays in JSON mode — a generated form would mislead.
 */

export type SchemaEditorProps = {
	schemaId: string;
	schema: Record<string, unknown>;
	document: PipelineDocumentV3;
	diagnostics: PipelineDiagnostic[];
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
	onSelect: (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => void;
};

export const SchemaEditor = ({
	schemaId,
	schema,
	document,
	diagnostics,
	dispatch,
	readOnly,
	onSelect,
}: SchemaEditorProps) => {
	const [mode, setMode] = React.useState<"form" | "json">("form");
	const [form, setForm] = React.useState(() => schemaToFormState(schema));
	React.useEffect(() => setForm(schemaToFormState(schema)), [schema]);

	const setSchema = (next: Record<string, unknown>, key: string) =>
		dispatch({ type: "patch", ops: [{ op: "setSchema", schemaId, schema: next }], key });

	const setPropertyDescription = (index: number, description: string) => {
		const property = form.properties[index];
		if (!property) return;
		setForm({
			...form,
			properties: form.properties.map((item, itemIndex) =>
				itemIndex === index ? { ...item, description } : item,
			),
		});

		const schemaProperties = isRecord(schema.properties) ? schema.properties : {};
		const currentProperty = schemaProperties[property.name];
		if (!isRecord(currentProperty)) return;
		const nextProperty = { ...currentProperty };
		if (description.trim()) nextProperty.description = description;
		else delete nextProperty.description;
		setSchema(
			{ ...schema, properties: { ...schemaProperties, [property.name]: nextProperty } },
			`schema:${schemaId}:prop-description:${property.name}`,
		);
	};

	const schemaIds = Object.keys(document.schemas);
	const defaultPathOf = schemaIds.find((id) => id !== schemaId) ?? schemaIds[0] ?? "";
	const usedBy = schemaReferrers(document, schemaId);
	const references = React.useMemo(() => {
		const refs = new Set<string>();
		collectSchemaRefs(schema, refs);
		return [...refs].filter((id) => id !== schemaId);
	}, [schema, schemaId]);
	const blockers = deleteBlockers(document, "schema", schemaId);
	const advanced = Object.keys(schema).some(
		(key) =>
			!["type", "title", "description", "properties", "required", "items", "enum", "$pathOf"].includes(
				key,
			),
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<SectionHeading
				title={schemaId}
				subtitle={`JSON Schema · used by ${usedBy.length} · references ${references.length}`}
				actions={
					<div className="flex items-center gap-1 rounded-md border p-0.5 text-xs">
						{(["form", "json"] as const).map((item) => (
							<button
								key={item}
								type="button"
								onClick={() => setMode(item)}
								className={cn(
									"rounded px-2 py-0.5",
									mode === item ? "bg-primary text-primary-foreground" : "text-muted-foreground",
								)}
							>
								{item === "form" ? "Form" : "JSON Schema"}
							</button>
						))}
					</div>
				}
			/>
			<EntityDiagnostics diagnostics={diagnostics} />
			<div className="min-h-0 flex-1 overflow-y-auto p-4 pb-12">
				{mode === "json" ? (
					<JsonField
						label="JSON Schema"
						value={schema}
						readOnly={readOnly}
						rows={18}
						onChange={(next) => setSchema((next as Record<string, unknown>) ?? {}, `schema:${schemaId}:json`)}
					/>
				) : (
					<div className="space-y-4">
						{advanced ? (
							<p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
								This schema has advanced properties edited in JSON mode; the form preserves them.
							</p>
						) : null}
						<SelectField
							label="Type"
							value={form.type}
							options={SCHEMA_TYPES}
							readOnly={readOnly}
							onChange={(type) => {
								const next = { ...form, type };
								setForm(next);
								setSchema(formStateToSchema(next, schema), `schema:${schemaId}:type`);
							}}
						/>
						<TextField
							label="Title"
							value={form.title}
							readOnly={readOnly}
							onChange={(title) => {
								const next = { ...form, title };
								setForm(next);
								setSchema(formStateToSchema(next, schema), `schema:${schemaId}:title`);
							}}
						/>
						<TextAreaField
							label="Description"
							value={form.description}
							rows={2}
							readOnly={readOnly}
							onChange={(description) => {
								const next = { ...form, description };
								setForm(next);
								setSchema(formStateToSchema(next, schema), `schema:${schemaId}:description`);
							}}
						/>
						{form.type === "object" ? (
							<>
								<div className="space-y-2">
									<p className="text-xs font-medium text-foreground">Properties</p>
									{form.properties.map((property, index) => (
										<div key={property.name || index} className="space-y-1 rounded-md border p-2">
											<input
												value={property.name}
												disabled={readOnly}
												placeholder="property name"
												onChange={(event) => {
													const properties = form.properties.map((p, i) =>
														i === index ? { ...p, name: event.target.value } : p,
													);
													const next = { ...form, properties };
													setForm(next);
													setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
												}}
												className="h-8 w-full rounded-md border bg-background px-2 text-xs"
											/>
											<TextAreaField
												label="Description (optional)"
												value={property.description}
												rows={2}
												readOnly={readOnly}
												placeholder="Describe this field"
												onChange={(description) => setPropertyDescription(index, description)}
											/>
											<div className="grid grid-cols-2 gap-2">
												<select
													value={property.type}
													disabled={readOnly}
													aria-label={`Type for ${property.name || "property"}`}
													onChange={(event) => {
														const type = event.target.value;
														const properties = form.properties.map((p, i) => {
															if (i !== index) return p;
															if (type === PATH_PROPERTY_TYPE) {
																return { ...p, type, pathOf: p.pathOf || defaultPathOf };
															}
															if (type === REFERENCE_PROPERTY_TYPE) {
																return { ...p, type, ref: p.ref || defaultPathOf };
															}
															return { ...p, type };
														});
														const next = { ...form, properties };
														setForm(next);
														setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
													}}
													className="h-8 rounded-md border bg-background px-2 text-xs"
												>
													{PROPERTY_TYPES.map((option) => (
														<option key={option.value} value={option.value}>
															{option.label}
														</option>
													))}
												</select>
												<button
													type="button"
													disabled={readOnly}
													onClick={() => {
														const properties = form.properties.filter((_, i) => i !== index);
														const required = form.required.filter((name) => name !== property.name);
														const next = { ...form, properties, required };
														setForm(next);
														setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
													}}
													className="h-8 rounded-md border border-red-500/30 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-40"
												>
													Remove
												</button>
											</div>
											{property.type === PATH_PROPERTY_TYPE ? (
												<PathOfReferenceField
													label="Path schema"
													value={property.pathOf}
													schemaIds={schemaIds}
													readOnly={readOnly}
													description="Task artifact path whose file content matches this schema."
													onNavigateToSchema={(id) => onSelect({ type: "schema", id })}
													onChange={(pathOf) => {
														const properties = form.properties.map((p, i) =>
															i === index ? { ...p, pathOf } : p,
														);
														const next = { ...form, properties };
														setForm(next);
														setSchema(
															formStateToSchema(next, schema),
															`schema:${schemaId}:props`,
														);
													}}
												/>
											) : null}
											{property.type === REFERENCE_PROPERTY_TYPE ? (
												<PathOfReferenceField
													label="Schema reference"
													value={property.ref}
													schemaIds={schemaIds.filter((id) => id !== schemaId)}
													readOnly={readOnly}
													description="Referenced JSON Schema for this field."
													onNavigateToSchema={(id) => onSelect({ type: "schema", id })}
													onChange={(ref) => {
														const properties = form.properties.map((p, i) =>
															i === index ? { ...p, ref } : p,
														);
														const next = { ...form, properties };
														setForm(next);
														setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
													}}
												/>
											) : null}
										</div>
									))}
									{!readOnly ? (
										<button
											type="button"
											onClick={() => {
												const next = {
													...form,
													properties: [...form.properties, emptyPropertyDraft()],
												};
												setForm(next);
												setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
											}}
											className="rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
										>
											Add property
										</button>
									) : null}
								</div>
								<div className="space-y-1">
									<p className="text-xs font-medium text-foreground">Required</p>
									<div className="flex flex-wrap gap-1.5">
										{form.properties.map((property) => {
											const checked = form.required.includes(property.name);
											return (
												<label
													key={property.name || property.type}
													className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
												>
													<input
														type="checkbox"
														checked={checked}
														disabled={readOnly || !property.name}
														onChange={(event) => {
															const required = event.target.checked
																? [...form.required, property.name]
																: form.required.filter((name) => name !== property.name);
															const next = { ...form, required };
															setForm(next);
															setSchema(formStateToSchema(next, schema), `schema:${schemaId}:required`);
														}}
													/>
													{property.name || "(unnamed)"}
												</label>
											);
										})}
									</div>
								</div>
							</>
						) : null}
						{form.type === "array" ? (
							<SelectField
								label="Items type"
								value={form.itemsType}
								options={SCHEMA_TYPES.filter((option) => option.value !== "array")}
								readOnly={readOnly}
								onChange={(itemsType) => {
									const next = { ...form, itemsType };
									setForm(next);
									setSchema(formStateToSchema(next, schema), `schema:${schemaId}:items`);
								}}
							/>
						) : null}
					</div>
				)}

				<div className="mt-6 grid grid-cols-2 gap-4">
					<div className="rounded-md border bg-muted/30 p-3">
						<p className="text-xs font-semibold text-foreground">Used by</p>
						{usedBy.length === 0 ? (
							<p className="mt-1 text-xs text-muted-foreground">No references — the schema is unused.</p>
						) : (
							<ul className="mt-1 space-y-1">
								{usedBy.map((reference) => (
									<li key={`${reference.kind}:${reference.id}`}>
										<button
											type="button"
											onClick={() => onSelect({ type: reference.kind as "stage" | "edge", id: reference.id })}
											className="text-xs text-sky-600 hover:underline"
										>
											{reference.kind}: {reference.id}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					<div className="rounded-md border bg-muted/30 p-3">
						<p className="text-xs font-semibold text-foreground">References</p>
						{references.length === 0 ? (
							<p className="mt-1 text-xs text-muted-foreground">No nested $refs or $pathOf.</p>
						) : (
							<ul className="mt-1 space-y-1">
								{references.map((id) => (
									<li key={id}>
										<button
											type="button"
											onClick={() => onSelect({ type: "schema", id })}
											className="text-xs text-sky-600 hover:underline"
										>
											#/schemas/{id}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>

				{!readOnly ? (
					<div className="mt-6 space-y-2">
						{blockers.length > 0 ? (
							<div className="space-y-1 rounded-md border border-red-500/30 bg-red-500/5 p-3">
								<p className="text-xs font-semibold text-red-600">Cannot delete — referenced:</p>
								{blockers.map((blocker, index) => (
									<p key={index} className="text-xs text-red-600">
										{blocker.message}
									</p>
								))}
							</div>
						) : (
							<button
								type="button"
								onClick={() => {
									if (window.confirm(`Delete schema "${schemaId}"?`)) {
										dispatch({ type: "patch", ops: [{ op: "deleteSchema", schemaId }] });
									}
								}}
								className="rounded-md border border-red-500/30 px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/10"
							>
								Delete schema
							</button>
						)}
					</div>
				) : null}
			</div>
		</div>
	);
};
