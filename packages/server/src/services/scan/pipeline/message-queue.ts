export type MessageQueueJob = {
	messageId: string;
	edgeName: string;
	itemIndex: number;
};

export type StageQueueJob = { type: "message" } & MessageQueueJob;

export const buildMessageQueueJobId = (
	queueName: string,
	job: MessageQueueJob,
) => `${queueName}:${job.messageId}:${job.edgeName}:${job.itemIndex}`;

export const serializeMessageQueueJob = (job: MessageQueueJob) =>
	JSON.stringify({
		type: "message",
		messageId: job.messageId,
		edgeName: job.edgeName,
		itemIndex: job.itemIndex,
	});

export const QUEUE_JOB_PAGE_SIZE = 200;

export const listAllQueueJobs = async <T>(
	queue: {
		getJobs(
			types: string[],
			start?: number,
			end?: number,
			asc?: boolean,
		): Promise<T[]>;
	},
	states: string[],
	pageSize = QUEUE_JOB_PAGE_SIZE,
) => {
	const jobs: T[] = [];
	let start = 0;
	for (;;) {
		const page = await queue.getJobs(
			states,
			start,
			start + pageSize - 1,
			true,
		);
		jobs.push(...page);
		if (page.length < pageSize) {
			break;
		}
		start += pageSize;
	}
	return jobs;
};

const parseMessageQueueRecord = (
	record: Record<string, unknown>,
): StageQueueJob | null => {
	if (record.type != null && record.type !== "message") {
		return null;
	}
	if (
		typeof record.messageId !== "string" ||
		typeof record.edgeName !== "string"
	) {
		return null;
	}
	const itemIndex =
		typeof record.itemIndex === "number" ? record.itemIndex : 0;
	return {
		type: "message",
		messageId: record.messageId,
		edgeName: record.edgeName,
		itemIndex,
	};
};

export const parseStageQueueJob = (data: unknown): StageQueueJob | null => {
	if (data && typeof data === "object" && !Array.isArray(data)) {
		return parseMessageQueueRecord(data as Record<string, unknown>);
	}
	if (typeof data !== "string" || !data.trim()) {
		return null;
	}
	const trimmed = data.trim();
	if (!trimmed.startsWith("{")) {
		return null;
	}
	try {
		return parseStageQueueJob(JSON.parse(trimmed) as unknown);
	} catch {
		return null;
	}
};

export const asWaitingMessageQueueJob = (data: unknown) =>
	parseStageQueueJob(data);

export const shouldLaunchStageTask = (input: {
	persistent: boolean;
	activeCount: number;
	concurrency: number;
}) => {
	if (input.activeCount >= input.concurrency) {
		return false;
	}
	if (input.persistent && input.activeCount > 0) {
		return false;
	}
	return true;
};
