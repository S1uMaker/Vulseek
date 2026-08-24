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
			"orchestrator-to-verify-finding",
			"hunter-to-orchestrator",
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
				goalPrompt: "$item",
			},
		});

		const verify = edges.find(
			(edge) => edge.id === "orchestrator-to-verify-finding",
		);
		expect(verify).toMatchObject({
			foreach: "$.candidates[*]",
		});
		expect(verify?.artifacts).toContainEqual(
			expect.objectContaining({
				from: "$input.candidate",
				inputField: "candidatePath",
			}),
		);

		const hunterEdges = edges.filter((edge) => edge.from === "hunter");
		expect(hunterEdges.map((edge) => edge.to)).toEqual(["orchestrator"]);
		expect(hunterEdges[0]).toMatchObject({
			mode: "map",
			input: {
				feedback: "$output.feedback",
			},
		});
		expect(hunterEdges[0]?.route).toBeUndefined();
	});

	it("keeps huntTasks as strings, feedback as a string, and candidate as the named schema", () => {
		const orchOutput = parsed.document!.stages.orchestrator!.outputSchema as {
			properties?: {
				huntTasks?: { items?: { type?: string } };
				candidates?: { items?: { $ref?: string } };
			};
			required?: string[];
		};
		expect(orchOutput?.required).toEqual(["huntTasks", "candidates"]);
		expect(orchOutput?.properties?.huntTasks?.items?.type).toBe("string");
		expect(orchOutput?.properties?.candidates?.items?.$ref).toBe(
			"#/schemas/candidate",
		);

		const hunterOutput = parsed.document!.stages.hunter!.outputSchema as {
			properties?: { feedback?: { type?: string } };
			required?: string[];
		};
		expect(hunterOutput?.required).toEqual(["feedback"]);
		expect(hunterOutput?.properties?.feedback?.type).toBe("string");

		expect(parsed.document?.schemas).toHaveProperty("candidate");
		expect(parsed.document?.schemas).not.toHaveProperty("hunt-task");
		expect(parsed.document?.schemas).not.toHaveProperty("hunter-feedback");
		expect(parsed.document?.schemas).not.toHaveProperty("orchestrator-input");
		expect(parsed.document?.schemas).not.toHaveProperty("orchestrator-dispatch");
		expect(parsed.document!.stages.hunter!.effects).toEqual([]);
		expect(parsed.document!.stages.orchestrator!.effects).toEqual([
			{ type: "sync-candidates" },
		]);
	});

	it("gives orchestrator the reusable scan-runtime skill and generalized hunt prompt", () => {
		expect(parsed.document!.stages.orchestrator!.runtime.skills).toEqual([
			"scan-runtime",
		]);
		const prompt = parsed.document!.stages.orchestrator!.runtime.prompt ?? "";
		expect(prompt).toContain(
			"$VULSEEK_AGENT_HOME/skills/scan-runtime/SKILL.md",
		);
		expect(prompt).toContain("active hunter tasks");
		expect(prompt).toContain("before writing /task/output.json");
		expect(prompt).toContain("availableSlots");
		expect(prompt).toContain("huntTasks");
		expect(prompt).toContain("keep dispatching huntTasks");
		expect(prompt).not.toContain("query_scan_runtime.py");
		expect(prompt).not.toContain("Success is");
		expect(prompt).not.toMatch(/wordpress/i);
		expect(prompt).not.toMatch(/\bRCE\b/);
		expect(prompt).not.toMatch(/\/flag/);
		expect(prompt).not.toMatch(/subagent/i);
		expect(prompt).not.toMatch(/\bspawn\b/i);
	});
});
