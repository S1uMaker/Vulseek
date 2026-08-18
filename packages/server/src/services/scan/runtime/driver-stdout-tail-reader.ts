import { open, stat } from "node:fs/promises";
import type {
	DriverStdoutEvent,
	DriverTaskEvent,
	ParsedDriverStdout,
} from "./driver-stdout-protocol";
import { parseDriverStdout } from "./driver-stdout-protocol";

type TailEntry = {
	identity: string;
	offset: number;
	mtimeMs: number;
	mtimeNs: string;
	ctimeNs: string;
	size: number;
	remainder: string;
	parsed: ParsedDriverStdout;
	inFlight?: Promise<ParsedDriverStdout>;
};

const emptyParsed = (): ParsedDriverStdout => ({
	events: [],
	latestActivity: null,
	activityRevision: 0,
	activityEvents: [],
	latestUsage: null,
	latestTask: null,
	latestLog: null,
	exitCode: null,
	invalidLineCount: 0,
});

const applyEvent = (parsed: ParsedDriverStdout, event: DriverStdoutEvent) => {
	switch (event.type) {
		case "activity":
			parsed.latestActivity = event.activity ?? null;
			parsed.activityRevision += 1;
			parsed.activityEvents.push({
				revision: parsed.activityRevision,
				activity: event.activity ?? null,
			});
			if (parsed.activityEvents.length > 256) parsed.activityEvents.shift();
			break;
		case "usage":
			parsed.latestUsage = event.usage ?? null;
			break;
		case "task_start":
		case "task_done":
			parsed.latestTask = event as DriverTaskEvent;
			break;
		case "log":
			parsed.latestLog = event;
			break;
		case "exit":
			parsed.exitCode =
				typeof event.code === "number" && Number.isFinite(event.code)
					? event.code
					: null;
			break;
	}
};

const identityFor = (value: { dev: bigint | number; ino: bigint | number }) =>
	`${value.dev}:${value.ino}`;

export class DriverStdoutTailReader {
	private readonly entries = new Map<string, TailEntry>();

	async read(filePath: string): Promise<ParsedDriverStdout> {
		const existing = this.entries.get(filePath);
		if (existing?.inFlight) return existing.inFlight;
		const promise = this.readInternal(filePath, existing);
		if (existing) existing.inFlight = promise;
		else {
			const placeholder = {
				identity: "",
					offset: 0,
					mtimeMs: 0,
					mtimeNs: "0",
					ctimeNs: "0",
				size: 0,
				remainder: "",
				parsed: emptyParsed(),
				inFlight: promise,
			};
			this.entries.set(filePath, placeholder);
		}
		try {
			return await promise;
		} finally {
			const entry = this.entries.get(filePath);
			if (entry?.inFlight === promise) entry.inFlight = undefined;
		}
	}

	reset(filePath: string) {
		this.entries.delete(filePath);
	}

	delete(filePath: string) {
		this.entries.delete(filePath);
	}

	private async readInternal(
		filePath: string,
		existing?: TailEntry,
	): Promise<ParsedDriverStdout> {
		const fileStat = await stat(filePath, { bigint: true }).catch(() => null);
		if (!fileStat || !fileStat.isFile()) {
			this.entries.delete(filePath);
			return emptyParsed();
		}

		const fileSize = Number(fileStat.size);
		const fileMtimeMs = Number(fileStat.mtimeMs);
		const identity = identityFor(fileStat);
		const rebuiltAtSameSize =
			existing !== undefined &&
			fileStat.ctimeNs.toString() !== existing.ctimeNs &&
			fileSize <= existing.offset;
		const needsReset =
			!existing ||
			existing.identity !== identity ||
			fileSize < existing.offset ||
			(fileStat.mtimeNs.toString() !== existing.mtimeNs && fileSize <= existing.offset) ||
			rebuiltAtSameSize;
		const entry: TailEntry = needsReset
			? {
					identity,
					offset: 0,
					mtimeMs: fileMtimeMs,
					mtimeNs: fileStat.mtimeNs.toString(),
					ctimeNs: fileStat.ctimeNs.toString(),
					size: 0,
					remainder: "",
					parsed: emptyParsed(),
				}
			: existing;

		if (
			!needsReset &&
			fileSize === entry.size &&
			fileStat.mtimeNs.toString() === entry.mtimeNs
		) {
			return entry.parsed;
		}

		const start = entry.offset;
		const length = Math.max(0, fileSize - start);
		if (length > 0) {
			const handle = await open(filePath, "r");
			try {
				const buffer = Buffer.alloc(length);
				const result = await handle.read(buffer, 0, length, start);
				const text = `${entry.remainder}${buffer.toString("utf8", 0, result.bytesRead)}`;
				const lines = text.split("\n");
				entry.remainder = lines.pop() ?? "";
				for (const line of lines) {
					const parsedLine = parseDriverStdout(line);
					entry.parsed.invalidLineCount += parsedLine.invalidLineCount;
					for (const event of parsedLine.events) applyEvent(entry.parsed, event);
				}
				entry.offset = start + result.bytesRead;
			} finally {
				await handle.close();
			}
		}
		entry.identity = identity;
		entry.mtimeMs = fileMtimeMs;
		entry.mtimeNs = fileStat.mtimeNs.toString();
		entry.ctimeNs = fileStat.ctimeNs.toString();
		entry.size = fileSize;
		this.entries.set(filePath, entry);
		return entry.parsed;
	}
}

export const driverStdoutTailReader = new DriverStdoutTailReader();
