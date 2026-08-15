import type {
	PipelineDiagnostic,
	PipelineDocumentV3,
	PipelineEdgeV3,
	PipelineGroupV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { nextUniqueId } from "./pipeline-layout";

/**
 * Pure helpers for the Definition view: entity counts, reference resolution,
 * delete guards, duplicate detection, and entity factories. Everything here
 * is deterministic and unit-testable without React; the workbench components
 * call these to drive lists, navigation, create dialogs, and safe-delete
 * confirmation.
 */

export type DefinitionEntityKind = "stage" | "edge" | "schema" | "group";

export type EntityReference = {
	kind: "stage" | "edge" | "schema" | "group";
	id: string;
	/** Human-readable reason the reference exists (shown in delete dialogs). */
	reason: string;
};

// ---------------------------------------------------------------------------
// Schema visibility
// ---------------------------------------------------------------------------

/**
 * Return the schemas that belong to the current pipeline's contracts.
 * Generated V3 documents can contain the legacy global schema registry, so
 * the editor must follow stage/edge references instead of showing every key.
 * References nested inside a referenced schema are included transitively.
 */
export const relatedSchemaIds = (document: PipelineDocumentV3): string[] => {
	const related = new Set<string>();
	const pending: string[] = [];

	const enqueue = (id: string) => {
		if (!document.schemas[id] || related.has(id)) return;
		related.add(id);
		pending.push(id);
	};

	for (const stage of Object.values(document.stages)) {
		for (const id of schemaRefsForStage(stage)) enqueue(id);
	}
	for (const edge of document.edges) {
		for (const id of schemaRefsForEdge(edge)) enqueue(id);
	}

	while (pending.length > 0) {
		const id = pending.pop()!;
		const refs = new Set<string>();
		collectSchemaRefs(document.schemas[id], refs);
		for (const ref of refs) enqueue(ref);
	}

	const allSchemaIds = Object.keys(document.schemas);
	// A new pipeline may define schemas before wiring its first contract. Keep
	// those schemas editable until the first stage/edge reference exists.
	return related.size > 0 ? allSchemaIds.filter((id) => related.has(id)) : allSchemaIds;
};

/** Hide legacy global-schema unused warnings outside the current pipeline. */
export const filterVisibleSchemaDiagnostics = (
	document: PipelineDocumentV3 | null,
	diagnostics: PipelineDiagnostic[],
): PipelineDiagnostic[] => {
	if (!document) return diagnostics;
	const visibleSchemaIds = new Set(relatedSchemaIds(document));
	return diagnostics.filter(
		(diagnostic) =>
			diagnostic.code !== "schema.unused" ||
			diagnostic.entity?.type !== "schema" ||
			visibleSchemaIds.has(diagnostic.entity.id),
	);
};

export const entityCounts = (
	document: PipelineDocumentV3,
): { stages: number; edges: number; schemas: number; groups: number } => ({
	stages: Object.keys(document.stages).length,
	edges: document.edges.length,
	schemas: relatedSchemaIds(document).length,
	groups: document.groups.length,
});

// ---------------------------------------------------------------------------
// Schema reference walking
// ---------------------------------------------------------------------------

export const SCHEMA_REF_PREFIX = "#/schemas/";

/**
 * Parse `#/schemas/<id>` into `<id>`. Returns null for missing, external, or
 * nested JSON Pointers (`#/schemas/foo/properties/bar`).
 */
export const schemaIdFromPointer = (pointer: unknown): string | null => {
	if (typeof pointer !== "string") return null;
	if (!pointer.startsWith(SCHEMA_REF_PREFIX)) return null;
	const id = pointer.slice(SCHEMA_REF_PREFIX.length);
	return id.length > 0 && !id.includes("/") ? id : null;
};

export const schemaPointer = (id: string): string => `${SCHEMA_REF_PREFIX}${id}`;

/** Collect every `#/schemas/<id>` reference inside a JSON Schema value, including `$ref` and `$pathOf`. */
export const collectSchemaRefs = (value: unknown, out: Set<string>): void => {
	if (typeof value === "string") {
		if (value.startsWith(SCHEMA_REF_PREFIX)) {
			const id = value.slice(SCHEMA_REF_PREFIX.length).split("/")[0];
			if (id) out.add(id);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectSchemaRefs(item, out);
		return;
	}
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) collectSchemaRefs(child, out);
	}
};

