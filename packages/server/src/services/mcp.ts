import { TRPCError } from "@trpc/server";
import { db } from "@vulseek/server/db";
import {
	type McpNameValue,
	mcpServers,
	scanPipelines,
} from "@vulseek/server/db/schema";
import { and, asc, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";

export const SECURITYCONTEXT_MCP_SLUG = "securitycontext";

export const SECURITYCONTEXT_MCP = {
	slug: SECURITYCONTEXT_MCP_SLUG,
	name: "Security Context",
	description:
		"Repo hunting context: fixed-vuln history, CVEs, weak spots, and variant leads.",
	transport: "http" as const,
	url: "https://securitycontext.dev/mcp",
};

export type McpTransport = "stdio" | "http" | "sse";

export type McpServerRecord = {
	slug: string;
	transport: McpTransport;
	url: string | null;
	headers: McpNameValue[];
	command: string | null;
	args: string[];
	env: McpNameValue[];
	isEnabled: boolean;
};

export type AcpMcpServer =
	| {
			name: string;
			command: string;
			args: string[];
			env: McpNameValue[];
	  }
	| {
			type: "http" | "sse";
			name: string;
			url: string;
			headers: McpNameValue[];
	  };

export type McpAgentProvider = "codex" | "claude_code" | "grok_build";

export type McpServerWriteInput = {
	name: string;
	slug: string;
	description?: string | null;
	transport: McpTransport;
	url?: string | null;
	headers?: McpNameValue[];
	command?: string | null;
	args?: string[];
	env?: McpNameValue[];
	isEnabled?: boolean;
};

const uniqueSlugs = (slugs: readonly string[]) => {
	const seen = new Set<string>();
	const values: string[] = [];
	for (const slug of slugs) {
		const value = slug.trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		values.push(value);
	}
	return values;
};

const cleanNameValues = (values: McpNameValue[] | null | undefined) =>
	(values ?? [])
		.map((item) => ({
			name: item.name.trim(),
			value: item.value,
		}))
		.filter((item) => item.name.length > 0);

const cleanArgs = (values: string[] | null | undefined) =>
	(values ?? []).map((item) => item.trim()).filter(Boolean);

const normalizeWriteInput = (input: McpServerWriteInput) => {
	const transport = input.transport;
	const headers = cleanNameValues(input.headers);
	const env = cleanNameValues(input.env);
	const args = cleanArgs(input.args);
	if (transport === "stdio") {
		return {
			name: input.name.trim(),
			slug: input.slug.trim(),
			description: input.description?.trim() || null,
			transport,
			url: null,
			headers: [],
			command: input.command?.trim() || null,
			args,
			env,
			isEnabled: input.isEnabled ?? true,
		};
	}
	return {
		name: input.name.trim(),
		slug: input.slug.trim(),
		description: input.description?.trim() || null,
		transport,
		url: input.url?.trim() || null,
		headers,
		command: null,
		args: [],
		env: [],
		isEnabled: input.isEnabled ?? true,
	};
};

export const toAcpMcpServer = (server: McpServerRecord): AcpMcpServer => {
	if (server.transport === "stdio") {
		if (!server.command?.trim()) {
			throw new Error(`MCP server "${server.slug}" is missing a command`);
		}
		return {
			name: server.slug,
			command: server.command.trim(),
			args: server.args ?? [],
			env: server.env ?? [],
		};
	}
	if (!server.url?.trim()) {
		throw new Error(`MCP server "${server.slug}" is missing a URL`);
	}
	return {
		type: server.transport,
		name: server.slug,
		url: server.url.trim(),
		headers: server.headers ?? [],
	};
};

export const mapMcpServersToAcp = (input: {
	slugs: readonly string[];
	servers: readonly McpServerRecord[];
	provider?: McpAgentProvider | null;
}): AcpMcpServer[] => {
	const bySlug = new Map(input.servers.map((server) => [server.slug, server]));
	const mapped: AcpMcpServer[] = [];
	for (const slug of uniqueSlugs(input.slugs)) {
		const server = bySlug.get(slug);
		if (!server) {
			throw new Error(`MCP server "${slug}" was not found`);
		}
		if (!server.isEnabled) continue;
		if (server.transport === "sse" && input.provider !== "claude_code") {
			continue;
		}
		mapped.push(toAcpMcpServer(server));
	}
	return mapped;
};

const slugConflict = (slug: string) =>
	new TRPCError({
		code: "CONFLICT",
		message: `An MCP server with slug "${slug}" already exists`,
	});

const findMcpServerBySlug = async (input: {
	organizationId: string;
	slug: string;
	excludeId?: string;
}) => {
	const rows = await db
		.select()
		.from(mcpServers)
		.where(
			input.excludeId
				? and(
						eq(mcpServers.organizationId, input.organizationId),
						eq(mcpServers.slug, input.slug),
						ne(mcpServers.mcpServerId, input.excludeId),
					)
				: and(
						eq(mcpServers.organizationId, input.organizationId),
						eq(mcpServers.slug, input.slug),
					),
		)
		.limit(1);
	return rows[0] ?? null;
};

const assertSlugAvailable = async (input: {
	organizationId: string;
	slug: string;
	mcpServerId?: string;
}) => {
	const existing = await findMcpServerBySlug({
		organizationId: input.organizationId,
		slug: input.slug,
		excludeId: input.mcpServerId,
	});
	if (existing) throw slugConflict(input.slug);
};

export const ensureBuiltinMcpServers = async (organizationId: string) => {
	const existing = await findMcpServerBySlug({
		organizationId,
		slug: SECURITYCONTEXT_MCP.slug,
	});
	if (existing) return;
	await db.insert(mcpServers).values({
		mcpServerId: nanoid(),
		organizationId,
		name: SECURITYCONTEXT_MCP.name,
		slug: SECURITYCONTEXT_MCP.slug,
		description: SECURITYCONTEXT_MCP.description,
		transport: SECURITYCONTEXT_MCP.transport,
		url: SECURITYCONTEXT_MCP.url,
		headers: [],
		command: null,
		args: [],
		env: [],
		isEnabled: true,
	});
};

export const listMcpServers = async (organizationId: string) => {
	await ensureBuiltinMcpServers(organizationId);
	return await db
		.select()
		.from(mcpServers)
		.where(eq(mcpServers.organizationId, organizationId))
		.orderBy(
			asc(mcpServers.name),
			asc(mcpServers.createdAt),
			asc(mcpServers.mcpServerId),
		);
};

export const getMcpServerById = async (mcpServerId: string) => {
	const [server] = await db
		.select()
		.from(mcpServers)
		.where(eq(mcpServers.mcpServerId, mcpServerId))
		.limit(1);
	if (!server) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "MCP server not found",
		});
	}
	return server;
};

