import { handleMessagesHttp } from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
	}
	const result = await handleMessagesHttp({
		method: req.method,
		headers: req.headers,
		body: req.body,
	});
	return res.status(result.status).json(result.body);
};
