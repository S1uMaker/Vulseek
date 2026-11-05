import { TRPCError } from "@trpc/server";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { db } from "@vulseek/server/db";
import {
	scanJobs,
	scanPipelines,
	scanPipelineVersions,
} from "@vulseek/server/db/schema";
import { nanoid } from "nanoid";
import { computePipelineContentHash } from "../services/scan/pipeline/document-v3/pipeline-document-v3-hash";
import {
	compilePipelineDocumentV3,
	normalizePipelineDocumentV3,
	parsePipelineDocumentV3,
	validatePipelineDocumentV3,
	hasBlockingDiagnostics,
	type PipelineDiagnostic,
	type PipelineDocumentV3,
} from "../services/scan/pipeline/document-v3";

/**
 * Organization-level pipeline service.
 *
 * Permissions: every read/write takes an explicit `organizationId`; rows are
 * always filtered by it. Manager operations (create / save draft / publish /
 * copy / set current / duplicate / archive) are guarded by the router via
 * `isPipelineManager`; this service only enforces org scoping.
 *
 * Draft semantics:
 * - `draftYaml` stores the raw text verbatim; `draftRevision` is the
 *   optimistic-lock counter. Saves compare the expected revision and fail
 *   with a conflict payload when it moved.
 * - Publish accepts either the pending edit buffer (raw YAML) or the stored
 *   draft; it parses, validates, normalizes and inserts an immutable version
 *   in one transaction. Identical content hashes are idempotent.
 */

export type PipelineManagerInput = {
	organizationId: string;
	userId: string | null;
};

const notFound = (message: string): TRPCError =>
	new TRPCError({ code: "NOT_FOUND", message });

export const isPipelineManager = (role: string): boolean =>
	role === "owner" || role === "admin";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const listPipelinesForOrganization = async (
	organizationId: string,
	options: { includeDraft?: boolean } = {},
) => {
	const rows = await db
		.select({
			pipelineId: scanPipelines.pipelineId,
			slug: scanPipelines.slug,
			name: scanPipelines.name,
			description: scanPipelines.description,
			archivedAt: scanPipelines.archivedAt,
			createdAt: scanPipelines.createdAt,
			updatedAt: scanPipelines.updatedAt,
			currentVersionNumber: scanPipelineVersions.versionNumber,
			currentVersionId: scanPipelineVersions.pipelineVersionId,
			draftRevision: scanPipelines.draftRevision,
			hasDraft: sql<boolean>`(${scanPipelines.draftYaml} is not null)`,
		})
		.from(scanPipelines)
		.leftJoin(
			scanPipelineVersions,
			eq(
				scanPipelineVersions.pipelineVersionId,
				scanPipelines.currentPublishedVersionId,
			),
		)
		.where(eq(scanPipelines.organizationId, organizationId))
		.orderBy(desc(scanPipelines.updatedAt));

	if (options.includeDraft) {
		return rows;
	}
	// Members must never see draft state at all — omit the fields.
	return rows.map(({ draftRevision: _draftRevision, hasDraft: _hasDraft, ...rest }) => rest);
};

export const findPipelineForOrganization = async (
	organizationId: string,
	pipelineId: string,
) => {
	const row = await db
		.select()
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.pipelineId, pipelineId),
				eq(scanPipelines.organizationId, organizationId),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!row) {
		throw notFound("Pipeline not found");
	}
	return row;
};

export const getPipelineForOrganization = async (
	organizationId: string,
	pipelineId: string,
	options: { includeDraft?: boolean } = {},
) => {
	const pipeline = await findPipelineForOrganization(organizationId, pipelineId);
	const version = pipeline.currentPublishedVersionId
		? await db
				.select({
					versionNumber: scanPipelineVersions.versionNumber,
					contentHash: scanPipelineVersions.contentHash,
					publishedAt: scanPipelineVersions.publishedAt,
				})
				.from(scanPipelineVersions)
				.where(
					eq(
						scanPipelineVersions.pipelineVersionId,
						pipeline.currentPublishedVersionId,
					),
				)
				.limit(1)
				.then((rows) => rows[0])
		: null;
	return {
		...pipeline,
		currentVersion: version ?? null,
		draftYaml: options.includeDraft ? pipeline.draftYaml : undefined,
	};
};

