import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	collectPipelineDiagnostics,
	hasBlockingDiagnostics,
	parsePipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../..",
);
const yamlPath = path.join(
	repoRoot,
	"packages/server/src/services/scan/pipeline/definitions/pipelines-v3/orch-hunt.yaml",
);
const skillPath = path.join(repoRoot, "agents/skills/orchestrator/SKILL.md");

describe("orch-hunt primitive-chain contract", () => {
	const yaml = readFileSync(yamlPath, "utf-8");
	const skill = readFileSync(skillPath, "utf-8");
	const parsed = parsePipelineDocumentV3(yaml);

	it("still loads as a valid V3 document", () => {
		expect(parsed.document).not.toBeNull();
		const diagnostics = collectPipelineDiagnostics(parsed.document!);
		expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
		expect(hasBlockingDiagnostics([...parsed.diagnostics, ...diagnostics])).toBe(
			false,
		);
	});

	it("keeps orchestrator as dispatcher of primitives, not a hunter", () => {
		const prompt = parsed.document!.stages.orchestrator!.runtime.prompt ?? "";
		expect(prompt).toMatch(/primitive/i);
		expect(prompt).toMatch(/spawn_hunters immediately/);
		expect(prompt).toMatch(/you are not a Hunter/i);
		expect(prompt).not.toContain("Hunt by dispatching distinct directions");
		expect(prompt).not.toContain("Fill available hunter slots each turn");
		expect(prompt).not.toContain("Do not halt or call update_goal complete");
		expect(prompt).not.toMatch(/each Goal turn/i);
		expect(parsed.document!.stages.orchestrator!.description).toMatch(
			/primitive/i,
		);
	});

	it("locks hunter standing rules to one primitive plus a gap", () => {
		const prompt = parsed.document!.stages.hunter!.runtime.prompt ?? "";
		expect(prompt).toContain("{{goalPrompt}}");
		expect(prompt).toMatch(/gap/i);
		expect(prompt).toContain("Do not declare exhaustion");
		expect(prompt).toContain("Do not submit_candidate");
		expect(prompt).toMatch(/same primitive/);
		expect(parsed.document!.stages.hunter!.description).toMatch(/primitive/i);
	});

	it("describes hunt-task goalPrompt as an outcome-heavy primitive lockbox", () => {
		const huntTask = (
			parsed.document!.schemas as {
				"hunt-task"?: {
					properties?: { goalPrompt?: { description?: string } };
				};
			}
		)["hunt-task"];
		const description = huntTask?.properties?.goalPrompt?.description ?? "";
		expect(description).toMatch(/outcome-heavy/i);
		expect(description).toMatch(/primitive/i);
		expect(description).toContain("Do not prefix with /goal");
	});

	it("requires hunter feedback blocks that the orchestrator can extract", () => {
		const feedback = (
			parsed.document!.stages.hunter!.outputSchema as {
				properties?: { feedback?: { description?: string } };
			}
		).properties?.feedback?.description ?? "";
		expect(feedback).toMatch(/primitive type/i);
		expect(feedback).toContain("file:line");
		expect(feedback).toMatch(/gap/i);
		expect(feedback).toContain("Do not declare exhaustion");
	});

	it("puts spawn-before-submit, goalPrompt lockbox, and ledger in the skill", () => {
		expect(skill).not.toMatch(/each Goal turn/i);
		expect(skill).not.toMatch(/next orchestration pass/i);
		expect(skill).toMatch(/availableSlots > 0/);
		expect(skill).toMatch(/`spawn_hunters` immediately/);
		const spawnIdx = skill.indexOf("`spawn_hunters` immediately");
		const submitIdx = skill.indexOf(
			"`submit_candidate` only when a chain is complete",
		);
		expect(spawnIdx).toBeGreaterThan(0);
		expect(submitIdx).toBeGreaterThan(spawnIdx);
		expect(skill).toContain("Prefix with `/goal`");
		expect(skill).toContain("/lane/ledger.md");
		expect(skill).toMatch(/primitive/i);
		expect(skill).toContain("incomplete chain is an asset");
		expect(skill).toContain("get_vulnerability_leads");
		expect(skill).toMatch(/known vs original/i);
		expect(skill).toContain("Spawn first, SC second");
		expect(skill).toContain("re-find CVE-YYYY-n");
	});
});
