export type ToolsImageStatusLike = {
	exists: boolean;
	state: "missing" | "ready" | "building" | "failed";
	imageTag: string;
};

export type CheckoutImageStatusLike = {
	exists: boolean;
	current: boolean;
	imageTag: string;
};

export type RunPipelineImageWarning = {
	id: string;
	key: string;
	defaultValue: string;
	values?: Record<string, string>;
};

export const buildRunPipelineImageWarnings = (input: {
	tools?: ToolsImageStatusLike | null;
	checkout?: CheckoutImageStatusLike | null;
	loading?: boolean;
}): RunPipelineImageWarning[] => {
	if (input.loading) {
		return [];
	}
	const warnings: RunPipelineImageWarning[] = [];
	if (!input.tools || input.tools.state === "missing" || !input.tools.exists) {
		warnings.push({
			id: "tools-missing",
			key: "scan.dialog.toolsImageMissing",
			defaultValue:
				"The current tools image is missing or outdated ({{imageTag}}). Build or rebuild it before running, or the scan may fail.",
			values: { imageTag: input.tools?.imageTag || "unavailable" },
		});
	} else if (input.tools.state === "building") {
		warnings.push({
			id: "tools-building",
			key: "scan.dialog.toolsImageBuilding",
			defaultValue:
				"The tools image is still building ({{imageTag}}). Wait for the build to finish before starting a scan.",
			values: { imageTag: input.tools.imageTag },
		});
	} else if (input.tools.state === "failed") {
		warnings.push({
			id: "tools-failed",
			key: "scan.dialog.toolsImageFailed",
			defaultValue:
				"The latest tools image build failed ({{imageTag}}). Rebuild it before running a scan.",
			values: { imageTag: input.tools.imageTag },
		});
	}
	if (!input.checkout?.exists) {
		warnings.push({
			id: "checkout-missing",
			key: "scan.dialog.checkoutImageMissing",
			defaultValue:
				"The checkout image is missing ({{imageTag}}). Checkout this target before running, or the scan may fail.",
			values: { imageTag: input.checkout?.imageTag || "unavailable" },
		});
	} else if (!input.checkout.current) {
		warnings.push({
			id: "checkout-stale",
			key: "scan.dialog.checkoutImageStale",
			defaultValue:
				"The checkout image is out of date relative to the current tools image ({{imageTag}}). Recheckout is recommended.",
			values: { imageTag: input.checkout.imageTag },
		});
	}
	return warnings;
};
