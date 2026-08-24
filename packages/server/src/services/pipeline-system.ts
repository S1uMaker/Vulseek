import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@vulseek/server/db";
import {
	applications,
	compose,
	environments,
	organization,
	projects,
	scanPipelines,
	scanPipelineVersions,
} from "@vulseek/server/db/schema";
import { nanoid } from "nanoid";
import { loadBuiltinPipelineTemplates } from "../services/scan/pipeline/document-v3/builtin-pipelines";
import type { BuiltinPipelineTemplate } from "../services/scan/pipeline/document-v3/builtin-pipelines";
import {
	compilePipelineDocumentV3,
	parsePipelineDocumentV3,
} from "../services/scan/pipeline/document-v3";

/**
 * Built-in pipeline seeding.
 *
 * YAML is used only when the org has no matching pipeline (slug or name).
 * Existing rows stay on the published database version.
 * Profile defaults backfill to the org's `full` pipeline by slug.
 */

const SLUG_SUFFIXES = ["", "-1", "-2", "-3"];

const ensureUniqueSlug = async (
	organizationId: string,
	baseSlug: string,
): Promise<string> => {
	for (const suffix of SLUG_SUFFIXES) {
		const slug = `${baseSlug}${suffix}`;
		const existing = await db
			.select({ pipelineId: scanPipelines.pipelineId })
			.from(scanPipelines)
			.where(
				and(
					eq(scanPipelines.organizationId, organizationId),
					eq(scanPipelines.slug, slug),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);
		if (!existing) return slug;
	}
	throw new Error(`Cannot allocate a slug for "${baseSlug}"`);
};

const findExistingSeededPipeline = async (input: {
	organizationId: string;
	template: BuiltinPipelineTemplate;
}) =>
	await db
		.select()
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.organizationId, input.organizationId),
				or(
					eq(scanPipelines.slug, input.template.slug),
					eq(scanPipelines.name, input.template.name),
				),
			),
		)
		.limit(1)
		.then((rows) => rows[0] ?? null);

const publishTemplateVersion = async (input: {
	organizationId: string;
	userId: string | null;
	template: BuiltinPipelineTemplate;
}) => {
	const { organizationId, userId, template } = input;
	const existing = await findExistingSeededPipeline({
		organizationId,
		template,
	});
	if (existing) {
		return { pipelineId: existing.pipelineId, unchanged: true };
	}

	const slug = await ensureUniqueSlug(organizationId, template.slug);
	const created = await db
		.insert(scanPipelines)
		.values({
			pipelineId: nanoid(),
			organizationId,
			slug,
			name: template.name,
			createdBy: userId,
			updatedBy: userId,
		})
		.returning({ pipelineId: scanPipelines.pipelineId });
	const pipelineId = created[0]!.pipelineId;
	const inserted = await db
		.insert(scanPipelineVersions)
		.values({
			pipelineVersionId: nanoid(),
			pipelineId,
			versionNumber: 1,
			yaml: template.yaml,
			contentHash: template.contentHash,
			compiledDefinition: compilePipelineDocumentV3(
				parsePipelineDocumentV3(template.yaml).document!,
			) as unknown,
			publishedBy: userId,
		})
		.returning({ pipelineVersionId: scanPipelineVersions.pipelineVersionId });

	await db
		.update(scanPipelines)
		.set({
			currentPublishedVersionId: inserted[0]!.pipelineVersionId,
			updatedAt: new Date().toISOString(),
			updatedBy: userId,
		})
		.where(eq(scanPipelines.pipelineId, pipelineId));

	return { pipelineId, unchanged: false };
};

/**
 * Seed the four built-in pipelines for one organization (v1). Idempotent —
 * existing same-named pipelines are left untouched.
 */
export const seedBuiltinPipelinesForOrganization = async (
	organizationId: string,
	userId: string | null = null,
) => {
	const templates = loadBuiltinPipelineTemplates();
	const results: Array<{
		slug: string;
		pipelineId: string;
		unchanged: boolean;
	}> = [];
	for (const template of templates) {
		const result = await publishTemplateVersion({
			organizationId,
			userId,
			template,
		});
		results.push({
			slug: template.slug,
			pipelineId: result.pipelineId,
			unchanged: result.unchanged,
		});
	}
	return results;
};

/** Alias kept for callers; no longer publishes template hash upgrades. */
export const syncBuiltinPipelinesForOrganization = async (
	organizationId: string,
	userId: string | null = null,
) => {
	const results = await seedBuiltinPipelinesForOrganization(
		organizationId,
		userId,
	);
	return results.map(({ slug, unchanged }) => ({
		slug,
		unchanged,
	}));
};

/** Seed every existing organization (startup). */
export const seedAllOrganizationsBuiltinPipelines = async () => {
	const organizations = await db
		.select({ id: organization.id })
		.from(organization);
	for (const org of organizations) {
		await seedBuiltinPipelinesForOrganization(org.id);
	}
	return organizations.length;
};



/** Backfill profile defaults to the org Full pipeline. */
export const backfillProfileDefaultPipelines = async () => {
	const fullPipelines = await db
		.select({
			pipelineId: scanPipelines.pipelineId,
			organizationId: scanPipelines.organizationId,
		})
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.slug, "full"),
				isNull(scanPipelines.archivedAt),
			),
		);
	let updated = 0;
	for (const pipeline of fullPipelines) {
		// application → environment → project → organization
		const orgEnvironmentIds = await db
			.select({ environmentId: environments.environmentId })
			.from(environments)
			.innerJoin(projects, eq(projects.projectId, environments.projectId))
			.where(eq(projects.organizationId, pipeline.organizationId));
		if (orgEnvironmentIds.length === 0) continue;
		const environmentIds = orgEnvironmentIds.map((row) => row.environmentId);
		const [app] = await db
			.update(applications)
			.set({ defaultPipelineId: pipeline.pipelineId })
			.where(
				and(
					inArray(applications.environmentId, environmentIds),
					isNull(applications.defaultPipelineId),
				),
			)
			.returning({ applicationId: applications.applicationId });
		if (app) updated += 1;
		const [composeRow] = await db
			.update(compose)
			.set({ defaultPipelineId: pipeline.pipelineId })
			.where(
				and(
					inArray(compose.environmentId, environmentIds),
					isNull(compose.defaultPipelineId),
				),
			)
			.returning({ composeId: compose.composeId });
		if (composeRow) updated += 1;
	}
	return updated;
};

export const findPipelineBySlugForOrganization = async (
	organizationId: string,
	slug: string,
) => {
	const pipeline = await db
		.select()
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.organizationId, organizationId),
				eq(scanPipelines.slug, slug),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!pipeline) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Pipeline "${slug}" not found for this organization`,
		});
	}
	return pipeline;
};
