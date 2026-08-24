import { isMap, isSeq, parseDocument, type Document, type Node, type YAMLSeq } from "yaml";
import type {
	PipelineDocumentV3,
	PipelineEdgeV3,
	PipelineGroupV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { CURRENT_PIPELINE_LAYOUT_VERSION } from "./pipeline-layout";

/**
 * Typed YAML AST patches (Phase 1 / Definition view).
 *
 * Structured edits never round-trip the whole document through stable
 * serialization. Instead they mutate the parsed YAML `Document` in place —
 * resolving array positions by stable entity id at patch time — and
 * re-stringify. Untouched subtrees keep their comments, scalar styles
 * (quoted, flow, block), ordering, anchors, and aliases exactly as the
 * library permits. The touched subtree of each op may be normalized: the
 * workbench warns once before the first structured mutation.
 *
 * The patch layer is deliberately schema-agnostic: applying an op that
 * makes the document V3-invalid is allowed (the editor surfaces the
 * diagnostics and keeps the text), while ops that reference missing
 * entities return `{ ok: false }` so callers never corrupt the buffer.
 *
 * `raw` may be an invalid intermediate buffer; patching it fails cleanly
 * and the caller keeps the user's text untouched.
 */

export type PipelineYamlPatchOp =
	| { op: "updateStage"; stageId: string; stage: PipelineStageV3 }
	| { op: "addStage"; stageId: string; stage: PipelineStageV3 }
	| { op: "deleteStage"; stageId: string }
	| { op: "updateEdge"; edgeId: string; edge: PipelineEdgeV3 }
	| { op: "addEdge"; edge: PipelineEdgeV3 }
	| { op: "deleteEdge"; edgeId: string }
	| { op: "setSchema"; schemaId: string; schema: Record<string, unknown> }
	| { op: "deleteSchema"; schemaId: string }
	| { op: "updateGroup"; groupId: string; group: PipelineGroupV3 }
	| { op: "addGroup"; group: PipelineGroupV3 }
	| { op: "deleteGroup"; groupId: string }
	| {
			op: "updateOverview";
			overview: Partial<
				Pick<
					PipelineDocumentV3,
					"name" | "description" | "supportedTargets" | "root"
				>
			>;
	  }
	| { op: "updateLimits"; limits: { maxTasks: number; maxDurationSeconds: number } }
	| {
			op: "updatePresentation";
			presentation: NonNullable<PipelineDocumentV3["presentation"]>;
	  }
	| { op: "moveNode"; stageId: string; position: { x: number; y: number } }
	| {
			op: "updateLayout";
			layout: {
				direction?: "DOWN" | "RIGHT";
				nodes?: Record<string, { x: number; y: number }>;
				edges?: Record<
					string,
					{
						bendPoints: Array<{ x: number; y: number }>;
						sourceHandle?: string;
						targetHandle?: string;
					}
				>;
			};
	  }
	| { op: "resetLayout" };

export type PatchPipelineYamlResult =
	| { ok: true; yaml: string }
	| { ok: false; error: string };

const deepEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return a === b;
	if (Array.isArray(a) && Array.isArray(b)) {
		return (
			a.length === b.length &&
			a.every((item, index) => deepEqual(item, b[index]))
		);
	}
	if (typeof a === "object" && typeof b === "object") {
		const aRecord = a as Record<string, unknown>;
		const bRecord = b as Record<string, unknown>;
		const aKeys = Object.keys(aRecord);
		const bKeys = Object.keys(bRecord);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
	}
	return false;
};

/** Locate a seq item by its stable `id` scalar; returns the index or -1. */
const findSeqIndexById = (seq: YAMLSeq, id: string): number =>
	seq.items.findIndex((item) => {
		if (!isMap(item)) return false;
		const value = item.get("id", true)?.value;
		return value === id;
	});

/**
 * Set `path` to `value` unless the existing node already carries the same
 * semantic value. Skipping identical writes keeps untouched text byte-for-
 * byte intact (quoted scalars, flow style, comments) instead of re-rendering
 * the subtree.
 */
const setIfChanged = (
	doc: Document.Parsed,
	path: (string | number)[],
	value: unknown,
): void => {
	const current = doc.getIn(path, true) as Node | undefined;
	if (current !== undefined) {
		try {
			if (deepEqual(current.toJS(doc), value)) return;
		} catch {
			// toJS can throw on cyclic values; fall through to the write.
		}
	}
	doc.setIn(path, doc.createNode(value));
};

/**
 * Apply one patch op to a parsed YAML document. Mutates `doc` in place.
 * Throws `Error` when an op references a missing entity or an expected
 * collection is absent — the caller converts this into `{ ok: false }`.
 */