export const createMcpServer = async (
	organizationId: string,
	input: McpServerWriteInput,
) => {
	const values = normalizeWriteInput(input);
	await assertSlugAvailable({ organizationId, slug: values.slug });
	const [created] = await db
		.insert(mcpServers)
		.values({
			mcpServerId: nanoid(),
			organizationId,
			...values,
		})
		.returning();
	return created;
};

export const updateMcpServer = async (
	organizationId: string,
	mcpServerId: string,
	input: Partial<McpServerWriteInput>,
) => {
	const current = await getMcpServerById(mcpServerId);
	if (current.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this MCP server",
		});
	}
	const values = normalizeWriteInput({
		name: input.name ?? current.name,
		slug: input.slug ?? current.slug,
		description:
			input.description === undefined ? current.description : input.description,
		transport: input.transport ?? current.transport,
		url: input.url === undefined ? current.url : input.url,
		headers: input.headers ?? current.headers,
		command: input.command === undefined ? current.command : input.command,
		args: input.args ?? current.args,
		env: input.env ?? current.env,
		isEnabled: input.isEnabled ?? current.isEnabled,
	});
	if (values.slug !== current.slug) {
		await assertSlugAvailable({
			organizationId,
			slug: values.slug,
			mcpServerId,
		});
	}
	const [updated] = await db
		.update(mcpServers)
		.set(values)
		.where(
			and(
				eq(mcpServers.mcpServerId, mcpServerId),
				eq(mcpServers.organizationId, organizationId),
			),
		)
		.returning();
	return updated;
};

export const deleteMcpServer = async (
	organizationId: string,
	mcpServerId: string,
) => {
	const current = await getMcpServerById(mcpServerId);
	if (current.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this MCP server",
		});
	}
	await db
		.delete(mcpServers)
		.where(
			and(
				eq(mcpServers.mcpServerId, mcpServerId),
				eq(mcpServers.organizationId, organizationId),
			),
		);
	return current;
};

export const findPipelineOrganizationId = async (pipelineId: string) => {
	const [row] = await db
		.select({ organizationId: scanPipelines.organizationId })
		.from(scanPipelines)
		.where(eq(scanPipelines.pipelineId, pipelineId))
		.limit(1);
	if (!row) {
		throw new Error(`Pipeline ${pipelineId} not found`);
	}
	return row.organizationId;
};

export const resolveAcpMcpServers = async (input: {
	organizationId: string;
	slugs: readonly string[];
	provider?: McpAgentProvider | null;
}): Promise<AcpMcpServer[]> => {
	const slugs = uniqueSlugs(input.slugs);
	if (slugs.length === 0) return [];
	await ensureBuiltinMcpServers(input.organizationId);
	const servers = await db
		.select()
		.from(mcpServers)
		.where(eq(mcpServers.organizationId, input.organizationId));
	return mapMcpServersToAcp({
		slugs,
		servers,
		provider: input.provider,
	});
};
