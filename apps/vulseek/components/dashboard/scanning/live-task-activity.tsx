import { Activity } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useRef, useState } from "react";
import { AgentStream } from "@/components/dashboard/scanning/agent-stream";
import { SseAgentStreamTransport } from "@/components/dashboard/scanning/agent-stream-transport";
import { useAgentActivity } from "@/components/dashboard/scanning/use-agent-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { AgentActivity } from "@/lib/scan/agent-activity";
import { scanT } from "./scan-i18n";

const getActivityBadgeClassName = (kind: string) => {
	if (kind === "web") {
		return "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/50 dark:text-sky-100";
	}
	if (kind === "tool" || kind === "command" || kind === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100";
	}
	if (kind === "usage" || kind === "result") {
		return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-500/60 dark:bg-slate-900/70 dark:text-slate-100";
	}
	if (kind === "reasoning" || kind === "planning") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	if (kind === "writing") {
		return "border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-500/60 dark:bg-violet-950/50 dark:text-violet-100";
	}
	if (kind === "error") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}
	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

export const LiveTaskActivity = ({
	taskId,
	title,
	subtitle,
	activity,
	isConnected,
	viewButtonVariant = "secondary",
	viewButtonSize = "sm",
	iconOnlyViewButton = false,
}: {
	taskId: string;
	title: string;
	subtitle?: string | null;
	activity?: AgentActivity;
	isConnected?: boolean;
	viewButtonVariant?: "default" | "secondary" | "outline" | "ghost";
	viewButtonSize?: "default" | "sm" | "lg" | "icon";
	iconOnlyViewButton?: boolean;
}) => {
	const liveActivity = useAgentActivity({
		taskId,
		enabled: !!taskId && !activity,
	});
	const resolvedActivity = activity || liveActivity.activity;
	const resolvedIsConnected = isConnected ?? liveActivity.isConnected;

	return (
		<div className="flex min-w-0 items-start justify-between gap-3">
			<LiveTaskActivityBadge
				activity={resolvedActivity}
				isConnected={resolvedIsConnected}
			/>
			<LiveTaskActivityButton
				taskId={taskId}
				title={title}
				subtitle={subtitle}
				activity={resolvedActivity}
				variant={viewButtonVariant}
				size={viewButtonSize}
				iconOnly={iconOnlyViewButton}
			/>
		</div>
	);
};

export const LiveTaskActivityBadge = ({
	taskId,
	activity,
	isConnected,
	noWrap = false,
}: {
	taskId?: string;
	activity?: AgentActivity;
	isConnected?: boolean;
	noWrap?: boolean;
}) => {
	const { t } = useTranslation("scan");
	const liveActivity = useAgentActivity({
		taskId: taskId || "",
		enabled: !!taskId && !activity,
	});
	const resolvedActivity = activity || liveActivity.activity;
	const resolvedIsConnected = isConnected ?? liveActivity.isConnected;

	return (
		<div className="min-w-0 flex-1">
			<div
				className={
					noWrap
						? "flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden"
						: "flex flex-wrap items-center gap-2"
				}
			>
				{resolvedIsConnected ? (
					<span
						title={scanT(t, "scan.activity.live", "Live")}
						className="relative flex h-2 w-2 shrink-0"
					>
						<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
						<span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
					</span>
				) : null}
				<Badge
					variant="outline"
					className={`${getActivityBadgeClassName(resolvedActivity.kind)}${noWrap ? " min-w-0 max-w-full truncate" : ""}`}
				>
					{resolvedActivity.label}
				</Badge>
			</div>
		</div>
	);
};

export const LiveTaskActivityButton = ({
	taskId,
	title,
	subtitle,
	activity,
	variant = "secondary",
	size = "sm",
	iconOnly = false,
	className,
}: {
	taskId: string;
	title: string;
	subtitle?: string | null;
	activity?: AgentActivity;
	variant?: "default" | "secondary" | "outline" | "ghost";
	size?: "default" | "sm" | "lg" | "icon";
	iconOnly?: boolean;
	className?: string;
}) => {
	const { t } = useTranslation("scan");
	const [isOpen, setIsOpen] = useState(false);
	const transportRef = useRef<SseAgentStreamTransport | null>(null);
	const liveActivity = useAgentActivity({
		taskId,
		enabled: !!taskId && !activity,
	});
	const resolvedActivity = activity || liveActivity.activity;
	if (!transportRef.current) {
		transportRef.current = new SseAgentStreamTransport(
			`/api/scan/tasks/${encodeURIComponent(taskId)}/agent-stream`,
		);
	}

	return (
		<>
			<Button
				type="button"
				variant={variant}
				size={size}
				className={className}
				disabled={!taskId}
				title={scanT(t, "scan.activity.viewOutput", "View agent output")}
				aria-label={scanT(t, "scan.activity.viewOutput", "View agent output")}
				onClick={(event) => {
					event.stopPropagation();
					setIsOpen(true);
				}}
			>
				<Activity className={iconOnly ? "size-4" : "mr-2 size-4"} />
				{iconOnly ? null : scanT(t, "scan.activity.view", "View")}
			</Button>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogContent className="sm:max-w-7xl">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							{subtitle ||
								scanT(
									t,
									"scan.activity.operations",
									"Native agent session activity",
								)}
						</DialogDescription>
					</DialogHeader>
					<div className="mb-3 flex flex-wrap items-center gap-2">
						<Badge
							variant="outline"
							className={getActivityBadgeClassName(resolvedActivity.kind)}
						>
							{resolvedActivity.label}
						</Badge>
						<span className="text-xs text-muted-foreground">
							{scanT(
								t,
								"scan.activity.nativeTranscript",
								"Native agent transcript",
							)}
						</span>
					</div>
					{transportRef.current ? (
						<AgentStream transport={transportRef.current} />
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
};
