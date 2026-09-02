import { promises as fs } from "node:fs";

/** Keep the latest window of a JSONL/text log, dropping a split first line. */
export const clipLatestText = (content: string, maxChars: number) => {
	if (maxChars <= 0) return "";
	if (content.length <= maxChars) return content;
	const sliced = content.slice(content.length - maxChars);
	const newline = sliced.indexOf("\n");
	if (newline === -1) return sliced;
	return sliced.slice(newline + 1);
};

export type FileStreamBufferEvent =
	| {
			type: "snapshot";
			content: string;
			offset: number;
			reason: "init" | "reset" | "missing";
	  }
	| {
			type: "append";
			content: string;
			offset: number;
	  };

type FileStreamBufferSubscriber = (event: FileStreamBufferEvent) => void;

type FileStreamBufferSnapshot = {
	content: string;
	offset: number;
};

class FileStreamBuffer {
	private readonly filePath: string;
	private readonly pollIntervalMs: number;
	private readonly maxContentChars: number | null;
	private content = "";
	private offset = 0;
	private tail = Buffer.alloc(0);
	private initialized = false;
	private initializing: Promise<void> | null = null;
	private syncing = false;
	private pollTimer: NodeJS.Timeout | null = null;
	private readonly subscribers = new Set<FileStreamBufferSubscriber>();

	constructor(
		filePath: string,
		pollIntervalMs: number,
		maxContentChars: number | null = null,
	) {
		this.filePath = filePath;
		this.pollIntervalMs = pollIntervalMs;
		this.maxContentChars = maxContentChars;
	}

	private clipStoredContent() {
		if (this.maxContentChars == null) return;
		this.content = clipLatestText(this.content, this.maxContentChars);
	}

	private notify(event: FileStreamBufferEvent) {
		for (const subscriber of this.subscribers) {
			try {
				subscriber(event);
			} catch {}
		}
	}

	private async loadEntireFile(reason: "init" | "reset" | "missing") {
		const stat = await fs.stat(this.filePath).catch(() => null);
		if (!stat) {
			this.content = "";
			this.offset = 0;
			this.tail = Buffer.alloc(0);
			this.initialized = true;
			if (reason !== "init") {
				this.notify({
					type: "snapshot",
					content: "",
					offset: 0,
					reason,
				});
			}
			return;
		}

		const maxBytes = this.maxContentChars;
		if (maxBytes != null && stat.size > maxBytes) {
			const handle = await fs.open(this.filePath, "r");
			try {
				const buffer = Buffer.alloc(maxBytes);
				await handle.read(buffer, 0, maxBytes, stat.size - maxBytes);
				let text = buffer.toString("utf-8");
				const newline = text.indexOf("\n");
				if (newline >= 0) text = text.slice(newline + 1);
				this.content = text;
				this.offset = stat.size;
				this.tail = buffer.subarray(Math.max(0, buffer.length - 4096));
			} finally {
				await handle.close();
			}
		} else {
			const content = await fs.readFile(this.filePath, "utf-8");
			const bytes = Buffer.from(content, "utf-8");
			this.content = content;
			this.offset = bytes.length;
			this.tail = bytes.subarray(Math.max(0, bytes.length - 4096));
			this.clipStoredContent();
		}
		this.initialized = true;
		if (reason !== "init") {
			this.notify({
				type: "snapshot",
				content: this.content,
				offset: this.offset,
				reason,
			});
		}
	}

	async ensureInitialized() {
		if (this.initialized) {
			return;
		}

		if (this.initializing) {
			await this.initializing;
			return;
		}

		// On first access after process start, rebuild in-memory state
		// from the current on-disk file contents before switching to tail mode.
		this.initializing = this.loadEntireFile("init").finally(() => {
			this.initializing = null;
		});
		await this.initializing;
	}

	async getSnapshot(): Promise<FileStreamBufferSnapshot> {
		await this.ensureInitialized();
		return {
			content: this.content,
			offset: this.offset,
		};
	}