export const getPipelineVersionForOrganization = async (
	organizationId: string,
	pipelineId: string,
	versionId: string,
) => {
	const version = await db
		.select({
			pipelineVersionId: scanPipelineVersions.pipelineVersionId,
			versionNumber: scanPipelineVersions.versionNumber,
			yaml: scanPipelineVersions.yaml,
			contentHash: scanPipelineVersions.contentHash,
			publishedBy: scanPipelineVersions.publishedBy,
			publishedAt: scanPipelineVersions.publishedAt,
		})
		.from(scanPipelineVersions)
		.innerJoin(
			scanPipelines,
			eq(scanPipelines.pipelineId, scanPipelineVersions.pipelineId),
		)
		.where(
			and(
				eq(scanPipelineVersions.pipelineVersionId, versionId),
				eq(scanPipelines.organizationId, organizationId),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!version) {
		throw notFound("Pipeline version not found");
	}
	return version;
};

export const listPipelineVersionsForOrganization = async (
	organizationId: string,
	pipelineId: string,
) => {
	await findPipelineForOrganization(organizationId, pipelineId);
	return db
		.select({
			pipelineVersionId: scanPipelineVersions.pipelineVersionId,
			versionNumber: scanPipelineVersions.versionNumber,
			contentHash: scanPipelineVersions.contentHash,
			publishedBy: scanPipelineVersions.publishedBy,
			publishedAt: scanPipelineVersions.publishedAt,
		})
		.from(scanPipelineVersions)
		.where(eq(scanPipelineVersions.pipelineId, pipelineId))
		.orderBy(desc(scanPipelineVersions.versionNumber));
};

export const listPublishedPipelineOptions = async (
	organizationId: string,
	targetType: "project" | "evaluation",
) => {
	const rows = await db
		.select({
			pipelineId: scanPipelines.pipelineId,
			slug: scanPipelines.slug,
			name: scanPipelines.name,
			archivedAt: scanPipelines.archivedAt,
			currentVersionNumber: scanPipelineVersions.versionNumber,
			currentVersionId: scanPipelineVersions.pipelineVersionId,
			contentHash: scanPipelineVersions.contentHash,
		})
		.from(scanPipelines)
		.innerJoin(
			scanPipelineVersions,
			eq(
				scanPipelineVersions.pipelineVersionId,
				scanPipelines.currentPublishedVersionId,
			),
		)
		.where(
			and(
				eq(scanPipelines.organizationId, organizationId),
				sql`${scanPipelines.archivedAt} is null`,
			),
		)
		.orderBy(desc(scanPipelines.updatedAt));

	const options = [];
	for (const row of rows) {
		// Parse the current version's document to filter by supportedTargets;
		// a corrupt row simply drops out of the picker.
		const { document } = parsePipelineDocumentV3(
			(
				await getPipelineVersionForOrganization(
					organizationId,
					row.pipelineId,
					row.currentVersionId!,
				)
			).yaml,
		);
		if (document && document.supportedTargets.includes(targetType)) {
			options.push({ ...row, supportedTargets: document.supportedTargets });
		}
	}
	return options;
};

// ---------------------------------------------------------------------------
// Validation (pure — used by the router's validate procedure too)
// ---------------------------------------------------------------------------

export const validatePipelineYaml = (
	yaml: string,
): { diagnostics: PipelineDiagnostic[]; document: PipelineDocumentV3 | null } => {
	const { document, diagnostics } = parsePipelineDocumentV3(yaml);
	if (!document) {
		return { document: null, diagnostics };
	}
	return {
		document,
		diagnostics: [...diagnostics, ...validatePipelineDocumentV3(document)],
	};
};

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const createPipelineForOrganization = async (
	input: PipelineManagerInput & {
		slug: string;
		name: string;
		description?: string | null;
		initialYaml?: string | null;
	},
) => {
	const { organizationId, userId } = input;
	const existing = await db
		.select({ pipelineId: scanPipelines.pipelineId })
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.organizationId, organizationId),
				eq(scanPipelines.slug, input.slug),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (existing) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `A pipeline with slug "${input.slug}" already exists`,
		});
	}

	const pipelineId = nanoid();
	const draftYaml = input.initialYaml ?? null;
	const draftRevision = draftYaml ? 1 : 0;

	const created = await db
		.insert(scanPipelines)
		.values({
			pipelineId,
			organizationId,
			slug: input.slug,
			name: input.name,
			description: input.description ?? null,
			draftYaml,
			draftRevision,
			createdBy: userId,
			updatedBy: userId,
		})
		.returning();
	return created[0]!;
};

/**
 * Save the raw draft text verbatim (comments and layout included). Invalid
 * YAML may be saved as a draft — diagnostics are returned, not errors.
 * Optimistic lock: a mismatched `expectedRevision` returns a conflict with
 * the server-side revision so the client can diff / reload / copy.
 */