/** Schema ids referenced by a stage's input/output schemas. */
export const schemaRefsForStage = (stage: PipelineStageV3): string[] => {
	const refs = new Set<string>();
	for (const schema of [stage.inputSchema, stage.outputSchema]) {
		if (schema) collectSchemaRefs(schema, refs);
	}
	return [...refs];
};

/** Schema ids referenced by an edge's output schema. */
export const schemaRefsForEdge = (edge: PipelineEdgeV3): string[] => {
	const refs = new Set<string>();
	if (edge.outputSchema) collectSchemaRefs(edge.outputSchema, refs);
	return [...refs];
};

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

/** Stages, edges, and groups that reference a stage. */
export const stageReferrers = (
	document: PipelineDocumentV3,
	stageId: string,
): EntityReference[] => {
	const refs: EntityReference[] = [];
	if (document.root === stageId) {
		refs.push({
			kind: "stage",
			id: stageId,
			reason: "This stage is the pipeline root; reassign root before deleting.",
		});
	}
	for (const edge of document.edges) {
		if (edge.from === stageId) {
			refs.push({ kind: "edge", id: edge.id, reason: "Outgoing edge." });
		}
		if (edge.to === stageId) {
			refs.push({ kind: "edge", id: edge.id, reason: "Incoming edge." });
		}
	}
	for (const group of document.groups) {
		if (group.leader === stageId) {
			refs.push({
				kind: "group",
				id: group.id,
				reason: "Group leader.",
			});
		}
	}
	return refs;
};

/** Stages and edges that reference a schema. */
export const schemaReferrers = (
	document: PipelineDocumentV3,
	schemaId: string,
): EntityReference[] => {
	const refs: EntityReference[] = [];
	for (const [stageId, stage] of Object.entries(document.stages)) {
		if (schemaRefsForStage(stage).includes(schemaId)) {
			refs.push({ kind: "stage", id: stageId, reason: "Stage schema reference." });
		}
	}
	for (const edge of document.edges) {
		if (schemaRefsForEdge(edge).includes(schemaId)) {
			refs.push({ kind: "edge", id: edge.id, reason: "Edge output schema reference." });
		}
	}
	for (const [parentSchemaId, schema] of Object.entries(document.schemas)) {
		if (parentSchemaId === schemaId) continue;
		const nestedRefs = new Set<string>();
		collectSchemaRefs(schema, nestedRefs);
		if (nestedRefs.has(schemaId)) {
			refs.push({ kind: "schema", id: parentSchemaId, reason: "Nested schema reference." });
		}
	}
	return refs;
};

/** Stages that belong to a group. */
export const groupReferrers = (
	document: PipelineDocumentV3,
	groupId: string,
): EntityReference[] => {
	const refs: EntityReference[] = [];
	for (const [stageId, stage] of Object.entries(document.stages)) {
		if (stage.group === groupId) {
			refs.push({ kind: "stage", id: stageId, reason: "Stage member." });
		}
	}
	return refs;
};

// ---------------------------------------------------------------------------
// Delete guards and duplicate detection
// ---------------------------------------------------------------------------

const deleteError = (
	code: string,
	message: string,
	kind: DefinitionEntityKind,
	id: string,
): PipelineDiagnostic => ({
	severity: "error",
	code,
	message,
	entity: { type: kind, id },
});

/**
 * Blockers that must be resolved before an entity can be deleted. Deletion
 * never cascades silently: every inbound/outbound reference is listed so the
 * user can remove or rewire it first.
 */
