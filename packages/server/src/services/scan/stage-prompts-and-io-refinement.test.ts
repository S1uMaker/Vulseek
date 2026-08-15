import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	candidateSchema,
	deltaScopeManifestSchema,
	moduleSchema,
	repositoryModuleSchema,
	repositoryProfileManifestSchema,
	scanTargetManifestSchema,
	targetSchema,
	triageSchema,
	verificationSchema,
} from "./artifacts/contracts/domain-object.contract";
import { renderPromptTemplateString } from "./prompts/prompt-template";
import { createJsonSchemaContract } from "./pipeline/scan-pipeline-schema-contracts";
import {
	buildStructuredOutputEnvelopeJsonSchema,
	buildStructuredOutputPromptSuffix,
} from "./runtime/structured-output-schema";
import { loadBuiltinPipelineTemplates } from "./pipeline/document-v3/builtin-pipelines";
import { parsePipelineDocumentV3 } from "./pipeline/document-v3/pipeline-document-v3-io";

const scanDir = dirname(fileURLToPath(import.meta.url));
const readStagePromptTemplate = (fileName: string) =>
	readFileSync(join(scanDir, "stages", fileName), "utf-8");
const readSkillSource = (skillName: string) =>
	readFileSync(
		join(scanDir, "../../../../../agents/skills", skillName, "SKILL.md"),
		"utf-8",
	);

test("Stage Graph prompt rendering rejects missing and unresolved variables", () => {
	assert.throws(
		() => renderPromptTemplateString("use {{repositoryName}}", {}),
		/Missing prompt template value: repositoryName/,
	);
	assert.throws(
		() => renderPromptTemplateString("use {{repositoryName}} and {{unknown}}", {
			repositoryName: "repo",
		}),
		/Missing prompt template value: unknown/,
	);
	assert.throws(
		() => renderPromptTemplateString("use {{repositoryName}} and {{nested.value}}", {
			repositoryName: "repo",
		}),
		/Unresolved prompt template variable: \{\{nested\.value\}\}/,
	);
});

const evidence = {
	id: "e1",
	kind: "code" as const,
	summary: "Bounds check is after the indexed read.",
	filePath: "src/parser.c",
	line: 42,
	symbol: "parse_record",
	command: null,
	artifactPath: null,
	observation: "read happens before length validation",
	supports: ["candidate-claim"],
	contradicts: [],
	confidenceImpact: "raises confidence",
};

test("refined schemas keep module artifacts concise and require function context/evidence fields", () => {
	assert.equal(
		repositoryModuleSchema.safeParse({
			id: "tls-parser",
			moduleId: "tls-parser",
			name: "TLS Parser",
			summary: "Parser planning context",
			priority: 1,
			files: ["src/parser.c"],
			notes: [],
		}).success,
		false,
	);

	assert.equal(
		repositoryModuleSchema.safeParse({
			id: "tls-parser",
			moduleId: "tls-parser",
			name: "TLS Parser",
			summary: "Parser planning context",
			priority: 1,
			files: ["src/parser.c"],
			entryPoints: ["parse_record"],
			trustBoundaries: ["network"],
			attackSurfaces: ["TLS records"],
			vulnerabilityThemes: ["memory safety"],
			runtimeComponents: ["core library"],
			notes: [],
		}).success,
		true,
	);

	assert.equal(
		moduleSchema.safeParse({
			id: "tls-parser",
			moduleId: "tls-parser",
			name: "TLS Parser",
			summary: "Parser security model",
			priority: 1,
			files: ["src/parser.c"],
			entryPoints: ["parse_record"],
			trustBoundaries: ["network"],
			attackSurfaces: ["TLS records"],
			vulnerabilityThemes: ["memory safety"],
			runtimeComponents: ["core library"],
			notes: [],
		}).success,
		true,
	);

	assert.equal(
		moduleSchema.safeParse({
			id: "tls-parser",
			moduleId: "tls-parser",
			name: "TLS Parser",
			summary: "Parser security model",
			priority: 1,
			files: ["src/parser.c"],
			entryPoints: ["parse_record"],
			trustBoundaries: ["network"],
			attackSurfaces: ["TLS records"],
			vulnerabilityThemes: ["memory safety"],
			runtimeComponents: ["core library"],
			notes: [],
			functions: [
				{
					id: "parse_record",
					moduleId: "tls-parser",
					moduleName: "TLS Parser",
					functionId: "parse_record",
					functionName: "parse_record",
					filePath: "src/parser.c",
					line: 42,
					priority: 1,
					summary: "Parses a TLS record",
					vulnerabilityType: "out-of-bounds read",
					score: 7,
					role: "entry point",
					reachability: "reachable from network input",
					sourceToSinkHint: "record length to indexed read",
					excludeReason: null,
					priorityReason: "crosses the network trust boundary",
					securityModelRelation: "entry point and parser boundary",
					attackSurface: "TLS records",
					trustBoundary: "network",
					likelyVulnerabilityTypes: ["out-of-bounds read"],
				},
			],
		}).success,
		false,
	);

	assert.equal(
		candidateSchema.safeParse({
			id: "c1",
			functionId: "parse_record",
			title: "Unchecked record length read",
			description: "Potential out-of-bounds read.",
			filePath: "src/parser.c",
			line: 42,
			vulnerabilityType: "out-of-bounds read",
			confidence: 0.5,
			score: 7,
			claim: "record length can drive an indexed read before validation",
			rootCauseKey: "late-length-check",
			evidence: [evidence],
			attackerControl: "network record length",
			affectedSink: "indexed buffer read",
			preconditions: ["malformed record reaches parser"],
			quickDisproofAttempt: "looked for earlier length check",
			needsFuzzing: true,
			needsManualAnalysis: true,
		}).success,
		true,
	);
});

