import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	collectPipelineDiagnostics,
	hasBlockingDiagnostics,
	parsePipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";

const yamlPath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../../packages/server/src/services/scan/pipeline/definitions/pipelines-v3/orch-hunt.yaml",
);

describe("orch-hunt V3 pipeline", () => {
	const yaml = readFileSync(yamlPath, "utf-8");
	const parsed = parsePipelineDocumentV3(yaml);

	it("attaches the securitycontext MCP to hunter", () => {
		expect(parsed.document?.stages.hunter?.runtime.mcp).toEqual([
			"securitycontext",
		]);
	});

	it("attaches the securitycontext MCP to orchestrator", () => {
		expect(parsed.document?.stages.orchestrator?.runtime.mcp).toEqual([
			"securitycontext",
		]);
	});

	it("parses without blocking diagnostics", () => {
		expect(parsed.document).not.toBeNull();
		const diagnostics = collectPipelineDiagnostics(parsed.document!);
		expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
		expect(hasBlockingDiagnostics([...parsed.diagnostics, ...diagnostics])).toBe(
			false,
		);
		expect(parsed.document?.root).toBe("orchestrator");
		expect(Object.keys(parsed.document?.stages ?? {}).sort()).toEqual([
			"hunter",
			"orchestrator",
			"triage-finding",
			"verify-finding",
		]);
		expect(
			parsed.document?.presentation?.jobTabs.map((tab) => tab.id),
		).toEqual(["candidates"]);
	});

	it("lets the orchestrator fan hunts and accepted candidates without routes", () => {
		const edges = parsed.document?.edges ?? [];
		expect(edges.map((edge) => edge.id)).toEqual([
			"orchestrator-to-hunter",
			"hunter-to-orchestrator",
			"orchestrator-to-verify-finding",
			"verify-finding-to-triage-finding",
		]);

		const fromOrch = edges.filter((edge) => edge.from === "orchestrator");
		expect(fromOrch.map((edge) => edge.to)).toEqual([
			"hunter",
			"verify-finding",
		]);
		expect(fromOrch.every((edge) => edge.route == null)).toBe(true);
		expect(fromOrch.every((edge) => edge.mode === "fanOut")).toBe(true);

		const hunt = edges.find((edge) => edge.id === "orchestrator-to-hunter");
		expect(hunt).toMatchObject({
			foreach: "$.huntTasks[*]",
			input: {
				name: "$item.name",
				goalPrompt: "$item.goalPrompt",
			},
		});
		expect(hunt?.artifacts ?? []).toEqual([]);

		const verify = edges.find(
			(edge) => edge.id === "orchestrator-to-verify-finding",
		);
		expect(verify).toMatchObject({
			foreach: "$.candidates[*]",
			input: {
				candidate: "$item",
				repositoryPath: "$input.repositoryPath",
			},
		});
		expect(verify?.input).not.toHaveProperty("candidatePath");
		expect(verify?.artifacts).toContainEqual(
			expect.objectContaining({
				from: "$input.candidate",
				to: "inputs/candidate.json",
			}),
		);
		expect(verify?.artifacts?.some((artifact) => artifact.inputField === "candidatePath")).toBe(
			false,
		);

		const hunterEdges = edges.filter((edge) => edge.from === "hunter");
		expect(hunterEdges).toEqual([
			expect.objectContaining({
				id: "hunter-to-orchestrator",
				to: "orchestrator",
				mode: "map",
				input: {
					name: "$output.name",
					feedback: "$output.feedback",
				},
			}),
		]);
	});

	it("keeps huntTasks as named objects, hunter output named, and candidate as the named schema", () => {
		const orchOutput = parsed.document!.stages.orchestrator!.outputSchema as {
			properties?: {
				huntTasks?: { items?: { $ref?: string } };
				candidates?: { items?: { $ref?: string } };
			};
			required?: string[];
		};
		expect(orchOutput?.required).toEqual(["huntTasks", "candidates"]);
		expect(orchOutput?.properties?.huntTasks?.items?.$ref).toBe(
			"#/schemas/hunt-task",
		);
		expect(orchOutput?.properties?.candidates?.items?.$ref).toBe(
			"#/schemas/candidate",
		);

		const hunterOutput = parsed.document!.stages.hunter!.outputSchema as {
			properties?: { feedback?: { type?: string }; name?: { type?: string } };
			required?: string[];
		};
		expect(hunterOutput?.required).toEqual(["name", "feedback"]);
		expect(hunterOutput?.properties?.feedback?.type).toBe("string");
		expect(hunterOutput?.properties?.name?.type).toBe("string");

		expect(parsed.document?.schemas).toHaveProperty("candidate");
		expect(parsed.document?.schemas).toHaveProperty("hunt-task");
		const huntTaskName = (
			parsed.document!.schemas as {
				"hunt-task"?: {
					properties?: { name?: { description?: string; pattern?: string } };
				};
			}
		)["hunt-task"]?.properties?.name;
		expect(huntTaskName?.pattern).toBe("^#[1-9][0-9]* .+");
		expect(huntTaskName?.description).toContain("#<n>");
		expect(huntTaskName?.description).toContain("Orchestrator");
		expect(parsed.document?.schemas).not.toHaveProperty("hunter-feedback");
		expect(parsed.document?.schemas).not.toHaveProperty("orchestrator-input");
		expect(parsed.document?.schemas).not.toHaveProperty("orchestrator-dispatch");
		expect(parsed.document!.stages.hunter!.effects).toEqual([]);
		expect(parsed.document!.stages.orchestrator!.effects).toEqual([
			{ type: "sync-candidates" },
		]);
	});

	it("gives orchestrator the hunter-dispatch skill and a short hunt prompt", () => {
		expect(parsed.document!.stages.orchestrator!.runtime.skills).toEqual([
			"scan-runtime",
			"orchestrator",
		]);
		expect(parsed.document!.stages.orchestrator!.runtime.inputDelivery).toBe(
			"poll",
		);
		expect(
			parsed.document!.stages.orchestrator!.runtime.messageNotification,
		).toBe(true);
		expect(
			parsed.document!.stages.hunter!.runtime.messageNotification ?? false,
		).toBe(false);
		expect(parsed.document!.stages.orchestrator!.runtime.pollPrompt).toContain(
			"get_hunter_feedback",
		);
		expect(parsed.document!.stages.orchestrator!.runtime.pollPrompt).toContain(
			"spawn_hunters",
		);
		expect(parsed.document!.stages.orchestrator!.runtime.pollPrompt).not.toContain(
			"expected wait state",
		);
		expect(parsed.document!.stages.orchestrator!.runtime.outputSuffix).toBe(
			"omit",
		);
		expect(
			parsed.document!.stages.hunter!.runtime.outputSuffix ?? "include",
		).toBe("include");
		expect(parsed.document!.stages.hunter!.runtime.inputDelivery).toBe("prompt");
		const prompt = parsed.document!.stages.orchestrator!.runtime.prompt ?? "";
		expect(prompt).toContain(
			"$VULSEEK_AGENT_HOME/skills/orchestrator/SKILL.md",
		);
		expect(prompt).toContain("you are not a Hunter");
		expect(prompt).toContain("Slice work by primitive");
		expect(prompt).toContain("spawn_hunters immediately");
		expect(prompt).toContain("submit_candidate only when");
		expect(prompt).toContain("original unauthenticated high-CVSS");
		expect(prompt).toContain("Security Context MCP");
		expect(prompt).toContain("known CVE is a map");
		expect(prompt).not.toContain("Hunt by dispatching distinct directions");
		expect(prompt).not.toContain("Fill available hunter slots each turn");
		expect(prompt).not.toContain("poll-messages");
		expect(prompt).not.toContain("complete-messages");
		expect(prompt).not.toContain("running-tasks --stage hunter");
		expect(prompt).not.toContain("stage-outputs --stage hunter");
		expect(prompt).not.toContain("wait states");
		expect(prompt).not.toContain("query_scan_runtime.py");
		expect(prompt).not.toContain("Success is");
		expect(prompt).not.toMatch(/wordpress/i);
		expect(prompt).not.toMatch(/\/flag/);
		expect(prompt).not.toMatch(/subagent/i);
		expect(parsed.document!.stages.hunter!.runtime.prompt).toContain("{{goalPrompt}}");
		expect(parsed.document!.stages.hunter!.runtime.prompt).toContain("{{name}}");
	});
});
