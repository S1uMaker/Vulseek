import { relations } from "drizzle-orm";
import {
	boolean,
	doublePrecision,
	pgEnum,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";

export const agentProvider = pgEnum("agentProvider", [
	"codex",
	"claude_code",
	"grok_build",
]);

export const ai = pgTable("ai", {
	aiId: text("aiId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	apiUrl: text("apiUrl").notNull(),
	apiKey: text("apiKey").notNull(),
	model: text("model").notNull(),
	isEnabled: boolean("isEnabled").notNull().default(true),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }), // Admin ID who created the AI settings
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const aiRelations = relations(ai, ({ one }) => ({
	organization: one(organization, {
		fields: [ai.organizationId],
		references: [organization.id],
	}),
}));

export const agentProfiles = pgTable("agent_profiles", {
	agentProfileId: text("agentProfileId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	provider: agentProvider("provider").notNull().default("codex"),
	authMode: text("authMode", {
		enum: ["api_key", "host_home"],
	})
		.notNull()
		.default("api_key"),
	homePath: text("homePath").notNull().default(""),
	baseUrl: text("baseUrl").notNull(),
	apiKey: text("apiKey").notNull(),
	model: text("model").notNull(),
	thinkingLevel: text("thinkingLevel").notNull().default("medium"),
	thinkingLevelEnabled: boolean("thinkingLevelEnabled").notNull().default(true),
	envs: text("envs").notNull().default(""),
	isEnabled: boolean("isEnabled").notNull().default(true),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const agentProfilesRelations = relations(agentProfiles, ({ one }) => ({
	organization: one(organization, {
		fields: [agentProfiles.organizationId],
		references: [organization.id],
	}),
}));

const createSchema = createInsertSchema(ai, {
	name: z.string().min(1, { message: "Name is required" }),
	apiUrl: z.string().url({ message: "Please enter a valid URL" }),
	apiKey: z.string(),
	model: z.string().min(1, { message: "Model is required" }),
	isEnabled: z.boolean().optional(),
});

export const apiCreateAi = createSchema
	.pick({
		name: true,
		apiUrl: true,
		apiKey: true,
		model: true,
		isEnabled: true,
	})
	.required();

export const apiUpdateAi = createSchema
	.partial()
	.extend({
		aiId: z.string().min(1),
	})
	.omit({ organizationId: true });

const createAgentProfileSchema = createInsertSchema(agentProfiles, {
	name: z.string().min(1, { message: "Name is required" }),
	provider: z.enum(["codex", "claude_code", "grok_build"]),
	authMode: z.enum(["api_key", "host_home"]).default("api_key"),
	homePath: z.string().optional().default(""),
	baseUrl: z.string().url({ message: "Please enter a valid URL" }),
	apiKey: z.string(),
	model: z.string().min(1, { message: "Model is required" }),
	thinkingLevel: z.string().min(1, { message: "Thinking level is required" }),
	thinkingLevelEnabled: z.boolean().default(true),
	envs: z.string().optional().default(""),
	isEnabled: z.boolean().optional(),
});

export const apiCreateAgentProfile = createAgentProfileSchema
	.pick({
		name: true,
		provider: true,
		authMode: true,
		homePath: true,
		baseUrl: true,
		apiKey: true,
		model: true,
		thinkingLevel: true,
		thinkingLevelEnabled: true,
		envs: true,
		isEnabled: true,
	})
	.required();

export const apiUpdateAgentProfile = createAgentProfileSchema
	.partial()
	.extend({
		agentProfileId: z.string().min(1),
	})
	.omit({ organizationId: true });

export const deploySuggestionSchema = z.object({
	environmentId: z.string().min(1),
	id: z.string().min(1),
	dockerCompose: z.string().min(1),
	envVariables: z.string(),
	serverId: z.string().optional(),
	name: z.string().min(1),
	description: z.string(),
	domains: z
		.array(
			z.object({
				host: z.string().min(1),
				port: z.number().min(1),
				serviceName: z.string().min(1),
			}),
		)
		.optional(),
	configFiles: z
		.array(
			z.object({
				filePath: z.string().min(1),
				content: z.string().min(1),
			}),
		)
		.optional(),
});