export const deleteBlockers = (
	document: PipelineDocumentV3,
	kind: DefinitionEntityKind,
	id: string,
): PipelineDiagnostic[] => {
	const diagnostics: PipelineDiagnostic[] = [];
	if (kind === "stage") {
		const refs = stageReferrers(document, id);
		for (const ref of refs) {
			diagnostics.push(
				deleteError(
					"delete.stage_referenced",
					`Cannot delete stage "${id}": ${ref.reason}`,
					"stage",
					id,
				),
			);
		}
		return diagnostics;
	}
	if (kind === "schema") {
		const refs = schemaReferrers(document, id);
		for (const ref of refs) {
			diagnostics.push(
				deleteError(
					"delete.schema_referenced",
					`Cannot delete schema "${id}": referenced by ${ref.kind} "${ref.id}" (${ref.reason})`,
					"schema",
					id,
				),
			);
		}
		return diagnostics;
	}
	if (kind === "group") {
		const refs = groupReferrers(document, id);
		for (const ref of refs) {
			diagnostics.push(
				deleteError(
					"delete.group_referenced",
					`Cannot delete group "${id}": stage "${ref.id}" still belongs to it`,
					"group",
					id,
				),
			);
		}
		return diagnostics;
	}
	if (kind === "edge") {
		// Edges have no inbound references; deleting is always safe.
		return diagnostics;
	}
	return diagnostics;
};

export const isDuplicateId = (
	document: PipelineDocumentV3,
	kind: DefinitionEntityKind,
	id: string,
): boolean => {
	if (kind === "stage") return id in document.stages;
	if (kind === "schema") return id in document.schemas;
	if (kind === "edge") return document.edges.some((edge) => edge.id === id);
	return document.groups.some((group) => group.id === id);
};

/** Inline validation for create forms: duplicate ids and slug shape. */
export const duplicateDiagnostics = (
	document: PipelineDocumentV3,
	kind: DefinitionEntityKind,
	id: string,
): PipelineDiagnostic[] => {
	const diagnostics: PipelineDiagnostic[] = [];
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) {
		diagnostics.push({
			severity: "error",
			code: "create.invalid_slug",
			message: "IDs must match ^[a-z][a-z0-9_-]{0,63}$",
			entity: { type: kind, id },
		});
	}
	if (isDuplicateId(document, kind, id)) {
		diagnostics.push({
			severity: "error",
			code: "create.duplicate_id",
			message: `A ${kind} with id "${id}" already exists`,
			entity: { type: kind, id },
		});
	}
	return diagnostics;
};

// ---------------------------------------------------------------------------
// Entity factories
// ---------------------------------------------------------------------------

export const createStageDraft = (
	id: string,
	group = "default",
): PipelineStageV3 => ({
	name: id,
	role: "scan",
	group,
	concurrency: 1,
	disableable: true,
	goal: false,
	runtime: {
		kind: "agent",
		prompt: "Describe what this stage does.",
		prepareRepository: "none",
		includePolicy: false,
		plugins: [],
	},
	inputArtifacts: [],
	outputArtifacts: [],
	jobOutput: false,
	effects: [],
	containerNameParts: [],
	allowAgentExit: false,
	promptValues: {},
});

export const createEdgeDraft = (
	id: string,
	from: string,
	to: string,
	existing: ReadonlySet<string>,
): PipelineEdgeV3 => ({
	id: nextUniqueId(id, existing),
	name: nextUniqueId(id, existing),
	from,
	to,
	fork: false,
	mode: "map",
	artifacts: [],
});

export const createGroupDraft = (
	id: string,
	leader: string,
	existing: ReadonlySet<string>,
): PipelineGroupV3 => ({
	id: nextUniqueId(id, existing),
	name: id,
	leader,
	members: [leader],
});

/** Diagnostics for one entity, used for badges and inline errors. */
export const diagnosticsForEntity = (
	diagnostics: PipelineDiagnostic[],
	kind: DefinitionEntityKind,
	id: string,
): PipelineDiagnostic[] =>
	diagnostics.filter(
		(diagnostic) => diagnostic.entity?.type === kind && diagnostic.entity.id === id,
	);