export const savePipelineDraftForOrganization = async (
	input: PipelineManagerInput & {
		pipelineId: string;
		expectedRevision: number;
		yaml: string;
	},
) => {
	const { organizationId, pipelineId, userId } = input;
	const updated = await db
		.update(scanPipelines)
		.set({
			draftYaml: input.yaml,
			draftRevision: input.expectedRevision + 1,
			updatedAt: new Date().toISOString(),
			updatedBy: userId,
		})
		.where(
			and(
				eq(scanPipelines.pipelineId, pipelineId),
				eq(scanPipelines.organizationId, organizationId),
				eq(scanPipelines.draftRevision, input.expectedRevision),
			),
		)
		.returning({ pipelineId: scanPipelines.pipelineId });

	if (updated.length === 0) {
		const current = await findPipelineForOrganization(organizationId, pipelineId);
		throw new TRPCError({
			code: "CONFLICT",
			message: "Draft changed on the server",
			cause: { draftRevision: current.draftRevision },
		});
	}

	const diagnostics = validatePipelineYaml(input.yaml).diagnostics;
	return { diagnostics };
};

/**
 * Publish: validate the (possibly unsaved) buffer or stored draft, then in
 * one transaction insert the immutable version, switch `current` and clear
 * the draft. Same contentHash → idempotent (returns the existing version).
 */
export const publishPipelineForOrganization = async (
	input: PipelineManagerInput & {
		pipelineId: string;
		expectedRevision?: number | null;
		yaml?: string | null;
	},
) => {
	const { organizationId, pipelineId, userId } = input;
	const pipeline = await findPipelineForOrganization(organizationId, pipelineId);

	const rawYaml = input.yaml ?? pipeline.draftYaml;
	if (!rawYaml) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Nothing to publish: no draft and no YAML buffer provided",
		});
	}
	if (
		input.expectedRevision != null &&
		pipeline.draftRevision !== input.expectedRevision
	) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Draft changed on the server",
			cause: { draftRevision: pipeline.draftRevision },
		});
	}

	const { document, diagnostics } = validatePipelineYaml(rawYaml);
	if (!document || hasBlockingDiagnostics(diagnostics)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Pipeline cannot be published: validation failed",
			cause: { diagnostics },
		});
	}

	const canonical = normalizePipelineDocumentV3(document);
	const contentHash = computePipelineContentHash(canonical);

	return db.transaction(async (tx) => {
		// Idempotency: an identical version already exists → reuse it.
		const existing = await tx
			.select({
				pipelineVersionId: scanPipelineVersions.pipelineVersionId,
				versionNumber: scanPipelineVersions.versionNumber,
			})
			.from(scanPipelineVersions)
			.where(
				and(
					eq(scanPipelineVersions.pipelineId, pipelineId),
					eq(scanPipelineVersions.contentHash, contentHash),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);

		let versionId: string;
		let versionNumber: number;
		if (existing) {
			versionId = existing.pipelineVersionId;
			versionNumber = existing.versionNumber;
		} else {
			const [latest] = await tx
				.select({
					next: max(scanPipelineVersions.versionNumber),
				})
				.from(scanPipelineVersions)
				.where(eq(scanPipelineVersions.pipelineId, pipelineId));
			versionNumber = (latest?.next ?? 0) + 1;
			const inserted = await tx
				.insert(scanPipelineVersions)
				.values({
					pipelineVersionId: nanoid(),
					pipelineId,
					versionNumber,
					yaml: rawYaml,
					contentHash,
					compiledDefinition: compilePipelineDocumentV3(
						canonical,
					) as unknown,
					publishedBy: userId,
				})
				.returning({ pipelineVersionId: scanPipelineVersions.pipelineVersionId });
			versionId = inserted[0]!.pipelineVersionId;
		}

		await tx
			.update(scanPipelines)
			.set({
				currentPublishedVersionId: versionId,
				draftYaml: null,
				draftRevision: pipeline.draftRevision + 1,
				updatedAt: new Date().toISOString(),
				updatedBy: userId,
			})
			.where(eq(scanPipelines.pipelineId, pipelineId));

		return { pipelineVersionId: versionId, versionNumber, contentHash };
	});
};

