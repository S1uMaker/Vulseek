export class ScanRuntimeApiError extends Error {
	status: number;
	code?: string;
	current?: unknown;

	constructor(
		status: number,
		message: string,
		options?: { code?: string; current?: unknown },
	) {
		super(message);
		this.name = "ScanRuntimeApiError";
		this.status = status;
		this.code = options?.code;
		this.current = options?.current;
	}
}