const applyOp = (doc: Document.Parsed, op: PipelineYamlPatchOp): void => {
	const requireStage = (stageId: string): void => {
		if (doc.getIn(["stages", stageId], true) === undefined) {
			throw new Error(`no such stage: ${stageId}`);
		}
	};
	const requireEdgeSeq = (): YAMLSeq => {
		const seq = doc.getIn(["edges"], true);
		if (seq === undefined) {
			throw new Error("document has no edges list");
		}
		if (!isSeq(seq)) {
			throw new Error("document edges is not a list");
		}
		return seq;
	};
	const requireGroupSeq = (): YAMLSeq => {
		const seq = doc.getIn(["groups"], true);
		if (seq === undefined) {
			throw new Error("document has no groups list");
		}
		if (!isSeq(seq)) {
			throw new Error("document groups is not a list");
		}
		return seq;
	};
	const ensureSeq = (key: string): YAMLSeq => {
		const existing = doc.getIn([key], true);
		if (isSeq(existing)) return existing;
		const seq = doc.createNode([]) as YAMLSeq;
		doc.setIn([key], seq);
		return seq;
	};

	switch (op.op) {
		case "updateStage":
			requireStage(op.stageId);
			setIfChanged(doc, ["stages", op.stageId], op.stage);
			return;
		case "addStage":
			if (doc.getIn(["stages", op.stageId], true) !== undefined) {
				throw new Error(`duplicate stage id: ${op.stageId}`);
			}
			doc.setIn(["stages", op.stageId], doc.createNode(op.stage));
			return;
		case "deleteStage": {
			requireStage(op.stageId);
			doc.deleteIn(["stages", op.stageId]);
			return;
		}
		case "updateEdge": {
			const index = findSeqIndexById(requireEdgeSeq(), op.edgeId);
			if (index < 0) throw new Error(`no such edge: ${op.edgeId}`);
			setIfChanged(doc, ["edges", index], op.edge);
			return;
		}
		case "addEdge": {
			const seq = ensureSeq("edges");
			if (findSeqIndexById(seq, op.edge.id) >= 0) {
				throw new Error(`duplicate edge id: ${op.edge.id}`);
			}
			seq.items.push(doc.createNode(op.edge));
			return;
		}
		case "deleteEdge": {
			const seq = requireEdgeSeq();
			const index = findSeqIndexById(seq, op.edgeId);
			if (index < 0) throw new Error(`no such edge: ${op.edgeId}`);
			doc.deleteIn(["edges", index]);
			return;
		}
		case "setSchema":
			setIfChanged(doc, ["schemas", op.schemaId], op.schema);
			return;
		case "deleteSchema": {
			if (doc.getIn(["schemas", op.schemaId], true) === undefined) {
				throw new Error(`no such schema: ${op.schemaId}`);
			}
			doc.deleteIn(["schemas", op.schemaId]);
			return;
		}
		case "updateGroup": {
			const index = findSeqIndexById(requireGroupSeq(), op.groupId);
			if (index < 0) throw new Error(`no such group: ${op.groupId}`);
			setIfChanged(doc, ["groups", index], op.group);
			return;
		}
		case "addGroup": {
			const seq = ensureSeq("groups");
			if (findSeqIndexById(seq, op.group.id) >= 0) {
				throw new Error(`duplicate group id: ${op.group.id}`);
			}
			seq.items.push(doc.createNode(op.group));
			return;
		}
		case "deleteGroup": {
			const seq = requireGroupSeq();
			const index = findSeqIndexById(seq, op.groupId);
			if (index < 0) throw new Error(`no such group: ${op.groupId}`);
			doc.deleteIn(["groups", index]);
			return;
		}
		case "updateOverview": {
			for (const [key, value] of Object.entries(op.overview)) {
				if (value === undefined) continue;
				setIfChanged(doc, [key], value);
			}
			return;
		}
		case "updateLimits":
			setIfChanged(doc, ["limits"], op.limits);
			return;
		case "updatePresentation":
			setIfChanged(doc, ["presentation"], op.presentation);
			return;
		case "moveNode": {
			requireStage(op.stageId);
			setIfChanged(doc, ["ui", "layoutVersion"], CURRENT_PIPELINE_LAYOUT_VERSION);
			setIfChanged(doc, ["ui", "nodes", op.stageId], op.position);
			return;
		}
		case "updateLayout": {
			setIfChanged(doc, ["ui", "layoutVersion"], CURRENT_PIPELINE_LAYOUT_VERSION);
			if (op.layout.direction !== undefined) {
				setIfChanged(doc, ["ui", "direction"], op.layout.direction);
			}
			if (op.layout.nodes !== undefined) {
				setIfChanged(doc, ["ui", "nodes"], op.layout.nodes);
			}
			if (op.layout.edges !== undefined) {
				setIfChanged(doc, ["ui", "edges"], op.layout.edges);
			}
			return;
		}
		case "resetLayout":
			doc.deleteIn(["ui"]);
			return;
	}
};

const parseForPatch = (
	raw: string,
): Document.Parsed | { error: string } => {
	if (raw.trim().length === 0) {
		return { error: "buffer is empty" };
	}
	const doc = parseDocument(raw);
	if (doc.errors.length > 0) {
		return { error: doc.errors.map((error) => error.message).join("; ") };
	}
	if (doc.contents === null) {
		return { error: "buffer is empty" };
	}
	return doc;
};

/**
 * Apply typed patch ops to the raw YAML buffer. Returns the patched text or
 * a clean error when the buffer is not parseable or an op references a
 * missing entity. Applying a patch never throws.
 */
export const patchPipelineYaml = (
	raw: string,
	ops: PipelineYamlPatchOp[],
): PatchPipelineYamlResult => {
	const parsed = parseForPatch(raw);
	if ("error" in parsed) return { ok: false, error: parsed.error };
	const doc = parsed;

	try {
		for (const op of ops) applyOp(doc, op);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const yaml = doc.toString();
	// No-op patch: keep the buffer text (and its history) untouched.
	if (yaml === raw) return { ok: true, yaml };
	return { ok: true, yaml };
};

/** Compare the *semantic* value of a patched buffer against a document. */
export const patchPreservesValue = (
	raw: string,
	expected: unknown,
): boolean => {
	const parsed = parseForPatch(raw);
	if ("error" in parsed) return false;
	try {
		return deepEqual(parsed.toJS(), expected);
	} catch {
		return false;
	}
};