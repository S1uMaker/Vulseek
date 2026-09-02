import {
	type McpServerRecord,
	mapMcpServersToAcp,
	SECURITYCONTEXT_MCP,
	toAcpMcpServer,
} from "@vulseek/server/services/mcp";
import { describe, expect, it } from "vitest";

const httpServer = (
	overrides: Partial<McpServerRecord> = {},
): McpServerRecord => ({
	slug: "securitycontext",
	transport: "http",
	url: SECURITYCONTEXT_MCP.url,
	headers: [],
	command: null,
	args: [],
	env: [],
	isEnabled: true,
	...overrides,
});

describe("mapMcpServersToAcp", () => {
	it("maps HTTP servers to ACP session/new objects", () => {
		expect(
			mapMcpServersToAcp({
				slugs: ["securitycontext"],
				servers: [httpServer()],
				provider: "codex",
			}),
		).toEqual([
			{
				type: "http",
				name: "securitycontext",
				url: "https://securitycontext.dev/mcp",
				headers: [],
			},
		]);
	});

	it("maps stdio servers without a type field", () => {
		expect(
			toAcpMcpServer({
				slug: "local-tools",
				transport: "stdio",
				url: null,
				headers: [],
				command: "npx",
				args: ["-y", "example"],
				env: [{ name: "TOKEN", value: "x" }],
				isEnabled: true,
			}),
		).toEqual({
			name: "local-tools",
			command: "npx",
			args: ["-y", "example"],
			env: [{ name: "TOKEN", value: "x" }],
		});
	});

	it("skips disabled servers and drops SSE for Codex and Grok", () => {
		const servers: McpServerRecord[] = [
			httpServer({ slug: "off", isEnabled: false }),
			httpServer({
				slug: "events",
				transport: "sse",
				url: "https://example.test/sse",
			}),
			httpServer({ slug: "ok" }),
		];
		expect(
			mapMcpServersToAcp({
				slugs: ["off", "events", "ok"],
				servers,
				provider: "codex",
			}),
		).toEqual([
			{
				type: "http",
				name: "ok",
				url: SECURITYCONTEXT_MCP.url,
				headers: [],
			},
		]);
		expect(
			mapMcpServersToAcp({
				slugs: ["events"],
				servers,
				provider: "claude_code",
			}),
		).toEqual([
			{
				type: "sse",
				name: "events",
				url: "https://example.test/sse",
				headers: [],
			},
		]);
	});

	it("throws when a referenced slug is missing", () => {
		expect(() =>
			mapMcpServersToAcp({
				slugs: ["missing"],
				servers: [httpServer()],
			}),
		).toThrow(/missing/);
	});
});
