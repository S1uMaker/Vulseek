import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computePipelineContentHash } from "./pipeline-document-v3-hash";
import {
	normalizePipelineDocumentV3,
	parsePipelineDocumentV3,
	serializePipelineDocumentV3,
} from "./pipeline-document-v3-io";
import type { PipelineDocumentV3 } from "./pipeline-document-v3";
import { convertV2DefinitionsToV3, type PipelineKind } from "./pipeline-v2-converter";
import { resolveScanPipelineDefinitionsDir } from "../scan-pipeline-definitions";

/**
 * Built-in system pipelines.
 *
 * The four V2 pipelines (full / delta / research / tob-goal) are converted
 * once into V3 documents (prompts inlined). Runtime prefers the checked-in
 * `definitions/pipelines-v3/*.yaml` files (same tree for dev and release);
 * otherwise it converts the legacy definitions on the fly. YAML is only
 * seeded into an organization that does not already have the pipeline.
 */

export type BuiltinPipelineTemplate = {
	kind: PipelineKind;
	slug: string;
	name: string;
	yaml: string;
	contentHash: string;
};

export const BUILTIN_DOCUMENT_NAME: Record<PipelineKind, string> = {
	full: "full-scan-programmatic",
	delta: "delta-scan-programmatic",
	research: "security-research-programmatic",
	"tob-goal": "tob-goal-programmatic",
};

const resolvePipelinesV3Dir = (): string | null => {
	try {
		const definitionsDir = resolveScanPipelineDefinitionsDir(import.meta.url);
		const candidate = join(definitionsDir, "pipelines-v3");
		if (existsSync(candidate)) return candidate;
	} catch {
		return null;
	}
	return null;
};

const loadGeneratedTemplate = (kind: PipelineKind): BuiltinPipelineTemplate | null => {
	const dir = resolvePipelinesV3Dir();
	if (!dir) return null;
	const fileName = `${kind}.yaml`;
	const filePath = join(dir, fileName);
	if (!existsSync(filePath)) return null;
	const yaml = readFileSync(filePath, "utf-8");
	const { document } = parsePipelineDocumentV3(yaml);
	if (!document) {
		throw new Error(
			`Generated V3 pipeline file ${filePath} is not a valid V3 document`,
		);
	}
	return {
		kind,
		slug: kind,
		name: BUILTIN_DOCUMENT_NAME[kind],
		yaml: serializePipelineDocumentV3(document),
		contentHash: computePipelineContentHash(document),
	};
};

const buildTemplateFromV2 = (
	kind: PipelineKind,
	document: PipelineDocumentV3,
): BuiltinPipelineTemplate => {
	const canonical = normalizePipelineDocumentV3(document);
	return {
		kind,
		slug: kind,
		name: BUILTIN_DOCUMENT_NAME[kind],
		yaml: serializePipelineDocumentV3(canonical),
		contentHash: computePipelineContentHash(canonical),
	};
};

/**
 * Load the four built-in templates. Prefers the checked-in generated V3 YAML
 * files; falls back to live conversion of the V2 definitions.
 */
export const loadBuiltinPipelineTemplates = (): BuiltinPipelineTemplate[] => {
	const results: BuiltinPipelineTemplate[] = [];
	const fallbacks: Array<[PipelineKind, PipelineDocumentV3]> = [];
	const converted = convertV2DefinitionsToV3();

	for (const kind of ["full", "delta", "research", "tob-goal"] as const) {
		const generated = loadGeneratedTemplate(kind);
		if (generated) {
			results.push(generated);
			continue;
		}
		const document = converted.documents[kind];
		if (document) {
			fallbacks.push([kind, document]);
		}
	}

	if (fallbacks.length > 0 && results.length > 0) {
		throw new Error(
			"Mixed V3 template sources: generated files exist for some pipelines but not all",
		);
	}

	if (fallbacks.length > 0) {
		return fallbacks.map(([kind, document]) => buildTemplateFromV2(kind, document));
	}
	return results;
};

export const loadBuiltinPipelineTemplate = (
	kind: PipelineKind,
): BuiltinPipelineTemplate => {
	const template = loadBuiltinPipelineTemplates().find((item) => item.kind === kind);
	if (!template) {
		throw new Error(`No built-in pipeline template for kind "${kind}"`);
	}
	return template;
};
