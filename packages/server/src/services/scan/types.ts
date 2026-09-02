import type { messages, scanJobs, tasks } from "@vulseek/server/db/schema";
import type {
	Analysis,
	Evidence,
	Triage,
	Verification,
} from "./artifacts/contracts/domain-object.contract";

export type {
	Analysis,
	Candidate,
	CriticResponse,
	DeltaScopeManifest,
	Evidence,
	FinalAnalysis,
	Function,
	IdentifyTargetManifest,
	Module,
	ModuleThreatModel,
	ModuleThreatModelManifest,
	Repository,
	RepositoryModule,
	RepositoryProfileManifest,
	ScanTargetManifest,
	Target,
	Triage,
	Verification,
} from "./artifacts/contracts/domain-object.contract";

export type ScanJob = Omit<
	typeof scanJobs.$inferSelect,
	"datasetEvaluationTrialId"
> & {
	datasetEvaluationTrialId?: string | null;
	inputTokens: number;
	outputTokens: number;
	thoughtTokens: number;
	totalTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
	estimatedCost?: number | null;
	repositoryTaskId: string | null;
	repositoryTaskStatus: typeof tasks.$inferSelect.status;
};
export type Task = typeof tasks.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type VulnerabilityCandidate = {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	producerTaskId: string;
	messageId: string | null;
	producerStageName: string;
	functionId: string | null;
	title: string;
	description: string | null;
	filePath: string | null;
	line: number | null;
	vulnerabilityType: string | null;
	confidence: number | null;
	score: number | null;
	targetId: string | null;
	targetKind: string | null;
	claim: string;
	rootCauseKey: string | null;
	evidence: Evidence[];
	attackerControl: string | null;
	affectedSink: string | null;
	preconditions: string[];
	quickDisproofAttempt: string | null;
	needsFuzzing: boolean;
	needsManualAnalysis: boolean;
	note: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
};
export type AnalysisResult = {
	taskId: string;
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId: string;
	result: Analysis["result"];
	confidence: number | null;
	score: number | null;
	reportPath: string | null;
	runtimeSeconds: number | null;
	threadId: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
	status?: typeof tasks.$inferSelect.status;
};
export type VerificationResult = {
	taskId: string;
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId: string;
	result: Verification["result"];
	confidence: number | null;
	score: number | null;
	reportPath: string | null;
	runtimeSeconds: number | null;
	threadId: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
	status?: typeof tasks.$inferSelect.status;
};

export type TriageResult = {
	taskId: string;
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId: string;
	result: Triage["result"];
	disqualifier: Triage["disqualifier"];
	disqualifierReason: string | null;
	securityClassification: Triage["securityClassification"];
	isSecurityIssue: boolean;
	impactType: string;
	cvssVector: string | null;
	cvssScore: number | null;
	cvssSeverity: Triage["cvssSeverity"];
	exploitability: Triage["exploitability"];
	isExploitable: boolean | null;
	commonTriggerConditions: string[];
	hardeningOrRobustness: boolean;
	epssProbability30d: number | null;
	epssSource: string;
	confidence: number | null;
	score: number | null;
	reportPath: string | null;
	runtimeSeconds: number | null;
	threadId: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
	status?: typeof tasks.$inferSelect.status;
};

export type ScanCandidateQueueJob = {
	scanJobId: string;
	vulnerabilityCandidateId: string;
};

export type AgentProfileLike = {
	agentProfileId: string;
	name: string;
	provider: "codex" | "claude_code" | "grok_build";
	authMode: "api_key" | "host_home";
	homePath: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	thinkingLevel: string;
	thinkingLevelEnabled: boolean;
	envs: string;
	isEnabled: boolean;
};
