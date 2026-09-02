export class ScanRuntimeApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ScanRuntimeApiError";
		this.status = status;
	}
};
