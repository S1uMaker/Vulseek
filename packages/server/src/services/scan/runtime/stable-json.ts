const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((key) => [
					key,
					canonicalize((value as Record<string, unknown>)[key]),
				]),
		);
	}
	return value;
};

export const stableJsonStringify = (value: unknown) =>
	JSON.stringify(canonicalize(value));

export const stableJsonEqual = (left: unknown, right: unknown) =>
	stableJsonStringify(left) === stableJsonStringify(right);
