import { TRPCError } from "@trpc/server";
import { db } from "@vulseek/server/db";
import { agentSkills } from "@vulseek/server/db/schema";
import { and, asc, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
	createSkillFileAt,
	deleteSkillFileAt,
	discoverFilesystemSkills,
	ensureSkillDirectory,
	listSkillDirectoryAt,
	readSkillFileAt,
	removeSkillDirectory,
	resolvePathInsideRoot,
	resolveSkillsRoot,
	writeSkillFileAt,
} from "./skill-files";

export type SkillWriteInput = {
	name: string;
	slug: string;
	description?: string | null;
	directoryPath?: string;
};

const slugConflict = (slug: string) =>
	new TRPCError({
		code: "CONFLICT",
		message: `A skill with slug "${slug}" already exists`,
	});

const normalizeWriteInput = (input: SkillWriteInput) => {
	const slug = input.slug.trim();
	const directoryPath = (input.directoryPath?.trim() || slug).replace(
		/^\/+|\/+$/g,
		"",
	);
	return {
		name: input.name.trim(),
		slug,
		description: input.description?.trim() || null,
		directoryPath,
	};
};

const findSkillBySlug = async (input: {
	organizationId: string;
	slug: string;
	excludeId?: string;
}) => {
	const rows = await db
		.select()
		.from(agentSkills)
		.where(
			input.excludeId
				? and(
						eq(agentSkills.organizationId, input.organizationId),
						eq(agentSkills.slug, input.slug),
						ne(agentSkills.skillId, input.excludeId),
					)
				: and(
						eq(agentSkills.organizationId, input.organizationId),
						eq(agentSkills.slug, input.slug),
					),
		)
		.limit(1);
	return rows[0] ?? null;
};

const assertSlugAvailable = async (input: {
	organizationId: string;
	slug: string;
	skillId?: string;
}) => {
	const existing = await findSkillBySlug({
		organizationId: input.organizationId,
		slug: input.slug,
		excludeId: input.skillId,
	});
	if (existing) throw slugConflict(input.slug);
};

export const getSkillById = async (skillId: string) => {
	const [skill] = await db
		.select()
		.from(agentSkills)
		.where(eq(agentSkills.skillId, skillId))
		.limit(1);
	if (!skill) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Skill not found",
		});
	}
	return skill;
};

const assertSkillOrganization = (
	skill: { organizationId: string },
	organizationId: string,
) => {
	if (skill.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this skill",
		});
	}
};

const resolveSkillRoot = async (
	skill: { directoryPath: string },
	agentsDir?: string | null,
) => {
	const skillsRoot = await resolveSkillsRoot(agentsDir);
	return resolvePathInsideRoot(skillsRoot, skill.directoryPath);
};

export const ensureFilesystemSkills = async (
	organizationId: string,
	agentsDir?: string | null,
) => {
	const skillsRoot = await resolveSkillsRoot(agentsDir);
	const discovered = await discoverFilesystemSkills(skillsRoot);
	if (discovered.length === 0) return;
	await db
		.insert(agentSkills)
		.values(
			discovered.map((skill) => ({
				skillId: nanoid(),
				organizationId,
				name: skill.name,
				slug: skill.slug,
				description: skill.description || null,
				directoryPath: skill.directoryPath,
			})),
		)
		.onConflictDoNothing();
};

export const listSkills = async (
	organizationId: string,
	agentsDir?: string | null,
) => {
	await ensureFilesystemSkills(organizationId, agentsDir);
	return await db
		.select()
		.from(agentSkills)
		.where(eq(agentSkills.organizationId, organizationId))
		.orderBy(
			asc(agentSkills.name),
			asc(agentSkills.slug),
			asc(agentSkills.skillId),
		);
};

export const createSkill = async (
	organizationId: string,
	input: SkillWriteInput,
	agentsDir?: string | null,
) => {
	const values = normalizeWriteInput(input);
	await assertSlugAvailable({ organizationId, slug: values.slug });
	const skillsRoot = await resolveSkillsRoot(agentsDir);
	await ensureSkillDirectory({
		skillsRoot,
		directoryPath: values.directoryPath,
		slug: values.slug,
		name: values.name,
		description: values.description,
	});
	const [created] = await db
		.insert(agentSkills)
		.values({
			skillId: nanoid(),
			organizationId,
			...values,
		})
		.returning();
	return created;
};