test("Stage Graph prompt templates stay concise while delegating detail to skills", () => {
	const repositoryPrompt = renderPromptTemplateString(
		readFileSync(join(scanDir, "prompts", "repository-profile.prompt.md"), "utf-8"),
		{
			taskIsolation: "isolate",
			repositoryId: "repo",
			repositoryName: "wolfSSL",
			targetRef: "master",
			targetTag: "<none>",
			targetCommit: "abc",
			agentInstruction: "Use codex.",
			repositoryStatePath: "/task/00_repository_state.json",
		},
	);
	assert.match(repositoryPrompt, /repository-profile skill/);
	assert.match(repositoryPrompt, /entryPoints, trustBoundaries, attackSurfaces, vulnerabilityThemes, and runtimeComponents/);
	assert.match(repositoryPrompt, /Produce at least 4 modules/);
	assert.match(repositoryPrompt, /Large repositories may produce more than 20 modules/);
	assert.doesNotMatch(repositoryPrompt, /attackerControlledInputs/);
	assert.doesNotMatch(repositoryPrompt, /dangerousSinks/);

	const repositorySkill = readSkillSource("repository-profile");
	assert.match(repositorySkill, /downstream generic vulnerability mining/i);
	assert.match(repositorySkill, /runtime and security-relevant boundaries/i);
	assert.match(repositorySkill, /HTTP, RPC, CLI, webhook, queue, worker/i);
	assert.doesNotMatch(repositorySkill, /securityModel/);
	assert.doesNotMatch(repositorySkill, /dangerousSinks/);

	const scanTargetPrompt = renderPromptTemplateString(
		readFileSync(join(scanDir, "prompts", "scan-target.prompt.md"), "utf-8"),
		{
			taskIsolation: "isolate",
			scanJobId: "job",
			moduleId: "api",
			moduleName: "API",
			targetId: "api-user-get",
			targetName: "GET /api/users/:id",
			targetKind: "route-handler",
			vulnerabilityClassFocus: "authorization bypass",
			targetFile: "src/routes/users.ts",
			targetLine: 12,
			targetSummary: "User lookup route",
			repositoryJsonPath: "/task/inputs/repository.json",
			moduleJsonPath: "/task/inputs/module.json",
			threatModelJsonPath: "/task/inputs/module-threat-model.json",
			targetJsonPath: "/task/inputs/target.json",
			thinkingInstruction: "",
		},
	);
	assert.match(scanTargetPrompt, /scan-target skill/);
	assert.match(scanTargetPrompt, /target_kind: route-handler/);
	assert.doesNotMatch(scanTargetPrompt, /vulnerability_class_focus/);
	assert.match(scanTargetPrompt, /all concrete, security-relevant vulnerability candidates/);
	assert.doesNotMatch(scanTargetPrompt, /function_json_path/);

	const scanTargetSkill = readSkillSource("scan-target");
	assert.match(scanTargetSkill, /route registration, middleware/i);
	assert.match(scanTargetSkill, /all applicable security classes/i);
	assert.doesNotMatch(scanTargetSkill, /one assigned vulnerability class/i);
});

