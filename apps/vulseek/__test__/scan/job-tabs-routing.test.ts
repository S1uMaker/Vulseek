import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL_PATH = "components/dashboard/scanning/show-scan-job-detail.tsx";
const CONTEXT_PATH = "components/dashboard/scanning/scan-job-detail-context.tsx";

const readSource = (path: string) =>
	readFileSync(join(process.cwd(), path), "utf8");

describe("job tab routing", () => {
	it("writes the selected tab to the shallow URL query (context controller)", () => {
		const contextSource = readSource(CONTEXT_PATH);
		const handlerStart = contextSource.indexOf("handleTabChange: (value) =>");
		const handlerSource = contextSource.slice(
			handlerStart,
			contextSource.indexOf("jobTabs,", handlerStart),
		);

		expect(handlerSource).toContain("const nextTab = value as ScanJobTab;");
		expect(handlerSource).toContain("setActiveTab(nextTab);");
		expect(handlerSource).toContain("router.replace(");
		expect(handlerSource).toContain("applyCandidateListQueryState(");
		expect(handlerSource).toContain("nextTab,");
		expect(handlerSource).toContain("shallow: true");
	});

	it("shell delegates tab changes to the context controller", () => {
		const shellSource = readSource(SHELL_PATH);
		const tabsValue = shellSource.indexOf("value={activeTab}");
		const tabsStart = shellSource.lastIndexOf("<Tabs", tabsValue);
		const tabsSource = shellSource.slice(
			tabsStart,
			shellSource.indexOf("</Tabs>", tabsStart),
		);

		expect(tabsSource).toContain("onValueChange={handleTabChange}");
	});

	it("builds dataset-navigation task hrefs through navigation.taskHref", () => {
		const contextSource = readSource(CONTEXT_PATH);
		const taskHrefStart = contextSource.indexOf("const buildTaskDetailHref");
		const taskHrefSource = contextSource.slice(
			taskHrefStart,
			contextSource.indexOf("const handleCandidateLinkClick", taskHrefStart),
		);

		expect(taskHrefSource).toContain("navigation");
		expect(taskHrefSource).toContain("navigation.taskHref(scanJobId, taskId)");
		expect(taskHrefSource).toContain("candidateListPageBasePath");
	});

	it("builds dataset-navigation candidate hrefs through navigation.candidateHref", () => {
		const contextSource = readSource(CONTEXT_PATH);
		const candidateHrefStart = contextSource.indexOf(
			"const buildCandidateDetailHref",
		);
		const candidateHrefSource = contextSource.slice(
			candidateHrefStart,
			contextSource.indexOf("const buildTaskDetailHref", candidateHrefStart),
		);

		expect(candidateHrefSource).toContain("navigation.candidateHref(");
		expect(candidateHrefSource).toContain("candidateListPageBasePath");
	});
});