export const copyPipelineVersionToDraftForOrganization = async (
	input: PipelineManagerInput & {
		pipelineId: string;
		versionId: string;
	},
) => {
	const { organizationId, pipelineId, userId } = input;
	const version = await getPipelineVersionForOrganization(
		organizationId,
		pipelineId,
		input.versionId,
	);
	const pipeline = await findPipelineForOrganization(organizationId, pipelineId);
	await db
		.update(scanPipelines)
		.set({
			draftYaml: version.yaml,
			draftRevision: pipeline.draftRevision + 1,
			draftBaseVersionId: version.pipelineVersionId,
			updatedAt: new Date().toISOString(),
			updatedBy: userId,
		})
		.where(eq(scanPipelines.pipelineId, pipelineId));
	return { draftRevision: pipeline.draftRevision + 1 };
};

export const setPipelineCurrentVersionForOrganization = async (
	input: PipelineManagerInput & {
		pipelineId: string;
		versionId: string;
	},
) => {
	const { organizationId, pipelineId, userId } = input;
	await getPipelineVersionForOrganization(organizationId, pipelineId, input.versionId);
	await db
		.update(scanPipelines)
		.set({
			currentPublishedVersionId: input.versionId,
			updatedAt: new Date().toISOString(),
			updatedBy: userId,
		})
		.where(
			and(
				eq(scanPipelines.pipelineId, pipelineId),
				eq(scanPipelines.organizationId, organizationId),
			),
		);
	return { ok: true };
};

export const duplicatePipelineForOrganization = async (
	input: PipelineManagerInput & {
		pipelineId: string;
		slug: string;
		name?: string | null;
	},
) => {
	const { organizationId, userId } = input;
	const source = await getPipelineForOrganization(organizationId, input.pipelineId);
	const sourceVersion = source.currentPublishedVersionId
		? await getPipelineVersionForOrganization(
				organizationId,
				input.pipelineId,
				source.currentPublishedVersionId,
			)
		: null;
	const created = await createPipelineForOrganization({
		organizationId,
		userId,
		slug: input.slug,
		name: input.name || `${source.name} (copy)`,
		description: source.description,
		initialYaml: sourceVersion?.yaml ?? null,
	});
	// A duplicate that carries a published source becomes a draft that can be
	// tweaked and published as v1 of the new pipeline.
	return created;
};

export const archivePipelineForOrganization = async (
	input: PipelineManagerInput & { pipelineId: string },
) => {
	const { organizationId, pipelineId, userId } = input;
	await findPipelineForOrganization(organizationId, pipelineId);
	await db
		.update(scanPipelines)
		.set({
			archivedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			updatedBy: userId,
		})
		.where(
			and(
				eq(scanPipelines.pipelineId, pipelineId),
				eq(scanPipelines.organizationId, organizationId),
			),
		);
	return { ok: true };
};

export const unarchivePipelineForOrganization = async (
	input: PipelineManagerInput & { pipelineId: string },
) => {
	const { organizationId, pipelineId, userId } = input;
	await findPipelineForOrganization(organizationId, pipelineId);
	await db
		.update(scanPipelines)
		.set({
			archivedAt: null,
			updatedAt: new Date().toISOString(),
			updatedBy: userId,
		})
		.where(
			and(
				eq(scanPipelines.pipelineId, pipelineId),
				eq(scanPipelines.organizationId, organizationId),
			),
		);
	return { ok: true };
};

export const deletePipelineDraftForOrganization = async (
	input: PipelineManagerInput & { pipelineId: string },
) => {
	const { organizationId, pipelineId, userId } = input;
	const pipeline = await findPipelineForOrganization(organizationId, pipelineId);
	await db
		.update(scanPipelines)
		.set({
			draftYaml: null,
			draftRevision: pipeline.draftRevision + 1,
			draftBaseVersionId: null,
			updatedAt: new Date().toISOString(),
			updatedBy: userId,
		})
		.where(eq(scanPipelines.pipelineId, pipelineId));
	return { ok: true };
};

export const deletePipelineForOrganization = async (
	input: PipelineManagerInput & { pipelineId: string },
) => {
	const { organizationId, pipelineId } = input;
	await findPipelineForOrganization(organizationId, pipelineId);
	// scan_jobs.pipelineId is ON DELETE restrict: versions and profiles cascade
	// with the pipeline, but any scan job (even terminal) keeps it alive.
	const [job] = await db
		.select({ scanJobId: scanJobs.scanJobId })
		.from(scanJobs)
		.where(eq(scanJobs.pipelineId, pipelineId))
		.limit(1);
	if (job) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Pipeline has scan jobs and cannot be deleted. Delete its scan jobs first, or archive it instead.",
		});
	}
	await db
		.delete(scanPipelines)
		.where(
			and(
				eq(scanPipelines.pipelineId, pipelineId),
				eq(scanPipelines.organizationId, organizationId),
			),
		);
	return { ok: true };
};
