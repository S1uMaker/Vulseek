export type DriverPromptEvent = {
	type: "vulseek_prompt";
	promptId: string;
	taskId: string | null;
	sessionId: string | null;
	turnIndex: number;
	timestamp: string;
	text: string;
};

export type DriverPromptEventWithOffset = DriverPromptEvent & {
	offset: number;
};

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

const parsePromptLine = (line: string): DriverPromptEvent | null => {
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return null;
		}
		const event = value as Partial<DriverPromptEvent>;
		if (
			event.type !== "vulseek_prompt" ||
			typeof event.promptId !== "string" ||
			typeof event.turnIndex !== "number" ||
			!Number.isInteger(event.turnIndex) ||
			typeof event.timestamp !== "string" ||
			typeof event.text !== "string" ||
			(event.taskId !== null && typeof event.taskId !== "string") ||
			(event.sessionId !== null && typeof event.sessionId !== "string")
		) {
			return null;
		}
		return {
			type: "vulseek_prompt",
			promptId: event.promptId,
			taskId: event.taskId ?? null,
			sessionId: event.sessionId ?? null,
			turnIndex: event.turnIndex,
			timestamp: event.timestamp,
			text: event.text,
		};
	} catch {
		return null;
	}
};

export class DriverPromptEventParser {
	private remainder = "";
	private offset = 0;

	reset(offset = 0) {
		this.remainder = "";
		this.offset = offset;
	}

	push(chunk: string): DriverPromptEventWithOffset[] {
		if (!chunk) return [];
		const previousRemainder = this.remainder;
		const combined = `${previousRemainder}${chunk}`;
		const combinedStart = this.offset - byteLength(previousRemainder);
		const lines = combined.split("\n");
		this.remainder = lines.pop() ?? "";
		this.offset += byteLength(chunk);

		let cursor = 0;
		const events: DriverPromptEventWithOffset[] = [];
		for (const line of lines) {
			const lineBytes = byteLength(line) + 1;
			const event = parsePromptLine(line.trim());
			if (event) {
				events.push({
					...event,
					offset: combinedStart + cursor + lineBytes,
				});
			}
			cursor += lineBytes;
		}
		return events;
	}

	finish(): DriverPromptEventWithOffset[] {
		if (!this.remainder) return [];
		const line = this.remainder;
		this.remainder = "";
		const event = parsePromptLine(line.trim());
		return event
			? [{ ...event, offset: this.offset }]
			: [];
	}
}

export const parseDriverPromptEvents = (
	content: string,
): DriverPromptEventWithOffset[] => {
	const parser = new DriverPromptEventParser();
	const events = parser.push(content);
	return [...events, ...parser.finish()];
};
