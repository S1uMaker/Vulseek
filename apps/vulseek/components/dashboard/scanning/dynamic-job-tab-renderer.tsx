import type { PipelineJobTab } from "@vulseek/server/services/scan/pipeline/document-v3";
import { ScanJobCandidatesTab } from "./scan-job-candidates-tab";
import { JobTabEntityTable } from "./job-tab-entity-table";
import { isTerminalScanJobStatus } from "./scan-i18n";
import { useScanJobDetail } from "./scan-job-detail-context";

export const DynamicJobTabRenderer = ({
	tab,
}: {
	tab: PipelineJobTab;
}) => {
	const ctx = useScanJobDetail();
	if (tab.renderer === "candidate-results") {
		return (
			<ScanJobCandidatesTab
				scanJobId={ctx.scanJobId}
				candidates={ctx.candidates}
				isLoadingCandidates={ctx.isLoadingCandidates}
				isFetchingCandidates={ctx.isFetchingCandidates}
				candidatePagination={ctx.candidatePagination}
				candidateQuery={ctx.candidateQuery}
				onSearchChange={ctx.onSearchChange}
				analysisFilters={ctx.analysisFilters}
				onAnalysisFilterToggle={ctx.onAnalysisFilterToggle}
				onClearAnalysisFilters={ctx.onClearAnalysisFilters}
				verifyFilters={ctx.verifyFilters}
				onVerifyFilterToggle={ctx.onVerifyFilterToggle}
				onClearVerifyFilters={ctx.onClearVerifyFilters}
				triageFilters={ctx.triageFilters}
				onTriageFilterToggle={ctx.onTriageFilterToggle}
				onClearTriageFilters={ctx.onClearTriageFilters}
				onToggleCandidateSort={ctx.onToggleCandidateSort}
				candidatePageSize={ctx.candidatePageSize}
				onPageSizeChange={ctx.onPageSizeChange}
				onPageChange={ctx.onPageChange}
				buildCandidateDetailHref={ctx.buildCandidateDetailHref}
				onCandidateLinkClick={ctx.onCandidateLinkClick}
				reanalyzingCandidateId={ctx.reanalyzingCandidateId}
				onReanalyzeCandidate={(candidate) => {
					void ctx.onReanalyzeCandidate(candidate);
				}}
			/>
		);
	}
	return (
		<JobTabEntityTable
			scanJobId={ctx.scanJobId}
			tab={tab}
			live={!isTerminalScanJobStatus(ctx.scanJob?.status)}
		/>
	);
};