test("built-in V3 prompts leave output protocol generation to runtime", () => {
	const forbiddenPromptFragments = [
		/route mapping:/i,
		/always route back/i,
		/output\.schema\.json/i,
		/set (?:the )?(?:route|exit) to/i,
		/write .*output\.json/i,
		/selected object type must match the selected route/i,
	];

	for (const template of loadBuiltinPipelineTemplates()) {
		const parsed = parsePipelineDocumentV3(template.yaml);
		assert.ok(parsed.document, `${template.kind} template should parse`);
		for (const [stageId, stage] of Object.entries(parsed.document.stages)) {
			const prompt = stage.runtime?.prompt ?? "";
			for (const fragment of forbiddenPromptFragments) {
				assert.doesNotMatch(
					prompt,
					fragment,
					`${template.kind}/${stageId} contains generated output protocol text`,
				);
			}
		}
	}
});

test("every Stage Graph prompt template renders without unresolved variables", () => {
	for (const directory of ["prompts", "stages"]) {
		for (const fileName of readdirSync(join(scanDir, directory)).filter((file) =>
			file.endsWith(".prompt.md"),
		)) {
			const template = readFileSync(
				join(scanDir, directory, fileName),
				"utf-8",
			);
			const values = Object.fromEntries(
				[...template.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => [
					match[1],
					"test-value",
				]),
			);
			const rendered = renderPromptTemplateString(template, values);
			assert.doesNotMatch(rendered, /\{\{/);
		}
	}
});

test("review stage prompts reference the Stage Graph skill names", () => {
	const expectedSkills = {
		"analyze-finding.prompt.md": "analyze-finding",
		"critique-finding.prompt.md": "critique-finding",
		"verify-finding.prompt.md": "verify-finding",
		"triage-finding.prompt.md": "triage-finding",
	};
	for (const [fileName, skillName] of Object.entries(expectedSkills)) {
		const prompt = readStagePromptTemplate(fileName);
		assert.match(prompt, new RegExp(`skills/${skillName}/SKILL\\.md`));
		assert.doesNotMatch(prompt, /skills\/(?:analyze|criticize|verify)\/SKILL\.md/);
	}
});

test("delta scope prompt and schema stay limited to repository and functions", () => {
	assert.equal(
		deltaScopeManifestSchema.safeParse({
			repository: "/task/repository.json",
			functions: ["/task/functions/parse_record.json"],
		}).success,
		true,
	);
	assert.equal(
		deltaScopeManifestSchema.safeParse({
			repository: "/task/repository.json",
			functions: [],
		}).success,
		true,
	);
	assert.equal(
		deltaScopeManifestSchema.safeParse({
			repository: "/task/repository.json",
			module: "/task/module.json",
			functions: [],
		}).success,
		false,
	);

	const deltaScopePrompt = renderPromptTemplateString(
		readFileSync(join(scanDir, "prompts", "scan-delta-scope.prompt.md"), "utf-8"),
		{
			taskIsolation: "isolate",
			repositoryId: "repo",
			repositoryName: "wolfSSL",
			targetRef: "master",
			targetTag: "<none>",
			targetCommit: "abc",
			baseCommit: "def",
			commitWindow: 3,
			agentInstruction: "Use codex.",
			repositoryStatePath: "/task/00_repository_state.json",
		},
	);
	assert.match(deltaScopePrompt, /delta-scope as your working method/);
	assert.match(
		deltaScopePrompt,
		/\$VULSEEK_AGENT_HOME\/skills\/delta-scope\/SKILL\.md/,
	);
	assert.match(deltaScopePrompt, /repository/);
	assert.match(deltaScopePrompt, /functions/);
	assert.match(deltaScopePrompt, /Produce one logical Delta Scope module artifact/);
	assert.match(deltaScopePrompt, /required repository artifact/);

	const deltaScopeSkill = readSkillSource("delta-scope");
	assert.match(deltaScopeSkill, /impact scoping only/i);
	assert.match(deltaScopeSkill, /Do not write module artifacts/i);
	assert.match(deltaScopeSkill, /functions/);
});

test("stage boundary manifests use task artifact paths instead of object lists", () => {
	assert.equal(
		repositoryProfileManifestSchema.safeParse({
			repository: "/task/repository.json",
			modules: ["/task/modules/tls.json"],
		}).success,
		true,
	);
	assert.equal(
		repositoryProfileManifestSchema.safeParse({
			repository: "/task/repository.json",
			modules: [
				{
					id: "tls",
					moduleId: "tls",
					name: "TLS",
				},
			],
		}).success,
		false,
	);
	assert.equal(
		scanTargetManifestSchema.safeParse({
			candidates: ["/task/candidates/c1.json"],
		}).success,
		true,
	);
	assert.equal(
		scanTargetManifestSchema.safeParse({
			candidates: ["candidates/c1.json"],
		}).success,
		false,
	);
	assert.equal(
		targetSchema.safeParse({
			id: "api-user-get",
			moduleId: "api",
			moduleName: "API",
			targetId: "api-user-get",
			targetName: "GET /api/users/:id",
			targetKind: "route-handler",
			language: "TypeScript",
			framework: "Express",
			sourceFiles: ["src/routes/users.ts"],
			filePath: "src/routes/users.ts",
			line: 12,
			routePath: "/api/users/:id",
			httpMethods: ["GET"],
			priority: 1,
			summary: "User lookup route",
			attackerInputs: ["params.id"],
			sinks: ["database query"],
			trustBoundary: "HTTP request to app",
			likelyVulnerabilityTypes: ["IDOR"],
			evidence: ["Route parameter controls user lookup"],
			score: 0.7,
			excludeReason: null,
			priorityReason: "Externally reachable route",
		}).success,
		true,
	);
});

test("structured output prompts delegate schema details to the validator skill", () => {
	const suffix = buildStructuredOutputPromptSuffix(
		repositoryProfileManifestSchema,
		"/task/output.schema.json",
		"/task/output.json",
	);
	assert.match(suffix, /read \/task\/output\.schema\.json/);
	assert.match(suffix, /output-validator\/validate_output\.py/);
	assert.match(suffix, /exactly three fields/);
	assert.match(suffix, /route=null/);
	assert.doesNotMatch(suffix, /Task artifact JSON schemas/);
	assert.doesNotMatch(suffix, /```json/);
	assert.doesNotMatch(suffix, /runtimeDirectories/);

	const persistentSuffix = buildStructuredOutputPromptSuffix(
		scanTargetManifestSchema,
		"/task/output.schema.json",
		"/task/output.json",
		undefined,
		{ allowAgentExit: false },
	);
	assert.match(persistentSuffix, /set exit=false/);
	assert.doesNotMatch(persistentSuffix, /exit=true only/);

	const analysisExitSuffix = buildStructuredOutputPromptSuffix(
		scanTargetManifestSchema,
		"/task/output.schema.json",
		"/task/output.json",
		undefined,
		{ allowAgentExit: true },
	);
	assert.match(analysisExitSuffix, /exit=true only/);
});

test("structured output schema carries route metadata and artifact schemas", () => {
	const artifactContract = createJsonSchemaContract({
		schemas: { Module: { type: "object", properties: { moduleId: { type: "string" } } } },
		schema: {
			type: "object",
			properties: {
				modules: {
					type: "array",
					items: { $pathOf: "#/schemas/Module", description: "Module artifact paths." },
				},
			},
		},
	});
	const suffix = buildStructuredOutputPromptSuffix(
		artifactContract,
		"/task/output.schema.json",
		"/task/output.json",
	);

	assert.match(suffix, /output-validator\/validate_output\.py/);
	assert.doesNotMatch(suffix, /moduleId/);
	assert.doesNotMatch(suffix, /"\\$pathOf"/);

	const schema = buildStructuredOutputEnvelopeJsonSchema(
		artifactContract,
		[
			{
				routeKey: "continue",
				description: "Continue reviewing the current item.",
				schema: artifactContract,
				default: true,
			},
		],
	) as Record<string, unknown>;
	assert.deepEqual(schema["x-vulseek-routes"], [
		{ key: "continue", description: "Continue reviewing the current item.", default: true },
	]);
	assert.deepEqual(schema["x-vulseek-artifacts"], [
		{
			route: "continue",
			path: "output.modules[]",
			kind: "path_list",
			schemaRef: "#/definitions/vulseek_artifact_0",
		},
	]);
});

test("property descriptions survive schema normalization and output envelopes", () => {
	const contract = createJsonSchemaContract({
		schemas: {
			Finding: {
				type: "object",
				properties: {
					title: {
						type: "string",
						description: "Short finding title.",
					},
				},
			},
		},
		schema: {
			type: "object",
			properties: {
				finding: { $ref: "#/schemas/Finding" },
			},
		},
	});

	const normalizedFinding = (
		(contract.schema.properties as Record<string, unknown>).finding as Record<string, unknown>
	);
	const normalizedTitle = (
		(normalizedFinding.properties as Record<string, unknown>).title as Record<string, unknown>
	);
	assert.equal(normalizedTitle.description, "Short finding title.");

	const envelope = buildStructuredOutputEnvelopeJsonSchema(contract) as Record<string, unknown>;
	const envelopeProperties = envelope.properties as Record<string, unknown>;
	const envelopeOutput = envelopeProperties.output as Record<string, unknown>;
	const envelopeOutputProperties = envelopeOutput.properties as Record<string, unknown>;
	const envelopeFinding = envelopeOutputProperties.finding as Record<string, unknown>;
	const envelopeFindingProperties = envelopeFinding.properties as Record<string, unknown>;
	const envelopeTitle = envelopeFindingProperties.title as Record<string, unknown>;
	assert.equal(envelopeTitle.description, "Short finding title.");
});

test("analysis prompt removes fuzz routing", () => {
	const analysisPromptTemplate = readStagePromptTemplate("analyze-finding.prompt.md");
	assert.match(analysisPromptTemplate, /Analyze Finding/);
	assert.doesNotMatch(analysisPromptTemplate, /build_fuzzer/);
	assert.match(analysisPromptTemplate, /verification/);
	assert.match(analysisPromptTemplate, /Do not request fuzzer construction/);

	const deepAnalysisSkill = readSkillSource("analyze-finding");
	assert.match(deepAnalysisSkill, /analyze-finding and critique-finding workflow/);
	assert.match(deepAnalysisSkill, /does not route to fuzzer construction/);
});

test("verification is a three-value sanity check and triage owns security classification", () => {
	const verificationPromptTemplate = readStagePromptTemplate("verify-finding.prompt.md");
	assert.match(
		verificationPromptTemplate,
		/Set result to the JSON string "true", "likely", or "false"\./,
	);
	assert.match(
		verificationPromptTemplate,
		/Do not return boolean true\/false\./,
	);

	const baseVerification = {
		id: "verify-1",
		summary: "The code path and precondition exist.",
		confidence: 0.8,
		score: 0.8,
		reportPath: "/task/01_verify_report.md",
		runtimeSeconds: null,
		evidenceBundle: [evidence],
		residualUncertainty: [],
		status: "completed" as const,
	};

	assert.equal(
		verificationSchema.safeParse({
			...baseVerification,
			result: "true",
		}).success,
		true,
	);
	assert.equal(
		verificationSchema.safeParse({
			...baseVerification,
			result: "likely",
		}).success,
		true,
	);
	assert.equal(
		verificationSchema.safeParse({
			...baseVerification,
			result: "false",
		}).success,
		true,
	);
	assert.equal(
		verificationSchema.safeParse({
			...baseVerification,
			result: "real_vulnerability",
		}).success,
		false,
	);

	const baseTriage = {
		id: "triage-1",
		result: "security_issue",
		disqualifier: null,
		disqualifierReason: null,
		securityClassification: "vulnerability",
		isSecurityIssue: true,
		impactType: "memory corruption",
		cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
		cvssScore: 9.8,
		cvssSeverity: "critical",
		exploitability: "practical",
		isExploitable: true,
		commonTriggerConditions: ["malformed network record reaches parser"],
		hardeningOrRobustness: false,
		epssProbability30d: 0.02,
		epssSource: "heuristic:no-cve-mapping",
		summary: "Security issue with network trigger.",
		reportPath: "/task/01_triage_report.md",
		runtimeSeconds: null,
		evidenceBundle: [evidence],
		residualUncertainty: [],
		status: "completed",
	};

	assert.equal(triageSchema.safeParse(baseTriage).success, true);

	assert.equal(
		triageSchema.safeParse({
			...baseTriage,
			result: "non_security",
			disqualifier: "D-5",
			disqualifierReason:
				"Caller violates the documented API ownership contract.",
			securityClassification: "non_security",
			isSecurityIssue: false,
			cvssVector: null,
			cvssScore: null,
			cvssSeverity: "none",
			exploitability: "none",
			isExploitable: false,
			hardeningOrRobustness: true,
		}).success,
		true,
	);
});
