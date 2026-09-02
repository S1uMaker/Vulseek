export type DriverStdoutEvent = {
	type: string;
	[key: string]: unknown;
};

export type DriverTaskEvent = DriverStdoutEvent & {
	type: "task_start" | "task_done";
	taskId?: string;
	status?: "completed" | "cancelled" | "failed";
	stopReason?: string;
};

export type DriverTurnDoneEvent = DriverStdoutEvent & {
	type: "turn_done";
	threadId?: string | null;
	taskId?: string | null;
	turnIndex?: number;
};

export type ParsedDriverStdout = {
	events: DriverStdoutEvent[];
	latestActivity: unknown | null;
	activityRevision: number;
	activityEvents: Array<{ revision: number; activity: unknown }>;
	latestUsage: unknown | null;
	latestTurnDone: DriverTurnDoneEvent | null;
	latestTask: DriverTaskEvent | null;
	latestLog: DriverStdoutEvent | null;
	exitCode: number | null;
	invalidLineCount: number;
};

const EVENT_TYPES = new Set([
	"start",
	"thread",
	"activity",
	"usage",
	"turn_done",
	"task_start",
	"task_done",
	"log",
	"exit",
]);

const isEvent = (value: unknown): value is DriverStdoutEvent =>
	Boolean(
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as { type?: unknown }).type === "string" &&
		EVENT_TYPES.has((value as { type: string }).type),
	);

export const parseDriverStdout = (content: string): ParsedDriverStdout => {
	const parsed: ParsedDriverStdout = {
		events: [],
		latestActivity: null,
		activityRevision: 0,
		activityEvents: [],
		latestUsage: null,
		latestTurnDone: null,
		latestTask: null,
		latestLog: null,
		exitCode: null,
		invalidLineCount: 0,
	};

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			parsed.invalidLineCount += 1;
			continue;
		}
		if (!isEvent(value)) continue;
		parsed.events.push(value);
		switch (value.type) {
			case "activity":
				parsed.latestActivity = value.activity ?? null;
				parsed.activityRevision += 1;
				parsed.activityEvents.push({
					revision: parsed.activityRevision,
					activity: value.activity ?? null,
				});
				if (parsed.activityEvents.length > 256) parsed.activityEvents.shift();
				break;
			case "usage":
				parsed.latestUsage = value.usage ?? null;
				break;
			case "turn_done":
				parsed.latestTurnDone = value as DriverTurnDoneEvent;
				break;
			case "task_start":
			case "task_done":
				parsed.latestTask = value as DriverTaskEvent;
				break;
			case "log":
				parsed.latestLog = value;
				break;
			case "exit":
				parsed.exitCode =
					typeof value.code === "number" && Number.isFinite(value.code)
						? value.code
						: null;
				break;
		}
	}

	return parsed;
};

export const readLatestDriverStdoutEvent = (
	content: string,
	type: DriverStdoutEvent["type"],
) => {
	const events = parseDriverStdout(content).events;
	return [...events].reverse().find((event) => event.type === type) || null;
};