export const updateSkill = async (
	organizationId: string,
	skillId: string,
	input: Partial<SkillWriteInput>,
	agentsDir?: string | null,
) => {
	const current = await getSkillById(skillId);
	assertSkillOrganization(current, organizationId);
	const values = normalizeWriteInput({
		name: input.name ?? current.name,
		slug: input.slug ?? current.slug,
		description:
			input.description === undefined ? current.description : input.description,
		directoryPath: input.directoryPath ?? current.directoryPath,
	});
	if (values.slug !== current.slug) {
		await assertSlugAvailable({
			organizationId,
			slug: values.slug,
			skillId,
		});
	}
	resolvePathInsideRoot(await resolveSkillsRoot(agentsDir), values.directoryPath);
	const [updated] = await db
		.update(agentSkills)
		.set({
			...values,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(agentSkills.skillId, skillId),
				eq(agentSkills.organizationId, organizationId),
			),
		)
		.returning();
	return updated;
};

export const deleteSkill = async (
	organizationId: string,
	skillId: string,
	agentsDir?: string | null,
) => {
	const current = await getSkillById(skillId);
	assertSkillOrganization(current, organizationId);
	const skillsRoot = await resolveSkillsRoot(agentsDir);
	await removeSkillDirectory({
		skillsRoot,
		directoryPath: current.directoryPath,
	});
	await db
		.delete(agentSkills)
		.where(
			and(
				eq(agentSkills.skillId, skillId),
				eq(agentSkills.organizationId, organizationId),
			),
		);
	return current;
};

export const listSkillDirectory = async (input: {
	organizationId: string;
	skillId: string;
	directoryPath?: string;
	agentsDir?: string | null;
}) => {
	const skill = await getSkillById(input.skillId);
	assertSkillOrganization(skill, input.organizationId);
	const skillRoot = await resolveSkillRoot(skill, input.agentsDir);
	return listSkillDirectoryAt({
		skillRoot,
		directoryPath: input.directoryPath,
	});
};

export const readSkillFile = async (input: {
	organizationId: string;
	skillId: string;
	filePath: string;
	agentsDir?: string | null;
}) => {
	const skill = await getSkillById(input.skillId);
	assertSkillOrganization(skill, input.organizationId);
	const skillRoot = await resolveSkillRoot(skill, input.agentsDir);
	return readSkillFileAt({
		skillRoot,
		filePath: input.filePath,
	});
};

export const writeSkillFile = async (input: {
	organizationId: string;
	skillId: string;
	filePath: string;
	content: string;
	agentsDir?: string | null;
}) => {
	const skill = await getSkillById(input.skillId);
	assertSkillOrganization(skill, input.organizationId);
	const skillRoot = await resolveSkillRoot(skill, input.agentsDir);
	const result = await writeSkillFileAt({
		skillRoot,
		filePath: input.filePath,
		content: input.content,
	});
	await db
		.update(agentSkills)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(agentSkills.skillId, skill.skillId));
	return result;
};

export const createSkillFile = async (input: {
	organizationId: string;
	skillId: string;
	filePath: string;
	content?: string;
	directory?: boolean;
	agentsDir?: string | null;
}) => {
	const skill = await getSkillById(input.skillId);
	assertSkillOrganization(skill, input.organizationId);
	const skillRoot = await resolveSkillRoot(skill, input.agentsDir);
	const result = await createSkillFileAt({
		skillRoot,
		filePath: input.filePath,
		content: input.content,
		directory: input.directory,
	});
	await db
		.update(agentSkills)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(agentSkills.skillId, skill.skillId));
	return result;
};

export const deleteSkillFile = async (input: {
	organizationId: string;
	skillId: string;
	filePath: string;
	agentsDir?: string | null;
}) => {
	const skill = await getSkillById(input.skillId);
	assertSkillOrganization(skill, input.organizationId);
	const skillRoot = await resolveSkillRoot(skill, input.agentsDir);
	const result = await deleteSkillFileAt({
		skillRoot,
		filePath: input.filePath,
	});
	await db
		.update(agentSkills)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(agentSkills.skillId, skill.skillId));
	return result;
};
