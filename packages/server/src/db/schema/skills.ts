import { relations } from "drizzle-orm";
import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";

export const agentSkills = pgTable(
	"agent_skills",
	{
		skillId: text("skillId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		directoryPath: text("directoryPath").notNull(),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		organizationSlugUnique: uniqueIndex("agent_skills_org_slug_unique").on(
			table.organizationId,
			table.slug,
		),
	}),
);

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
	organization: one(organization, {
		fields: [agentSkills.organizationId],
		references: [organization.id],
	}),
}));

export const SKILL_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const SKILL_DIRECTORY_PATH_PATTERN =
	/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;

export const skillSlugSchema = z
	.string()
	.min(1, { message: "Slug is required" })
	.regex(SKILL_SLUG_PATTERN, {
		message: "Slug must be lowercase letters, digits, and hyphens",
	});

export const skillDirectoryPathSchema = z
	.string()
	.min(1, { message: "Directory path is required" })
	.regex(SKILL_DIRECTORY_PATH_PATTERN, {
		message: "Directory path must be a relative path under the skills root",
	});

const skillFieldsSchema = z.object({
	name: z.string().min(1, { message: "Name is required" }),
	slug: skillSlugSchema,
	description: z.string().nullable().optional(),
	directoryPath: skillDirectoryPathSchema.optional(),
});

export const apiCreateSkill = skillFieldsSchema;

export const apiUpdateSkill = skillFieldsSchema.partial().extend({
	skillId: z.string().min(1),
});

export const apiSkillId = z.object({
	skillId: z.string().min(1),
});

export const apiSkillDirectory = apiSkillId.extend({
	directoryPath: z.string().optional(),
});

export const apiSkillFilePath = apiSkillId.extend({
	filePath: z.string().min(1),
});

export const apiWriteSkillFile = apiSkillFilePath.extend({
	content: z.string(),
});

export const apiCreateSkillFile = apiSkillId.extend({
	filePath: z.string().min(1),
	content: z.string().optional(),
	directory: z.boolean().optional(),
});
