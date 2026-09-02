import {
	completeMessagesForRequest,
	queryMessagesForRequest,
	ScanRuntimeApiError,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";

const readHeader = (req: NextApiRequest, name: string) => {
	const value = req.headers[name];
	if (Array.isArray(value)) {
		return value[0] ?? null;
	}
	return value ?? null;
};

const readQuery = (req: NextApiRequest, name: string) => {
	const value = req.query[name];
	if (Array.isArray(value)) {
		return value[0] ?? null;
	}
	return value ?? null;
};

const readMessageIds = (body: unknown) => {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return [];
	}
	const record = body as { messageIds?: unknown; taskIds?: unknown };
	const messageIds = Array.isArray(record.messageIds)
		? record.messageIds
		: [];
	return messageIds.map((item) => String(item));
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET" && req.method !== "POST") {
		res.setHeader("Allow", "GET, POST");
		return res.status(405).json({ ok: false, error: "Method not allowed" });
	}

	try {
		const identity = {
			authorization: readHeader(req, "authorization"),
			scanJobId: readHeader(req, "x-vulseek-scan-job-id"),
			taskId: readHeader(req, "x-vulseek-task-id"),
			stageName: readQuery(req, "stage"),
		};
		if (req.method === "GET") {
			return res.status(200).json(await queryMessagesForRequest(identity));
		}
		return res.status(200).json(
			await completeMessagesForRequest({
				...identity,
				messageIds: readMessageIds(req.body),
			}),
		);
	} catch (error) {
		if (error instanceof ScanRuntimeApiError) {
			return res.status(error.status).json({
				ok: false,
				error: error.message,
			});
		}
		return res.status(500).json({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
