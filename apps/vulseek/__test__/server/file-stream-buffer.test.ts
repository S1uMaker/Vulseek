import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearFileStreamBuffer,
	clipLatestText,
	getFileStreamBuffer,
} from "@/server/utils/file-stream-buffer";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("clipLatestText", () => {
	it("keeps the latest window and drops a split first line", () => {
		expect(clipLatestText("abc", 10)).toBe("abc");
		expect(clipLatestText("keep-me\n", 8)).toBe("keep-me\n");
		expect(clipLatestText("old-line\nnew-line\n", 10)).toBe("new-line\n");
	});
});

describe("FileStreamBuffer", () => {
	it("publishes only the appended bytes for a normal append", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "file-stream-buffer-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		await writeFile(filePath, "one\n");
		const buffer = getFileStreamBuffer(filePath, { pollIntervalMs: 60_000 });
		await buffer.getSnapshot();
		const events: Array<{ type: string; content: string }> = [];
		const unsubscribe = buffer.subscribe((event) => events.push(event));

		await writeFile(filePath, "one\ntwo\n");
		await buffer.sync();

		expect(events).toEqual([{ type: "append", content: "two\n", offset: 8 }]);
		unsubscribe();
		clearFileStreamBuffer(filePath);
	});

	it("rebuilds a snapshot when a truncate and rewrite grows past the old offset", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "file-stream-buffer-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		await writeFile(filePath, "old-record\n");
		const buffer = getFileStreamBuffer(filePath, { pollIntervalMs: 60_000 });
		await buffer.getSnapshot();
		const events: Array<{ type: string; content: string }> = [];
		const unsubscribe = buffer.subscribe((event) => events.push(event));

		await writeFile(filePath, "new-record-longer\n");
		await buffer.sync();

		expect(events).toEqual([
			{
				type: "snapshot",
				content: "new-record-longer\n",
				offset: 18,
				reason: "reset",
			},
		]);
		unsubscribe();
		clearFileStreamBuffer(filePath);
	});

	it("keeps only the latest window when maxContentChars is set", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "file-stream-buffer-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		await writeFile(filePath, "old-record\nkeep-me\n");
		const buffer = getFileStreamBuffer(filePath, {
			pollIntervalMs: 60_000,
			maxContentChars: 10,
		});
		const snapshot = await buffer.getSnapshot();
		expect(snapshot.content).toBe("keep-me\n");
		expect(snapshot.offset).toBeGreaterThan(snapshot.content.length);
		clearFileStreamBuffer(filePath);
	});
});
