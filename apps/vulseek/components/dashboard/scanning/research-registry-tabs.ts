export type ResearchRegistryTab =
	| "findings"
	| "tracks"
	| "primitives"
	| "chains";

const RESEARCH_REGISTRY_TABS = [
	{ value: "findings", label: "Findings" },
	{ value: "tracks", label: "Tracks" },
	{ value: "primitives", label: "Primitives" },
	{ value: "chains", label: "Chains" },
] as const;

export const getResearchRegistryTabs = (
	kind: string | null | undefined,
) => (kind === "research" ? RESEARCH_REGISTRY_TABS : []);

export const isResearchRegistryTab = (
	value: string | null | undefined,
): value is ResearchRegistryTab =>
	RESEARCH_REGISTRY_TABS.some((tab) => tab.value === value);
