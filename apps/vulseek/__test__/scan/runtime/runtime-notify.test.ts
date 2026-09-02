import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendStdinJsonLine } from "../../../../../packages/server/src/services/scan/runtime/agent-runtime-files";
import {
	buildRuntimeNotify,
	runtimeNotifyPromptText,
} from "../../../../../packages/server/src/services/scan/runtime/runtime-notify";

describe("runtime notify", () => {
	it("builds a count-only stdin payload", () => {
		expect(buildRuntimeNotify(3)).toEqual({
			type: "runtime_notify",
			messageCount: 3,
		});
		expect(runtimeNotifyPromptText(3)).toBe(
			"Inbound message count changed to 3.",
		);
	});

	it("appends notify lines without a full message payload", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "runtime-notify-"));
		const stdinPath = path.join(dir, "stdin");
		await appendStdinJsonLine(stdinPath, buildRuntimeNotify(1));
		await appendStdinJsonLine(stdinPath, buildRuntimeNotify(2));
		expect(await readFile(stdinPath, "utf-8")).toBe(
			`${JSON.stringify({ type: "runtime_notify", messageCount: 1 })}\n${JSON.stringify({ type: "runtime_notify", messageCount: 2 })}\n`,
		);
	});
});
