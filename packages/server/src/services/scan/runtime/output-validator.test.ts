import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runtimeDir = dirname(fileURLToPath(import.meta.url));
const validatorPath = join(
	runtimeDir,
	"../../../../../../agents/skills/output-validator/validate_output.py",
);

const schema = {
	type: "object",
	properties: {
		route: { type: "null" },
		exit: { type: "boolean", const: false },
		output: {
			type: "object",
			properties: { artifactPath: { type: "string" } },
			required: ["artifactPath"],
			additionalProperties: false,
		},
	},
	required: ["route", "exit", "output"],
	additionalProperties: false,
	definitions: {
		artifact: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	"x-vulseek-artifacts": [
		{
			route: null,
			path: "output.artifactPath",
			kind: "path",
			schemaRef: "#/definitions/artifact",
		},
	],
};

const runValidator = async (root: string, schemaPath: string, outputPath: string) =>
	execFileAsync("python3", [validatorPath, "--schema", schemaPath, "--output", outputPath], {
		env: { ...process.env, VULSEEK_TASK_ROOT: root },
	});

test("output-validator accepts a valid envelope and referenced artifact", async () => {
	const root = await mkdtemp(join(tmpdir(), "vulseek-output-validator-"));
	try {
		const schemaPath = join(root, "output.schema.json");
		const artifactPath = join(root, "artifact.json");
		const outputPath = join(root, "output.json");
		await writeFile(schemaPath, JSON.stringify(schema));
		await writeFile(artifactPath, JSON.stringify({ id: "artifact-1" }));
		await writeFile(
			outputPath,
			JSON.stringify({
				route: null,
				exit: false,
				output: { artifactPath: "/task/artifact.json" },
			}),
		);

		const result = await runValidator(root, schemaPath, outputPath);
		assert.match(result.stdout, /output validation passed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("output-validator rejects invalid envelope and artifact content", async () => {
	const root = await mkdtemp(join(tmpdir(), "vulseek-output-validator-"));
	try {
		const schemaPath = join(root, "output.schema.json");
		const artifactPath = join(root, "artifact.json");
		const outputPath = join(root, "output.json");
		await writeFile(schemaPath, JSON.stringify(schema));
		await writeFile(artifactPath, JSON.stringify({ id: 7 }));
		await writeFile(
			outputPath,
			JSON.stringify({
				route: "unexpected",
				exit: false,
				output: { artifactPath: "/task/artifact.json" },
			}),
		);

		await assert.rejects(
			runValidator(root, schemaPath, outputPath),
			(error: Error & { stderr?: string }) =>
				/error|failed/i.test(error.stderr ?? error.message),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("output-validator skill files are present", async () => {
	const skillPath = join(dirname(validatorPath), "SKILL.md");
	assert.match(await readFile(skillPath, "utf8"), /output-validator/);
});
