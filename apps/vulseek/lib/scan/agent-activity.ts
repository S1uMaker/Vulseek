export type AgentActivityKind =
	| "waiting"
	| "prompt"
	| "goal"
	| "reasoning"
	| "writing"
	| "planning"
	| "tool"
	| "web"
	| "command"
	| "completed"
	| "cancelled"
	| "error";

export type AgentActivity = {
	kind: AgentActivityKind;
	label: string;
	detail?: string;
	toolCallId?: string;
	goal?: AgentGoalSnapshot | null;
	timestamp?: string;
};

export type AgentGoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "limited"
	| "complete";

export type AgentGoalSnapshot = {
	objective: string;
	status: AgentGoalStatus;
	controlMethod: "_session/goal";
	iterations?: number;
	lastReason?: string | null;
	createdAt?: number;
	updatedAt?: number;
	tokenBudget?: number | null;
	tokensUsed?: number;
	timeUsedSeconds?: number;
};

export type AgentActivitySnapshot = {
	version: 1;
	revision: number;
	taskId: string | null;
	sessionId: string | null;
	status: string;
	activity: AgentActivity;
	updatedAt: string;
};

export type AgentActivityMetadata = {
	taskId: string;
	scanJobId: string;
	taskKind: string;
	containerName?: string | null;
	provider?: "codex" | "claude";
	status?: string;
	sessionId?: string | null;
};

export const idleAgentActivity: AgentActivity = {
	kind: "waiting",
	label: "Idle",
};
