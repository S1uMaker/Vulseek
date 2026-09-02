import { relations } from "drizzle-orm";
import {
	boolean,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";

export const mcpTransport = pgEnum("mcpTransport", ["stdio", "http", "sse"]);

export type McpNameValue = {
	name: string;
	value: string;
};

export const mcpServers = pgTable(
	"mcp_servers",
	{
		mcpServerId: text("mcpServerId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		transport: mcpTransport("transport").notNull().default("http"),
		url: text("url"),
		headers: jsonb("headers").$type<McpNameValue[]>().notNull().default([]),
		command: text("command"),
		args: jsonb("args").$type<string[]>().notNull().default([]),
		env: jsonb("env").$type<McpNameValue[]>().notNull().default([]),
		isEnabled: boolean("isEnabled").notNull().default(true),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		organizationSlugUnique: uniqueIndex("mcp_servers_org_slug_unique").on(
			table.organizationId,
			table.slug,
		),
	}),
);

export const mcpServersRelations = relations(mcpServers, ({ one }) => ({
	organization: one(organization, {
		fields: [mcpServers.organizationId],
		references: [organization.id],
	}),
}));

export const MCP_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export const mcpSlugSchema = z
	.string()
	.min(1, { message: "Slug is required" })
	.regex(MCP_SLUG_PATTERN, {
		message: "Slug must be lowercase letters, digits, and hyphens",
	});

export const mcpNameValueSchema = z.object({
	name: z.string().min(1),
	value: z.string(),
});

export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);

const mcpServerFieldsSchema = z.object({
	name: z.string().min(1, { message: "Name is required" }),
	slug: mcpSlugSchema,
	description: z.string().nullable().optional(),
	transport: mcpTransportSchema,
	url: z.string().nullable().optional(),
	headers: z.array(mcpNameValueSchema).optional().default([]),
	command: z.string().nullable().optional(),
	args: z.array(z.string()).optional().default([]),
	env: z.array(mcpNameValueSchema).optional().default([]),
	isEnabled: z.boolean().optional().default(true),
});

const refineMcpTransport = (
	value: {
		transport: "stdio" | "http" | "sse";
		url?: string | null;
		command?: string | null;
	},
	ctx: z.RefinementCtx,
) => {
	if (value.transport === "stdio") {
		if (!value.command?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["command"],
				message: "Command is required for stdio MCP servers",
			});
		}
		return;
	}
	const url = value.url?.trim() ?? "";
	if (!url) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["url"],
			message: "URL is required for HTTP and SSE MCP servers",
		});
		return;
	}
	try {
		new URL(url);
	} catch {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["url"],
			message: "Please enter a valid URL",
		});
	}
};

export const apiCreateMcpServer =
	mcpServerFieldsSchema.superRefine(refineMcpTransport);

export const apiUpdateMcpServer = mcpServerFieldsSchema
	.partial()
	.extend({
		mcpServerId: z.string().min(1),
	})
	.superRefine((value, ctx) => {
		if (!value.transport) return;
		refineMcpTransport(
			{
				transport: value.transport,
				url: value.url,
				command: value.command,
			},
			ctx,
		);
	});
