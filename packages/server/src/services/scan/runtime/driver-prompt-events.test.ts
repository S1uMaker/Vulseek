import assert from "node:assert/strict";
import test from "node:test";
import {
	DriverPromptEventParser,
	parseDriverPromptEvents,
} from "./driver-prompt-events";

const promptLine = (text: string, promptId = "prompt-1") =>
	JSON.stringify({
		type: "vulseek_prompt",
		promptId,
		taskId: "task-1",
		sessionId: "thread-1",
		turnIndex: 1,
		timestamp: "2026-08-24T00:00:00.000Z",
		text,
	});

test("parses prompt events from arbitrary chunks and preserves byte offsets", () => {
	const parser = new DriverPromptEventParser();
	const line = `${promptLine("Inspect 测试")}\n`;
	const split = line.indexOf("试");

	assert.deepEqual(parser.push(line.slice(0, split)), []);
	const events = parser.push(line.slice(split));

	assert.equal(events.length, 1);
	assert.equal(events[0]?.text, "Inspect 测试");
	assert.equal(events[0]?.offset, Buffer.byteLength(line, "utf8"));
});

test("ignores malformed and non-prompt driver events", () => {
	const content = [
		"not json",
		JSON.stringify({ type: "activity", activity: { kind: "thinking" } }),
		promptLine("Prompt"),
	].join("\n");

	assert.deepEqual(parseDriverPromptEvents(content).map((event) => event.text), [
		"Prompt",
	]);
});

test("does not emit an incomplete prompt until it is completed", () => {
	const parser = new DriverPromptEventParser();
	const line = promptLine("Complete me");

	assert.deepEqual(parser.push(line.slice(0, -1)), []);
	assert.equal(parser.push(`${line.slice(-1)}\n`)[0]?.text, "Complete me");
});