	private startPolling() {
		if (this.pollTimer) {
			return;
		}
		this.pollTimer = setInterval(() => {
			void this.sync();
		}, this.pollIntervalMs);
	}

	private stopPollingIfIdle() {
		if (this.subscribers.size > 0 || !this.pollTimer) {
			return;
		}
		clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	getSubscriberCount() {
		return this.subscribers.size;
	}

	dispose() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.subscribers.clear();
		this.content = "";
		this.offset = 0;
		this.tail = Buffer.alloc(0);
		this.initialized = false;
		this.initializing = null;
		this.syncing = false;
	}

	subscribe(subscriber: FileStreamBufferSubscriber) {
		this.subscribers.add(subscriber);
		this.startPolling();
		return () => {
			this.subscribers.delete(subscriber);
			this.stopPollingIfIdle();
		};
	}

	async sync() {
		if (this.syncing) {
			return;
		}

		this.syncing = true;
		try {
			await this.ensureInitialized();
			const stat = await fs.stat(this.filePath).catch(() => null);
			if (!stat) {
				if (this.content !== "" || this.offset !== 0) {
					this.content = "";
					this.offset = 0;
					this.tail = Buffer.alloc(0);
					this.notify({
						type: "snapshot",
						content: "",
						offset: 0,
						reason: "missing",
					});
				}
				return;
			}

			// Treat shrink as truncate/overwrite/log rotation and rebuild from disk.
			if (stat.size < this.offset) {
				await this.loadEntireFile("reset");
				return;
			}

			// A producer can truncate and rewrite past the previous offset between
			// polls. Verify the bytes immediately before that offset so this cannot
			// be mistaken for an append.
			if (this.offset > 0 && this.tail.length > 0) {
				const length = Math.min(this.tail.length, this.offset);
				const handle = await fs.open(this.filePath, "r");
				let matches = false;
				try {
					const diskTail = Buffer.alloc(length);
					const { bytesRead } = await handle.read(
						diskTail,
						0,
						length,
						this.offset - length,
					);
					matches =
						bytesRead === length &&
						diskTail.equals(this.tail.subarray(this.tail.length - length));
				} finally {
					await handle.close();
				}
				if (!matches) {
					await this.loadEntireFile("reset");
					return;
				}
			}

			if (stat.size === this.offset) {
				return;
			}

			const handle = await fs.open(this.filePath, "r");
			try {
				const length = stat.size - this.offset;
				const buffer = Buffer.alloc(length);
				await handle.read(buffer, 0, length, this.offset);
				const delta = buffer.toString("utf-8");
				this.content += delta;
				this.offset = stat.size;
				this.tail = Buffer.concat([this.tail, buffer]).subarray(-4096);
				this.clipStoredContent();
				this.notify({
					type: "append",
					content: delta,
					offset: this.offset,
				});
			} finally {
				await handle.close();
			}
		} finally {
			this.syncing = false;
		}
	}
}

const fileStreamBuffers = new Map<string, FileStreamBuffer>();

export const getFileStreamBuffer = (
	filePath: string,
	options?: {
		pollIntervalMs?: number;
		maxContentChars?: number;
	},
) => {
	const existing = fileStreamBuffers.get(filePath);
	if (existing) {
		return existing;
	}

	const created = new FileStreamBuffer(
		filePath,
		options?.pollIntervalMs ?? 1000,
		options?.maxContentChars ?? null,
	);
	fileStreamBuffers.set(filePath, created);
	return created;
};

export const clearFileStreamBuffer = (
	filePath: string,
	options?: {
		onlyIfIdle?: boolean;
	},
) => {
	const existing = fileStreamBuffers.get(filePath);
	if (!existing) {
		return false;
	}
	const onlyIfIdle = options?.onlyIfIdle ?? true;
	if (onlyIfIdle && existing.getSubscriberCount() > 0) {
		return false;
	}
	existing.dispose();
	fileStreamBuffers.delete(filePath);
	return true;
};
