import { randomUUID } from "node:crypto";
import crypto from "node:crypto";

export const createShortTaskId = () =>
	randomUUID().replace(/-/g, "").slice(0, 8);

export const createTaskIdForDispatchKey = (dispatchKey: string) =>
	`d${crypto.createHash("sha256").update(dispatchKey).digest("hex").slice(0, 15)}`;

export const createTaskIdForSource = (input: {
	sourceMessageId: string;
	sourceEdgeName: string;
	sourceItemIndex: number;
}) =>
	createTaskIdForDispatchKey(
		[input.sourceMessageId, input.sourceEdgeName, String(input.sourceItemIndex)].join(
			":",
		),
	);
