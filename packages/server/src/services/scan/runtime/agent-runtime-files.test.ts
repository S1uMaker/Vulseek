import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initializeAgentRuntimeFiles } from "./agent-runtime-files";

test("initializes the shared driver stdin and stdout artifacts", async () => {
	const runtimeDir = await mkdtemp(path.join(tmpdir(), "agent-runtime-files-"));
	await initializeAgentRuntimeFiles(runtimeDir);
	assert.deepEqual((await readdir(runtimeDir)).sort(), ["stdin", "stdout"]);
	assert.equal(await readFile(path.join(runtimeDir, "stdout"), "utf-8"), "");
});
