import {
	applyNodeChanges,
	Background,
	BaseEdge,
	Controls,
	type Edge,
	EdgeLabelRenderer,
	type EdgeProps,
	type EdgeTypes,
	Handle,
	MarkerType,
	type Node,
	type NodeChange,
	type NodeProps,
	type NodeTypes,
	Position,
	ReactFlow,
	useReactFlow,
} from "@xyflow/react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "next-i18next";
import type {
	CSSProperties,
	ReactNode,
	PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, type RouterOutputs } from "@/utils/api";
import { formatScanStageLabel, scanT } from "./scan-i18n";

export type StageGraph = RouterOutputs["scan"]["jobPipeline"];
type QueueCount = RouterOutputs["scan"]["jobQueueCounts"]["queues"][number];
type StageGraphNode = StageGraph["nodes"][number];
type StageGraphEdge = StageGraph["edges"][number];
type VisibleStageGraphEdge = StageGraphEdge & { routeLabels: string[] };
type RuntimeStageSetting = {
	disabled?: boolean;
	concurrency?: number | null;
	agentProfileId?: string | null;
};
export type ScanRuntimeSettingsDraft = {
	stages?: Record<string, RuntimeStageSetting>;
};
type PreviewAgentProfiles = RouterOutputs["ai"]["getAgentProfiles"] | undefined;
type PreviewServiceData = Record<string, unknown> | null | undefined;
type FullScanStageGraphTarget =
	| {
			applicationId: string;
			composeId?: never;
			pipelineId: string;
	  }
	| {
			composeId: string;
			applicationId?: never;
			pipelineId: string;
	  };
type StageFlowNodeData = Record<string, unknown> & {
	label: ReactNode;
	stageNode?: StageGraphNode;
};
type StageFlowNode = Node<StageFlowNodeData, "stage">;
type EdgePointMoveHandler = (
	edgeId: string,
	pointIndex: number,
	point: Point,
) => void;
type ElkSectionEdgeData = Record<string, unknown> & {
	points: Point[];
	kind?: "forward" | "local-loop" | "rework";
	label?: string;
	onPointMove?: EdgePointMoveHandler;
};
type ElkSectionEdge = Edge<ElkSectionEdgeData, "elkSection">;
type Side = "top" | "right" | "bottom" | "left";
type Point = { x: number; y: number };

const NODE_WIDTH = 220;
const NODE_HEIGHT = 92;
const GROUP_PADDING_X = 34;
const GROUP_PADDING_BOTTOM = 64;
const GROUP_LABEL_HEIGHT = 40;
const GROUP_NODE_TOP = GROUP_LABEL_HEIGHT + 20;
const GRAPH_PADDING = 28;
const NODE_GAP_X = 92;
const NODE_GAP_Y = 104;
const STAGES_PER_ROW = 4;
const BACK_EDGE_OFFSET_Y = 28;
const FORWARD_LONG_EDGE_OFFSET_Y = 30;
const SELF_EDGE_OFFSET_X = 56;
const SELF_EDGE_OFFSET_Y = 38;
const RESEARCH_LEFT_X = GRAPH_PADDING + 12;
const RESEARCH_RIGHT_X = RESEARCH_LEFT_X + 200;
const RESEARCH_CENTER_X = RESEARCH_LEFT_X + 220;
const RESEARCH_LEFT_REVIEW_X = RESEARCH_LEFT_X + NODE_WIDTH + 170;
const RESEARCH_RIGHT_REVIEW_X = RESEARCH_RIGHT_X + NODE_WIDTH + 170;
const RESEARCH_REWORK_RAIL_X = RESEARCH_RIGHT_REVIEW_X + NODE_WIDTH + 118;
const RESEARCH_SCOPE_Y = GRAPH_PADDING + 12;
const RESEARCH_SURFACE_Y = RESEARCH_SCOPE_Y + 130;
const RESEARCH_TRACK_PLAN_Y = RESEARCH_SURFACE_Y + 220;
const RESEARCH_DISCOVERY_Y = RESEARCH_TRACK_PLAN_Y + 130;
const RESEARCH_FINDING_Y = RESEARCH_DISCOVERY_Y + 230;
const RESEARCH_CHAIN_Y = RESEARCH_FINDING_Y + 230;
const RESEARCH_EXPLOIT_Y = RESEARCH_CHAIN_Y + 230;
const RESEARCH_REPORT_Y = RESEARCH_EXPLOIT_Y + 230;
const RESEARCH_STAGE_NAMES = {
	scope: "research-scope",
	surface: "surface-map",
	trackPlan: "track-plan",
	discovery: "vulnerability-discovery",
	trackReview: "track-review",
	findingValidation: "finding-validation",
	findingReview: "finding-review",
	chainSynthesis: "chain-synthesis",
	chainReview: "chain-review",
	exploitValidation: "exploit-validation",
	exploitReview: "exploit-review",
	report: "research-report",
} as const;
const RESEARCH_LOCAL_LOOPS = new Set<string>([
	`${RESEARCH_STAGE_NAMES.trackReview}->${RESEARCH_STAGE_NAMES.trackPlan}`,
	`${RESEARCH_STAGE_NAMES.findingReview}->${RESEARCH_STAGE_NAMES.findingValidation}`,
	`${RESEARCH_STAGE_NAMES.chainReview}->${RESEARCH_STAGE_NAMES.chainSynthesis}`,
	`${RESEARCH_STAGE_NAMES.exploitReview}->${RESEARCH_STAGE_NAMES.exploitValidation}`,
]);
const RESEARCH_REWORK_EDGES = new Set<string>([
	`${RESEARCH_STAGE_NAMES.trackReview}->${RESEARCH_STAGE_NAMES.surface}`,
	`${RESEARCH_STAGE_NAMES.findingReview}->${RESEARCH_STAGE_NAMES.trackPlan}`,
	`${RESEARCH_STAGE_NAMES.chainReview}->${RESEARCH_STAGE_NAMES.trackPlan}`,
	`${RESEARCH_STAGE_NAMES.chainReview}->${RESEARCH_STAGE_NAMES.findingValidation}`,
	`${RESEARCH_STAGE_NAMES.exploitReview}->${RESEARCH_STAGE_NAMES.chainSynthesis}`,
	`${RESEARCH_STAGE_NAMES.exploitReview}->${RESEARCH_STAGE_NAMES.findingValidation}`,
]);
const RESEARCH_MODULES = [
	{
		name: "scope",
		label: "Scope",
		stageNames: [RESEARCH_STAGE_NAMES.scope, RESEARCH_STAGE_NAMES.surface],
	},
	{
		name: "track-discovery",
		label: "Track Discovery",
		stageNames: [
			RESEARCH_STAGE_NAMES.trackPlan,
			RESEARCH_STAGE_NAMES.discovery,
			RESEARCH_STAGE_NAMES.trackReview,
		],
	},
	{
		name: "finding",
		label: "Finding",
		stageNames: [
			RESEARCH_STAGE_NAMES.findingValidation,
			RESEARCH_STAGE_NAMES.findingReview,
		],
	},
	{
		name: "chain",
		label: "Chain",
		stageNames: [
			RESEARCH_STAGE_NAMES.chainSynthesis,
			RESEARCH_STAGE_NAMES.chainReview,
		],
	},
	{
		name: "exploit",
		label: "Exploit",
		stageNames: [
			RESEARCH_STAGE_NAMES.exploitValidation,
			RESEARCH_STAGE_NAMES.exploitReview,
		],
	},
] as const;
const DEFAULT_PROFILE_VALUE = "__service_default__";
const REPOSITORY_STAGE_NAME = "repository-profile";
const DELTA_SCOPE_STAGE_NAME = "delta-scope";
const EMPTY_FLOW_ELEMENTS = {
	nodes: [] as Node[],
	edges: [] as Edge[],
};

const emptyStageCounts = () => ({
	waiting: 0,
	queued: 0,
	launching: 0,
	launched: 0,
	starting: 0,
	running: 0,
	completed: 0,
	failed: 0,
	exited: 0,
	total: 0,
	pending: 0,
});

const SIDE_POSITION = {
	top: Position.Top,
	right: Position.Right,
	bottom: Position.Bottom,
	left: Position.Left,
} satisfies Record<Side, Position>;

const HANDLE_STYLE = {
	width: 1,
	height: 1,
	minWidth: 1,
	minHeight: 1,
	border: 0,
	background: "transparent",
	opacity: 0,
	pointerEvents: "none",
} satisfies CSSProperties;

const asRuntimeStageSetting = (
	settings: ScanRuntimeSettingsDraft | null | undefined,
	stageName: string,
) => settings?.stages?.[stageName] ?? {};

const isRootRuntimeStage = (stageName: string) =>
	stageName === REPOSITORY_STAGE_NAME || stageName === DELTA_SCOPE_STAGE_NAME;

const getNodeRuntimeBoolean = (
	node: StageGraphNode,
	key: "disabled" | "effectiveDisabled",
) =>
	typeof (node as unknown as Record<string, unknown>)[key] === "boolean"
		? ((node as unknown as Record<string, boolean>)[key] ?? false)
		: false;

const buildEffectiveDisabledStageSet = (
	graph: StageGraph,
	settings?: ScanRuntimeSettingsDraft | null,
) => {
	const rootStageName =
		graph.nodes.find((node) => node.order === 0)?.stageName ||
		graph.nodes[0]?.stageName ||
		REPOSITORY_STAGE_NAME;
	const explicitDisabled = new Set<string>();
	for (const node of graph.nodes) {
		const disabled =
			asRuntimeStageSetting(settings, node.stageName).disabled === true ||
			getNodeRuntimeBoolean(node, "disabled");
		if (disabled && node.stageName !== rootStageName) {
			explicitDisabled.add(node.stageName);
		}
	}

	const bySource = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (
			explicitDisabled.has(edge.source) ||
			explicitDisabled.has(edge.target)
		) {
			continue;
		}
		bySource.set(edge.source, [
			...(bySource.get(edge.source) ?? []),
			edge.target,
		]);
	}

	const reachable = new Set<string>();
	const queue = [rootStageName];
	while (queue.length > 0) {
		const stageName = queue.shift();
		if (
			!stageName ||
			reachable.has(stageName) ||
			explicitDisabled.has(stageName)
		) {
			continue;
		}
		reachable.add(stageName);
		for (const next of bySource.get(stageName) ?? []) {
			if (!reachable.has(next)) {
				queue.push(next);
			}
		}
	}

	return new Set(
		graph.nodes
			.map((node) => node.stageName)
			.filter(
				(stageName) =>
					explicitDisabled.has(stageName) || !reachable.has(stageName),
			),
	);
};

const applyRuntimeSettingsToGraph = (
	graph: StageGraph | null | undefined,
	settings?: ScanRuntimeSettingsDraft | null,
	agentProfiles?: PreviewAgentProfiles,
): StageGraph | null | undefined => {
	if (!graph) {
		return graph;
	}
	const effectiveDisabled = buildEffectiveDisabledStageSet(graph, settings);
	const profileById = new Map(
		(agentProfiles ?? []).map((profile) => [
			profile.agentProfileId,
			asPreviewAgentProfile(profile),
		]),
	);
	return {
		...graph,
		nodes: graph.nodes.map((node) => {
			const setting = asRuntimeStageSetting(settings, node.stageName);
			const configuredAgentProfileId =
				setting.agentProfileId ??
				((node as unknown as Record<string, unknown>)
					.configuredAgentProfileId as string | null | undefined) ??
				null;
			const configuredConcurrency =
				typeof setting.concurrency === "number"
					? setting.concurrency
					: (((node as unknown as Record<string, unknown>)
							.configuredConcurrency as number | null | undefined) ?? null);
			const agentProfile =
				configuredAgentProfileId && profileById.get(configuredAgentProfileId)
					? profileById.get(configuredAgentProfileId)
					: node.agentProfile;
			return {
				...node,
				disabled: isRootRuntimeStage(node.stageName)
					? false
					: setting.disabled === true ||
						getNodeRuntimeBoolean(node, "disabled"),
				effectiveDisabled: effectiveDisabled.has(node.stageName),
				configuredConcurrency,
				configuredAgentProfileId,
				concurrencyLimit: configuredConcurrency ?? node.concurrencyLimit,
				agentProfile: agentProfile ?? node.agentProfile,
			};
		}),
	};
};

const StageNode = ({ data }: NodeProps<StageFlowNode>) => {
	return (
		<>
			{(Object.keys(SIDE_POSITION) as Side[]).flatMap((side) => [
				<Handle
					key={`source-${side}`}
					id={`source-${side}`}
					type="source"
					position={SIDE_POSITION[side]}
					isConnectable={false}
					style={HANDLE_STYLE}
				/>,
				<Handle
					key={`target-${side}`}
					id={`target-${side}`}
					type="target"
					position={SIDE_POSITION[side]}
					isConnectable={false}
					style={HANDLE_STYLE}
				/>,
			])}
			{data.label}
		</>
	);
};

const StageGroupNode = ({ data }: NodeProps<StageFlowNode>) => (
	<div className="pointer-events-none h-full w-full rounded-lg px-3 pt-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
		{data.label}
	</div>
);

const NODE_TYPES = {
	stage: StageNode,
	group: StageGroupNode,
} satisfies NodeTypes;

const buildSectionPath = (points: Point[]) => {
	if (points.length === 0) {
		return "";
	}
	const [firstPoint, ...nextPoints] = points;
	return [
		`M ${firstPoint?.x ?? 0} ${firstPoint?.y ?? 0}`,
		...nextPoints.map((point) => `L ${point.x} ${point.y}`),
	].join(" ");
};

const withFlowEdgeEndpoints = (
	points: Point[],
	sourcePoint: Point,
	targetPoint: Point,
) => {
	if (points.length <= 2) {
		return [sourcePoint, targetPoint];
	}
	return [sourcePoint, ...points.slice(1, -1), targetPoint];
};

const getEdgeLabelPoint = (
	points: Point[],
	kind?: ResearchEdgeKind,
): Point | null => {
	if (points.length < 2) {
		return null;
	}
	if (kind === "local-loop" && points.length >= 5) {
		const railStart = points[1];
		const railEnd = points[2];
		if (railStart && railEnd && railStart.x === railEnd.x) {
			return {
				x: railStart.x - 70,
				y: railStart.y + (railEnd.y - railStart.y) / 2,
			};
		}
	}

	const longestSegment = points
		.slice(1)
		.reduce<{ start: Point; end: Point; length: number } | undefined>(
			(longest, end, index) => {
				const start = points[index];
				if (!start) {
					return longest;
				}
				const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
				return !longest || length > longest.length
					? { start, end, length }
					: longest;
			},
			undefined,
		);
	return longestSegment
		? {
				x:
					longestSegment.start.x +
					(longestSegment.end.x - longestSegment.start.x) / 2,
				y:
					longestSegment.start.y +
					(longestSegment.end.y - longestSegment.start.y) / 2,
			}
		: null;
};

const ElkSectionEdgeComponent = ({
	data,
	id,
	markerEnd,
	sourceX,
	sourceY,
	style,
	targetX,
	targetY,
}: EdgeProps<ElkSectionEdge>) => {
	const { screenToFlowPosition } = useReactFlow();
	const points = data?.points ?? [];
	const renderedPoints = withFlowEdgeEndpoints(
		points,
		{ x: sourceX, y: sourceY },
		{ x: targetX, y: targetY },
	);
	const onPointMove = data?.onPointMove;
	const labelPoint = data?.label
		? getEdgeLabelPoint(renderedPoints, data.kind)
		: null;

	const handlePointPointerDown =
		(pointIndex: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
			if (!onPointMove) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const handlePointerMove = (moveEvent: PointerEvent) => {
				onPointMove(
					id,
					pointIndex,
					screenToFlowPosition({
						x: moveEvent.clientX,
						y: moveEvent.clientY,
					}),
				);
			};
			const handlePointerUp = () => {
				window.removeEventListener("pointermove", handlePointerMove);
				window.removeEventListener("pointerup", handlePointerUp);
				window.removeEventListener("pointercancel", handlePointerUp);
			};
			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", handlePointerUp);
			window.addEventListener("pointercancel", handlePointerUp);
		};

	return (
		<>
			<BaseEdge
				id={id}
				path={buildSectionPath(renderedPoints)}
				markerEnd={markerEnd}
				style={style}
			/>
			{data?.label && labelPoint ? (
				<EdgeLabelRenderer>
					<div
						className="nodrag nopan pointer-events-none absolute rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 shadow-sm dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
						style={{
							transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px)`,
						}}
					>
						{data.label}
					</div>
				</EdgeLabelRenderer>
			) : null}
			{renderedPoints.slice(1, -1).map((point, index) => {
				const pointIndex = index + 1;
				return (
					<circle
						key={`${id}-point-${pointIndex}`}
						cx={point.x}
						cy={point.y}
						r={5}
						className="cursor-move fill-background stroke-muted-foreground opacity-0 transition-opacity hover:opacity-100"
						strokeWidth={1.5}
						onPointerDown={handlePointPointerDown(pointIndex)}
					/>
				);
			})}
		</>
	);
};

const EDGE_TYPES = {
	elkSection: ElkSectionEdgeComponent,
} satisfies EdgeTypes;

const getStatusClassName = (node: StageGraphNode) => {
	if (getNodeRuntimeBoolean(node, "effectiveDisabled")) {
		return "border-zinc-300 bg-zinc-100 text-zinc-400 opacity-60 dark:border-zinc-800 dark:bg-zinc-950/70 dark:text-zinc-500";
	}
	if (node.counts.running > 0 || (node.counts.starting ?? 0) > 0) {
		return "border-emerald-400 bg-emerald-50 text-emerald-950 shadow-emerald-200/60 dark:border-emerald-400/80 dark:bg-emerald-950/55 dark:text-emerald-50 dark:shadow-emerald-950/40";
	}
	if (node.counts.launching > 0 || (node.counts.launched ?? 0) > 0) {
		return "border-amber-400 bg-amber-50 text-amber-950 shadow-amber-200/60 dark:border-amber-400/80 dark:bg-amber-950/55 dark:text-amber-50 dark:shadow-amber-950/40";
	}
	return "border-sky-300 bg-white text-slate-950 shadow-sky-100/70 dark:border-sky-500/70 dark:bg-slate-900 dark:text-sky-50 dark:shadow-sky-950/30";
};

const StageLabel = ({ node }: { node: StageGraphNode }) => {
	const { t } = useTranslation("scan");
	const runningBlockCount = Math.max(
		1,
		node.concurrencyLimit,
		node.counts.running + (node.counts.starting ?? 0),
	);
	const runningBlocks = Array.from(
		{ length: runningBlockCount },
		(_, index) => `${node.stageName}-running-${index}`,
	);

	return (
		<div className="flex min-h-full flex-col justify-center gap-2.5 px-5 py-4">
			<div className="text-left text-[15px] font-semibold leading-snug tracking-normal">
				{formatScanStageLabel(t, node.stageName) || node.name || node.title}
			</div>
			<div className="h-px bg-border/80" />
			<div className="flex min-h-4 flex-wrap items-center gap-1.5">
				{runningBlocks.map((blockId) => (
					<span
						key={blockId}
						className={`h-4 w-1.5 rounded-[1px] shadow-[0_0_0_1px_hsl(var(--background))] ${
							Number(blockId.slice(blockId.lastIndexOf("-") + 1)) <
							node.counts.running + (node.counts.starting ?? 0)
								? "bg-sky-500"
								: "bg-muted-foreground/20"
						}`}
					/>
				))}
			</div>
		</div>
	);
};

const DetailRow = ({ label, value }: { label: string; value: ReactNode }) => (
	<div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b py-2 last:border-b-0">
		<div className="text-sm text-muted-foreground">{label}</div>
		<div className="min-w-0 break-words text-sm font-medium">{value}</div>
	</div>
);

const StageDetailDialog = ({
	stage,
	agentProfiles,
	onSave,
	onOpenChange,
}: {
	stage: StageGraphNode | null;
	agentProfiles?: PreviewAgentProfiles;
	onSave?: (
		stageName: string,
		setting: RuntimeStageSetting,
	) => Promise<void> | void;
	onOpenChange: (open: boolean) => void;
}) => {
	const { t } = useTranslation("scan");
	const inheritProfileLabel = scanT(
		t,
		"scan.stageGraph.inheritPipelineDefault",
		"No override (pipeline YAML default)",
	);
	const runtimeRecord = (stage ?? {}) as unknown as Record<string, unknown>;
	const [disabled, setDisabled] = useState(false);
	const [concurrency, setConcurrency] = useState("1");
	const [agentProfileId, setAgentProfileId] = useState(DEFAULT_PROFILE_VALUE);
	const [isSaving, setIsSaving] = useState(false);
	const enabledProfiles = useMemo(
		() => (agentProfiles ?? []).filter((profile) => profile.isEnabled),
		[agentProfiles],
	);
	useEffect(() => {
		if (!stage) {
			return;
		}
		setDisabled(
			isRootRuntimeStage(stage.stageName)
				? false
				: getNodeRuntimeBoolean(stage, "disabled"),
		);
		setConcurrency(String(stage.concurrencyLimit || 1));
		const configuredAgentProfileId =
			typeof runtimeRecord.configuredAgentProfileId === "string"
				? runtimeRecord.configuredAgentProfileId
				: "";
		setAgentProfileId(configuredAgentProfileId || DEFAULT_PROFILE_VALUE);
	}, [stage, runtimeRecord.configuredAgentProfileId]);
	const saveStageSettings = async () => {
		if (!stage || !onSave) {
			onOpenChange(false);
			return;
		}
		const parsedConcurrency = Number.parseInt(concurrency, 10);
		const nextConcurrency =
			Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
				? Math.min(128, parsedConcurrency)
				: 1;
		setIsSaving(true);
		try {
			await onSave(stage.stageName, {
				disabled: isRootRuntimeStage(stage.stageName) ? false : disabled,
				concurrency: nextConcurrency,
				agentProfileId:
					agentProfileId === DEFAULT_PROFILE_VALUE ? null : agentProfileId,
			});
			onOpenChange(false);
		} finally {
			setIsSaving(false);
		}
	};
	return (
		<Dialog open={Boolean(stage)} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{stage
							? formatScanStageLabel(t, stage.stageName)
							: scanT(t, "scan.stageGraph.stage", "Stage")}
					</DialogTitle>
					<DialogDescription>
						{scanT(
							t,
							"scan.stageGraph.runtimeDescription",
							"Stage runtime settings and selected agent profile.",
						)}
					</DialogDescription>
				</DialogHeader>
				{stage ? (
					<div className="space-y-4">
						<div className="rounded-lg border p-3">
							<div className="mb-2 text-sm font-semibold">
								{scanT(t, "scan.stageGraph.runtime", "Runtime")}
							</div>
							<DetailRow
								label={scanT(t, "scan.stageGraph.stageId", "Stage ID")}
								value={stage.stageName}
							/>
							<div className="grid gap-4 pt-3">
								<div className="flex items-center justify-between gap-4">
									<div>
										<Label>
											{scanT(
												t,
												"scan.stageGraph.disableStage",
												"Disable stage",
											)}
										</Label>
										<div className="text-xs text-muted-foreground">
											{scanT(
												t,
												"scan.stageGraph.disableStageDescription",
												"Disabled stages and dominated successors will not start new tasks.",
											)}
										</div>
									</div>
									<Switch
										checked={disabled}
										disabled={isRootRuntimeStage(stage.stageName)}
										onCheckedChange={setDisabled}
									/>
								</div>
								<div className="grid gap-2">
									<Label htmlFor={`${stage.stageName}-concurrency`}>
										{scanT(t, "scan.stageGraph.concurrency", "Concurrency")}
									</Label>
									<Input
										id={`${stage.stageName}-concurrency`}
										type="number"
										min={1}
										max={128}
										step={1}
										value={concurrency}
										onChange={(event) => setConcurrency(event.target.value)}
									/>
								</div>
								<div className="grid gap-2">
									<Label>
										{scanT(t, "scan.stageGraph.agentProfile", "Agent Profile")}
									</Label>
									<Select
										value={agentProfileId}
										onValueChange={setAgentProfileId}
									>
										<SelectTrigger>
											<SelectValue placeholder={inheritProfileLabel} />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={DEFAULT_PROFILE_VALUE}>
												{inheritProfileLabel}
											</SelectItem>
											{enabledProfiles.map((profile) => (
												<SelectItem
													key={profile.agentProfileId}
													value={profile.agentProfileId}
												>
													{profile.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</div>
						</div>
					</div>
				) : null}
				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)}>
						{scanT(t, "scan.dialog.cancel", "Cancel")}
					</Button>
					<Button isLoading={isSaving} onClick={saveStageSettings}>
						{scanT(t, "scan.dialog.save", "Save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const compareStageOrder = (left: StageGraphNode, right: StageGraphNode) => {
	const leftOrder = typeof left.order === "number" ? left.order : 0;
	const rightOrder = typeof right.order === "number" ? right.order : 0;
	return leftOrder === rightOrder
		? left.stageName.localeCompare(right.stageName)
		: leftOrder - rightOrder;
};

const isResearchStageGraph = (graph: StageGraph) =>
	graph.pipelineName.toLowerCase().includes("research");

const getResearchNodeAbsolutePositions = (graph: StageGraph) => {
	const positions = new Map<string, Point>();
	const positionByStageName: Record<string, Point> = {
		[RESEARCH_STAGE_NAMES.scope]: {
			x: RESEARCH_CENTER_X,
			y: RESEARCH_SCOPE_Y,
		},
		[RESEARCH_STAGE_NAMES.surface]: {
			x: RESEARCH_CENTER_X,
			y: RESEARCH_SURFACE_Y,
		},
		[RESEARCH_STAGE_NAMES.trackPlan]: {
			x: RESEARCH_LEFT_X,
			y: RESEARCH_TRACK_PLAN_Y,
		},
		[RESEARCH_STAGE_NAMES.discovery]: {
			x: RESEARCH_LEFT_X,
			y: RESEARCH_DISCOVERY_Y,
		},
		[RESEARCH_STAGE_NAMES.trackReview]: {
			x: RESEARCH_LEFT_REVIEW_X,
			y: RESEARCH_DISCOVERY_Y,
		},
		[RESEARCH_STAGE_NAMES.findingValidation]: {
			x: RESEARCH_RIGHT_X,
			y: RESEARCH_FINDING_Y,
		},
		[RESEARCH_STAGE_NAMES.findingReview]: {
			x: RESEARCH_RIGHT_REVIEW_X,
			y: RESEARCH_FINDING_Y,
		},
		[RESEARCH_STAGE_NAMES.chainSynthesis]: {
			x: RESEARCH_LEFT_X,
			y: RESEARCH_CHAIN_Y,
		},
		[RESEARCH_STAGE_NAMES.chainReview]: {
			x: RESEARCH_LEFT_REVIEW_X,
			y: RESEARCH_CHAIN_Y,
		},
		[RESEARCH_STAGE_NAMES.exploitValidation]: {
			x: RESEARCH_RIGHT_X,
			y: RESEARCH_EXPLOIT_Y,
		},
		[RESEARCH_STAGE_NAMES.exploitReview]: {
			x: RESEARCH_RIGHT_REVIEW_X,
			y: RESEARCH_EXPLOIT_Y,
		},
		[RESEARCH_STAGE_NAMES.report]: {
			x: RESEARCH_CENTER_X,
			y: RESEARCH_REPORT_Y,
		},
	};

	for (const node of graph.nodes) {
		positions.set(
			node.stageName,
			positionByStageName[node.stageName] ?? {
				x: GRAPH_PADDING,
				y: GRAPH_PADDING + node.order * (NODE_HEIGHT + NODE_GAP_Y),
			},
		);
	}
	return positions;
};

const getNodeAbsolutePositions = (graph: StageGraph) => {
	const nodeByStageName = new Map(
		graph.nodes.map((node) => [node.stageName, node]),
	);
	const groupByStageName = new Map(
		graph.groups.flatMap((group) =>
			group.stageNames.map((stageName) => [stageName, group] as const),
		),
	);
	const orderedNodes = [...graph.nodes].sort(compareStageOrder);
	const positionedStageNames = new Set<string>();
	const rows: string[][] = [[]];
	const appendUnit = (stageNames: string[]) => {
		const currentRow = rows[rows.length - 1] ?? [];
		if (
			currentRow.length > 0 &&
			currentRow.length + stageNames.length > STAGES_PER_ROW
		) {
			rows.push([...stageNames]);
			return;
		}
		currentRow.push(...stageNames);
		rows[rows.length - 1] = currentRow;
	};

	for (const node of orderedNodes) {
		if (positionedStageNames.has(node.stageName)) {
			continue;
		}
		const group = groupByStageName.get(node.stageName);
		const stageNames = group
			? group.stageNames
					.filter((stageName) => nodeByStageName.has(stageName))
					.sort((leftStageName, rightStageName) =>
						compareStageOrder(
							nodeByStageName.get(leftStageName)!,
							nodeByStageName.get(rightStageName)!,
						),
					)
			: [node.stageName];
		for (const stageName of stageNames) {
			positionedStageNames.add(stageName);
		}
		appendUnit(stageNames);
	}

	const positions = new Map<string, Point>();
	for (const [row, stageNames] of rows.entries()) {
		for (const [column, stageName] of stageNames.entries()) {
			positions.set(stageName, {
				x: GRAPH_PADDING + column * (NODE_WIDTH + NODE_GAP_X),
				y: GRAPH_PADDING + row * (NODE_HEIGHT + NODE_GAP_Y),
			});
		}
	}
	return positions;
};

const getGroupBounds = (
	stageNames: readonly string[],
	positions: Map<string, Point>,
) => {
	const memberPositions = stageNames.flatMap((stageName) => {
		const position = positions.get(stageName);
		return position ? [position] : [];
	});
	if (memberPositions.length === 0) {
		return null;
	}
	const minX = Math.min(...memberPositions.map((position) => position.x));
	const minY = Math.min(...memberPositions.map((position) => position.y));
	const maxX = Math.max(...memberPositions.map((position) => position.x));
	const maxY = Math.max(...memberPositions.map((position) => position.y));
	return {
		x: minX - GROUP_PADDING_X,
		y: minY - GROUP_NODE_TOP,
		width: maxX - minX + NODE_WIDTH + GROUP_PADDING_X * 2,
		height: maxY - minY + NODE_HEIGHT + GROUP_NODE_TOP + GROUP_PADDING_BOTTOM,
	};
};

const getNodeAnchor = (nodePosition: Point, side: Side): Point => {
	switch (side) {
		case "top":
			return { x: nodePosition.x + NODE_WIDTH / 2, y: nodePosition.y };
		case "right":
			return {
				x: nodePosition.x + NODE_WIDTH,
				y: nodePosition.y + NODE_HEIGHT / 2,
			};
		case "bottom":
			return {
				x: nodePosition.x + NODE_WIDTH / 2,
				y: nodePosition.y + NODE_HEIGHT,
			};
		case "left":
			return { x: nodePosition.x, y: nodePosition.y + NODE_HEIGHT / 2 };
	}
};

const buildSideCorridorEdgePoints = (input: {
	source: Point;
	sourceSide: Side;
	target: Point;
	targetSide: Side;
}) => {
	const start = getNodeAnchor(input.source, input.sourceSide);
	const end = getNodeAnchor(input.target, input.targetSide);
	const midX = start.x + (end.x - start.x) / 2;
	return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
};

const buildLowerCorridorEdgePoints = (source: Point, target: Point) => {
	const start = getNodeAnchor(source, "bottom");
	const end = getNodeAnchor(target, "bottom");
	const routeY =
		Math.max(source.y, target.y) + NODE_HEIGHT + FORWARD_LONG_EDGE_OFFSET_Y;
	return [start, { x: start.x, y: routeY }, { x: end.x, y: routeY }, end];
};

type ResearchEdgeKind = "forward" | "local-loop" | "rework";

const buildResearchForwardEdgePoints = (source: Point, target: Point) => {
	if (source.y === target.y) {
		return buildSideCorridorEdgePoints({
			source,
			sourceSide: "right",
			target,
			targetSide: "left",
		});
	}

	const sourceIsAbove = source.y < target.y;
	const start = getNodeAnchor(source, sourceIsAbove ? "bottom" : "top");
	const end = getNodeAnchor(target, sourceIsAbove ? "top" : "bottom");
	const corridorY = start.y + (end.y - start.y) / 2;
	return [start, { x: start.x, y: corridorY }, { x: end.x, y: corridorY }, end];
};

const buildResearchLocalLoopEdgePoints = (
	source: Point,
	target: Point,
	laneOffset: number,
) => {
	if (source.y === target.y) {
		const start = getNodeAnchor(source, "bottom");
		const end = getNodeAnchor(target, "bottom");
		const loopY = source.y + NODE_HEIGHT + 42 + laneOffset;
		return [start, { x: start.x, y: loopY }, { x: end.x, y: loopY }, end];
	}

	const start = getNodeAnchor(source, "right");
	const end = getNodeAnchor(target, "top");
	const loopX = RESEARCH_REWORK_RAIL_X - 34 + laneOffset;
	const targetCorridorY = target.y - 34 - laneOffset;
	return [
		start,
		{ x: loopX, y: start.y },
		{ x: loopX, y: targetCorridorY },
		{ x: end.x, y: targetCorridorY },
		end,
	];
};

const buildResearchReworkEdgePoints = (
	source: Point,
	target: Point,
	laneOffset: number,
) => {
	const start = getNodeAnchor(source, "right");
	const end = getNodeAnchor(target, "top");
	const railX = RESEARCH_REWORK_RAIL_X + laneOffset;
	const targetCorridorY = target.y - 24 - laneOffset;
	return [
		start,
		{ x: railX, y: start.y },
		{ x: railX, y: targetCorridorY },
		{ x: end.x, y: targetCorridorY },
		end,
	];
};

const buildResearchEdgePoints = (input: {
	source: Point;
	target: Point;
	sourceStageName: string;
	targetStageName: string;
	edgeKind: ResearchEdgeKind;
	laneOffset: number;
}) => {
	if (input.edgeKind === "local-loop") {
		return buildResearchLocalLoopEdgePoints(
			input.source,
			input.target,
			input.laneOffset,
		);
	}
	if (input.edgeKind === "rework") {
		return buildResearchReworkEdgePoints(
			input.source,
			input.target,
			input.laneOffset,
		);
	}
	return buildResearchForwardEdgePoints(input.source, input.target);
};

const getResearchEdgeKind = (
	sourceStageName: string,
	targetStageName: string,
) => {
	const key = `${sourceStageName}->${targetStageName}`;
	if (RESEARCH_LOCAL_LOOPS.has(key)) {
		return "local-loop" as const;
	}
	if (RESEARCH_REWORK_EDGES.has(key)) {
		return "rework" as const;
	}
	return "forward" as const;
};

const segmentIntersectsNode = (
	start: Point,
	end: Point,
	nodePosition: Point,
) => {
	const padding = 6;
	const left = nodePosition.x - padding;
	const right = nodePosition.x + NODE_WIDTH + padding;
	const top = nodePosition.y - padding;
	const bottom = nodePosition.y + NODE_HEIGHT + padding;
	if (start.x === end.x) {
		return (
			start.x >= left &&
			start.x <= right &&
			Math.max(Math.min(start.y, end.y), top) <=
				Math.min(Math.max(start.y, end.y), bottom)
		);
	}
	if (start.y === end.y) {
		return (
			start.y >= top &&
			start.y <= bottom &&
			Math.max(Math.min(start.x, end.x), left) <=
				Math.min(Math.max(start.x, end.x), right)
		);
	}
	return true;
};

const assertResearchEdgeClear = (input: {
	edgeId: string;
	sourceStageName: string;
	targetStageName: string;
	points: Point[];
	positions: Map<string, Point>;
}) => {
	for (let pointIndex = 1; pointIndex < input.points.length; pointIndex += 1) {
		const start = input.points[pointIndex - 1];
		const end = input.points[pointIndex];
		if (!start || !end) {
			continue;
		}
		for (const [stageName, position] of input.positions) {
			if (
				stageName === input.sourceStageName ||
				stageName === input.targetStageName
			) {
				continue;
			}
			if (segmentIntersectsNode(start, end, position)) {
				throw new Error(
					`Research edge ${input.edgeId} intersects stage ${stageName}`,
				);
			}
		}
	}
};

const buildEdgePoints = (input: {
	source: Point;
	target: Point;
	sourceStageName: string;
	targetStageName: string;
}) => {
	const { source, target, sourceStageName, targetStageName } = input;
	if (
		sourceStageName === "analyze-finding" &&
		targetStageName === "critique-finding"
	) {
		return buildLowerCorridorEdgePoints(source, target);
	}
	if (
		sourceStageName === "critique-finding" &&
		targetStageName === "analyze-finding"
	) {
		return buildLowerCorridorEdgePoints(source, target);
	}
	if (
		sourceStageName === "critique-finding" &&
		targetStageName === "verify-finding"
	) {
		const start = { x: source.x + NODE_WIDTH, y: source.y + NODE_HEIGHT / 2 };
		const end = { x: target.x, y: target.y + NODE_HEIGHT / 2 };
		const routeBottomY =
			Math.max(source.y, target.y) + NODE_HEIGHT + FORWARD_LONG_EDGE_OFFSET_Y;
		return [
			start,
			{ x: start.x, y: routeBottomY },
			{ x: end.x, y: routeBottomY },
			end,
		];
	}
	if (source.x === target.x && source.y === target.y) {
		const centerY = source.y + NODE_HEIGHT / 2;
		const start = {
			x: source.x + NODE_WIDTH,
			y: centerY,
		};
		const end = {
			x: source.x,
			y: centerY,
		};
		const routeRightX = source.x + NODE_WIDTH + SELF_EDGE_OFFSET_X;
		const routeLeftX = source.x - SELF_EDGE_OFFSET_X;
		const routeBottomY = source.y + NODE_HEIGHT + SELF_EDGE_OFFSET_Y;
		return [
			start,
			{ x: routeRightX, y: centerY },
			{ x: routeRightX, y: routeBottomY },
			{ x: routeLeftX, y: routeBottomY },
			{ x: routeLeftX, y: centerY },
			end,
		];
	}

	const sourceRow = Math.round(
		(source.y - GRAPH_PADDING) / (NODE_HEIGHT + NODE_GAP_Y),
	);
	const targetRow = Math.round(
		(target.y - GRAPH_PADDING) / (NODE_HEIGHT + NODE_GAP_Y),
	);
	const sourceColumn = Math.round(
		(source.x - GRAPH_PADDING) / (NODE_WIDTH + NODE_GAP_X),
	);
	const targetColumn = Math.round(
		(target.x - GRAPH_PADDING) / (NODE_WIDTH + NODE_GAP_X),
	);
	if (sourceRow === targetRow) {
		const sourceIsLeft = source.x <= target.x;
		if (!sourceIsLeft) {
			const routeY = Math.min(source.y, target.y) - BACK_EDGE_OFFSET_Y;
			const start = {
				x: source.x + NODE_WIDTH / 2,
				y: source.y,
			};
			const end = {
				x: target.x + NODE_WIDTH / 2,
				y: target.y,
			};
			return [start, { x: start.x, y: routeY }, { x: end.x, y: routeY }, end];
		}
		if (Math.abs(targetColumn - sourceColumn) > 1) {
			const routeY = source.y + NODE_HEIGHT + FORWARD_LONG_EDGE_OFFSET_Y;
			const start = {
				x: source.x + NODE_WIDTH / 2,
				y: source.y + NODE_HEIGHT,
			};
			const end = {
				x: target.x + NODE_WIDTH / 2,
				y: target.y + NODE_HEIGHT,
			};
			return [start, { x: start.x, y: routeY }, { x: end.x, y: routeY }, end];
		}
		const start = {
			x: source.x + NODE_WIDTH,
			y: source.y + NODE_HEIGHT / 2,
		};
		const end = {
			x: target.x,
			y: target.y + NODE_HEIGHT / 2,
		};
		const midX = start.x + (end.x - start.x) / 2;
		return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
	}

	const sourceIsAbove = source.y <= target.y;
	const start = {
		x: source.x + NODE_WIDTH / 2,
		y: source.y + (sourceIsAbove ? NODE_HEIGHT : 0),
	};
	const end = {
		x: target.x + NODE_WIDTH / 2,
		y: target.y + (sourceIsAbove ? 0 : NODE_HEIGHT),
	};
	const midY = start.y + (end.y - start.y) / 2;
	return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
};

const inferPointSide = (
	point: Point | undefined,
	nodePosition: Point,
): Side => {
	if (!point) {
		return "right";
	}
	const anchors: Array<{ side: Side; point: Point }> = [
		{
			side: "top",
			point: { x: nodePosition.x + NODE_WIDTH / 2, y: nodePosition.y },
		},
		{
			side: "right",
			point: {
				x: nodePosition.x + NODE_WIDTH,
				y: nodePosition.y + NODE_HEIGHT / 2,
			},
		},
		{
			side: "bottom",
			point: {
				x: nodePosition.x + NODE_WIDTH / 2,
				y: nodePosition.y + NODE_HEIGHT,
			},
		},
		{
			side: "left",
			point: { x: nodePosition.x, y: nodePosition.y + NODE_HEIGHT / 2 },
		},
	];
	return anchors.reduce((closest, candidate) => {
		const closestDistance =
			(point.x - closest.point.x) ** 2 + (point.y - closest.point.y) ** 2;
		const candidateDistance =
			(point.x - candidate.point.x) ** 2 + (point.y - candidate.point.y) ** 2;
		return candidateDistance < closestDistance ? candidate : closest;
	}).side;
};

const getVisibleStageGraphEdges = (
	graph: StageGraph,
	researchGraph: boolean,
): VisibleStageGraphEdge[] => {
	if (!researchGraph) {
		return graph.edges.map((edge) => ({ ...edge, routeLabels: [] }));
	}

	const edgesByEndpoints = new Map<string, VisibleStageGraphEdge>();
	for (const edge of graph.edges) {
		const endpointKey = `${edge.source}->${edge.target}`;
		const existingEdge = edgesByEndpoints.get(endpointKey);
		if (existingEdge) {
			if (edge.routeKey && !existingEdge.routeLabels.includes(edge.routeKey)) {
				existingEdge.routeLabels.push(edge.routeKey);
			}
			continue;
		}
		edgesByEndpoints.set(endpointKey, {
			...edge,
			id: `research-edge-${edge.source}-${edge.target}`,
			routeLabels: edge.routeKey ? [edge.routeKey] : [],
		});
	}
	return [...edgesByEndpoints.values()];
};

const buildFlowElements = (
	graph: StageGraph,
	onEdgePointMove?: EdgePointMoveHandler,
) => {
	const researchGraph = isResearchStageGraph(graph);
	const visibleEdges = getVisibleStageGraphEdges(graph, researchGraph);
	const stagePositions = researchGraph
		? getResearchNodeAbsolutePositions(graph)
		: getNodeAbsolutePositions(graph);
	const syntheticResearchGroups = researchGraph
		? RESEARCH_MODULES.map((module) => ({
				id: `research-module-${module.name}`,
				name: module.label,
				stageNames: module.stageNames,
			}))
		: [];
	const visibleGroups = [...graph.groups, ...syntheticResearchGroups];
	const visibleGroupById = new Map(
		visibleGroups.map((group) => [group.id, group]),
	);
	const groupBoundsById = new Map(
		visibleGroups.flatMap((group) => {
			const bounds = getGroupBounds(group.stageNames, stagePositions);
			return bounds ? [[group.id, bounds] as const] : [];
		}),
	);

	const flowNodes: Node[] = [
		...visibleGroups.flatMap<Node>((group) => {
			const bounds = groupBoundsById.get(group.id);
			if (!bounds) {
				return [];
			}
			return [
				{
					id: group.id,
					type: "group",
					position: { x: bounds.x, y: bounds.y },
					data: {
						label: (
							<div className="px-3 pt-3 text-sm font-semibold capitalize text-muted-foreground">
								{group.name.replace(/-/g, " ")}
							</div>
						),
					},
					style: {
						width: bounds.width,
						height: bounds.height,
						borderRadius: 8,
						border: "1px solid hsl(var(--border))",
						background: "hsl(var(--muted) / 0.52)",
					},
					draggable: false,
					selectable: false,
					zIndex: 0,
				},
			];
		}),
		...graph.nodes.map<Node>((node) => {
			const groupId =
				node.groupId && visibleGroupById.has(node.groupId)
					? node.groupId
					: null;
			const groupBounds = groupId ? groupBoundsById.get(groupId) : null;
			const position = stagePositions.get(node.stageName) ?? {
				x: GRAPH_PADDING,
				y: GRAPH_PADDING,
			};
			return {
				id: node.stageName,
				type: "stage",
				parentId: groupId ?? undefined,
				extent: groupId ? "parent" : undefined,
				position:
					groupId && groupBounds
						? { x: position.x - groupBounds.x, y: position.y - groupBounds.y }
						: position,
				data: { label: <StageLabel node={node} />, stageNode: node },
				className: `cursor-pointer rounded-md border-2 shadow-md backdrop-blur-sm ${getStatusClassName(node)}`,
				style: {
					width: NODE_WIDTH,
					minHeight: NODE_HEIGHT,
					padding: 0,
				},
				draggable: true,
				selectable: true,
				zIndex: 2,
			};
		}),
	];

	const flowEdges: ElkSectionEdge[] = visibleEdges.map((edge, edgeIndex) => {
		const source = stagePositions.get(edge.source);
		const target = stagePositions.get(edge.target);
		const edgeKind = researchGraph
			? getResearchEdgeKind(edge.source, edge.target)
			: "forward";
		const reworkEdgeIndex = visibleEdges
			.slice(0, edgeIndex)
			.filter(
				(previousEdge) =>
					getResearchEdgeKind(previousEdge.source, previousEdge.target) ===
					"rework",
			).length;
		const laneOffset = edgeKind === "rework" ? reworkEdgeIndex * 14 : 0;
		const points =
			source && target
				? researchGraph
					? buildResearchEdgePoints({
							source,
							target,
							sourceStageName: edge.source,
							targetStageName: edge.target,
							edgeKind,
							laneOffset,
						})
					: buildEdgePoints({
							source,
							target,
							sourceStageName: edge.source,
							targetStageName: edge.target,
						})
				: [];
		if (researchGraph) {
			assertResearchEdgeClear({
				edgeId: edge.id,
				sourceStageName: edge.source,
				targetStageName: edge.target,
				points,
				positions: stagePositions,
			});
		}
		const sourceSide = inferPointSide(points[0], source ?? { x: 0, y: 0 });
		const targetSide = inferPointSide(
			points[points.length - 1],
			target ?? { x: 0, y: 0 },
		);
		const sourceNode = graph.nodes.find(
			(node) => node.stageName === edge.source,
		);
		const targetNode = graph.nodes.find(
			(node) => node.stageName === edge.target,
		);
		const isInactiveEdge =
			(sourceNode && getNodeRuntimeBoolean(sourceNode, "effectiveDisabled")) ||
			(targetNode && getNodeRuntimeBoolean(targetNode, "effectiveDisabled"));
		const edgeColor = isInactiveEdge
			? "hsl(var(--muted-foreground) / 0.28)"
			: edgeKind === "local-loop"
				? "hsl(38 92% 45%)"
				: edgeKind === "rework"
					? "hsl(var(--muted-foreground) / 0.55)"
					: "hsl(var(--foreground) / 0.62)";
		return {
			id: edge.id,
			source: edge.source,
			sourceHandle: `source-${sourceSide}`,
			target: edge.target,
			targetHandle: `target-${targetSide}`,
			type: "elkSection" as const,
			animated: true,
			zIndex: 1,
			data: {
				points,
				kind: edgeKind,
				label:
					edge.routeLabels.length > 1
						? edge.routeLabels.join(" / ")
						: undefined,
				onPointMove: onEdgePointMove,
			},
			markerEnd: {
				type: MarkerType.ArrowClosed,
				width: 16,
				height: 16,
				color: edgeColor,
			},
			style: {
				strokeWidth: isInactiveEdge ? 1.2 : edgeKind === "local-loop" ? 2 : 1.5,
				stroke: edgeColor,
				strokeDasharray: edgeKind === "forward" ? "6 6" : undefined,
			},
		};
	});

	return { nodes: flowNodes, edges: flowEdges };
};

export const ScanStageGraphPanel = ({
	graph,
	isLoading = false,
	error,
	title,
	description,
	heightClassName = "h-[420px] md:h-[520px]",
	scanRuntimeSettings,
	agentProfiles,
	onStageSettingSave,
}: {
	graph?: StageGraph | null;
	isLoading?: boolean;
	error?: unknown;
	title?: string;
	description?: string;
	heightClassName?: string;
	scanRuntimeSettings?: ScanRuntimeSettingsDraft | null;
	agentProfiles?: PreviewAgentProfiles;
	onStageSettingSave?: (
		stageName: string,
		setting: RuntimeStageSetting,
	) => Promise<void> | void;
}) => {
	const { t } = useTranslation("scan");
	const [elements, setElements] = useState(EMPTY_FLOW_ELEMENTS);
	const [layoutError, setLayoutError] = useState<Error | null>(null);
	const [selectedStage, setSelectedStage] = useState<StageGraphNode | null>(
		null,
	);
	const handleNodesChange = useCallback((changes: NodeChange[]) => {
		setElements((previousElements) => ({
			...previousElements,
			nodes: applyNodeChanges(changes, previousElements.nodes),
		}));
	}, []);
	const handleEdgePointMove = useCallback<EdgePointMoveHandler>(
		(edgeId, pointIndex, point) => {
			setElements((previousElements) => ({
				...previousElements,
				edges: previousElements.edges.map((edge) => {
					if (edge.id !== edgeId) {
						return edge;
					}
					const data = edge.data as ElkSectionEdgeData | undefined;
					const points = data?.points ?? [];
					return {
						...edge,
						data: {
							...data,
							points: points.map((currentPoint, index) =>
								index === pointIndex ? point : currentPoint,
							),
						},
					};
				}),
			}));
		},
		[],
	);
	const isLayoutLoading = Boolean(
		graph &&
			graph.nodes.length > 0 &&
			elements.nodes.length === 0 &&
			!layoutError,
	);
	const effectiveGraph = useMemo(
		() =>
			applyRuntimeSettingsToGraph(graph, scanRuntimeSettings, agentProfiles),
		[graph, scanRuntimeSettings, agentProfiles],
	);

	useEffect(() => {
		let isCancelled = false;
		if (!effectiveGraph || effectiveGraph.nodes.length === 0) {
			setElements(EMPTY_FLOW_ELEMENTS);
			setLayoutError(null);
			return;
		}

		setLayoutError(null);
		try {
			const nextElements = buildFlowElements(
				effectiveGraph,
				handleEdgePointMove,
			);
			if (!isCancelled) {
				setElements(nextElements);
			}
		} catch (nextError) {
			console.error("Failed to layout scan stage graph", nextError);
			if (!isCancelled) {
				setElements(EMPTY_FLOW_ELEMENTS);
				setLayoutError(
					nextError instanceof Error
						? nextError
						: new Error("Failed to layout stage graph"),
				);
			}
		}

		return () => {
			isCancelled = true;
		};
	}, [effectiveGraph, handleEdgePointMove]);

	return (
		<div className="w-full min-w-0 rounded-lg border bg-background">
			<div className="border-b px-4 py-3">
				<div className="font-medium">
					{title || scanT(t, "scan.stageGraph.title", "Stage Graph")}
				</div>
				<div className="text-sm text-muted-foreground">
					{description ||
						scanT(
							t,
							"scan.stageGraph.description",
							"Pipeline topology and live stage progress.",
						)}
				</div>
			</div>
			<div
				className={`relative border-t bg-muted/35 shadow-inner dark:bg-slate-950/55 ${heightClassName}`}
			>
				{isLoading || isLayoutLoading ? (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" />
						{scanT(t, "scan.stageGraph.loading", "Loading stage graph...")}
					</div>
				) : error || layoutError ? (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-destructive">
						<AlertCircle className="size-4" />
						{scanT(t, "scan.stageGraph.error", "Failed to load stage graph.")}
					</div>
				) : !effectiveGraph || effectiveGraph.nodes.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						{scanT(t, "scan.stageGraph.empty", "No stage graph available.")}
					</div>
				) : (
					<ReactFlow
						key={`stage-graph-${effectiveGraph?.pipelineName ?? "empty"}-${elements.nodes.length}`}
						className="scan-stage-graph-flow text-foreground"
						nodes={elements.nodes}
						edges={elements.edges}
						nodeTypes={NODE_TYPES}
						edgeTypes={EDGE_TYPES}
						fitView
						onNodesChange={handleNodesChange}
						nodesDraggable
						nodesConnectable={false}
						elementsSelectable
						panOnScroll={false}
						zoomOnScroll
						zoomOnPinch
						minZoom={
							effectiveGraph && isResearchStageGraph(effectiveGraph) ? 0.1 : 0.5
						}
						onNodeClick={(_event, node) => {
							const stageNode = node.data?.stageNode;
							if (stageNode) {
								setSelectedStage(stageNode as StageGraphNode);
							}
						}}
						proOptions={{ hideAttribution: true }}
					>
						<Background color="hsl(var(--muted-foreground) / 0.22)" />
						<Controls showInteractive={false} />
					</ReactFlow>
				)}
			</div>
			<style jsx global>{`
				.scan-stage-graph-flow .react-flow__controls {
					border: 1px solid hsl(var(--border));
					box-shadow: 0 10px 24px hsl(var(--foreground) / 0.08);
				}
				.scan-stage-graph-flow .react-flow__controls-button {
					background: hsl(var(--background) / 0.92);
					border-bottom: 1px solid hsl(var(--border));
					color: hsl(var(--foreground));
				}
				.scan-stage-graph-flow .react-flow__controls-button:hover {
					background: hsl(var(--muted));
				}
				.scan-stage-graph-flow .react-flow__controls-button svg {
					fill: currentColor;
				}
				.dark .scan-stage-graph-flow .react-flow__edge.animated path {
					stroke-dasharray: 6;
				}
			`}</style>
			<StageDetailDialog
				stage={selectedStage}
				agentProfiles={agentProfiles}
				onSave={onStageSettingSave}
				onOpenChange={(open) => {
					if (!open) {
						setSelectedStage(null);
					}
				}}
			/>
		</div>
	);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const asPreviewAgentProfile = (
	value: unknown,
): StageGraphNode["agentProfile"] => {
	const record = asRecord(value);
	if (!record) {
		return null;
	}
	const agentProfileId =
		typeof record.agentProfileId === "string" ? record.agentProfileId : "";
	const name = typeof record.name === "string" ? record.name : "";
	const model = typeof record.model === "string" ? record.model : "";
	if (!agentProfileId && !name && !model) {
		return null;
	}
	const provider =
		record.provider === "claude_code" ||
		record.provider === "codex" ||
		record.provider === "grok_build"
			? record.provider
			: "codex";
	const authMode = record.authMode === "host_home" ? "host_home" : "api_key";
	return {
		agentProfileId,
		name,
		provider,
		authMode,
		homePath: typeof record.homePath === "string" ? record.homePath : "",
		baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
		model,
		thinkingLevel:
			typeof record.thinkingLevel === "string" ? record.thinkingLevel : "",
		thinkingLevelEnabled:
			typeof record.thinkingLevelEnabled === "boolean"
				? record.thinkingLevelEnabled
				: false,
	};
};

export const FullScanStageGraphPreview = ({
	serviceData,
	scanRuntimeSettings,
	onScanRuntimeSettingsChange,
	pipelineId = "",
}: {
	serviceData?: PreviewServiceData;
	scanRuntimeSettings?: ScanRuntimeSettingsDraft;
	onScanRuntimeSettingsChange?: (settings: ScanRuntimeSettingsDraft) => void;
	pipelineId?: string;
}) => {
	const { t } = useTranslation("scan");
	const target = useMemo<FullScanStageGraphTarget | null>(() => {
		const serviceRecord = asRecord(serviceData);
		const applicationId = serviceRecord?.applicationId;
		if (typeof applicationId === "string" && applicationId) {
			return { applicationId, pipelineId };
		}
		const composeId = serviceRecord?.composeId;
		if (typeof composeId === "string" && composeId) {
			return { composeId, pipelineId };
		}
		return null;
	}, [pipelineId, serviceData]);
	const {
		data: graph,
		isLoading,
		error,
	} = api.scan.fullScanStageGraph.useQuery(target ?? { applicationId: "", pipelineId }, {
		enabled: Boolean(target),
	});
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery();
	const handleStageSettingSave = (
		stageName: string,
		setting: RuntimeStageSetting,
	) => {
		onScanRuntimeSettingsChange?.({
			...(scanRuntimeSettings ?? {}),
			stages: {
				...(scanRuntimeSettings?.stages ?? {}),
				[stageName]: setting,
			},
		});
	};
	return (
		<ScanStageGraphPanel
			graph={graph}
			isLoading={isLoading}
			error={error}
			description={scanT(
				t,
				"scan.stageGraph.previewDescription",
				"{{type}} scan pipeline preview.",
				{
					type:
									pipelineId === "delta"
							? scanT(t, "scan.scanType.delta", "Delta Scan")
											: pipelineId === "research"
								? scanT(t, "scan.scanType.research", "Research Scan")
												: pipelineId === "tob-goal"
									? scanT(t, "scan.scanType.goal", "Goal Scan")
									: scanT(t, "scan.scanType.full", "Full Scan"),
				},
			)}
			heightClassName={
					pipelineId === "research" || pipelineId === "tob-goal"
					? "h-[600px]"
					: "h-[360px]"
			}
			scanRuntimeSettings={scanRuntimeSettings}
			agentProfiles={agentProfiles}
			onStageSettingSave={handleStageSettingSave}
		/>
	);
};

export const ScanStageGraph = ({
	scanJobId,
	queueCounts,
	scanRuntimeSettings,
}: {
	scanJobId: string;
	queueCounts?: QueueCount[];
	scanRuntimeSettings?: ScanRuntimeSettingsDraft | null;
}) => {
	const utils = api.useUtils();
	const {
		data: graph,
		isLoading,
		error,
	} = api.scan.jobPipeline.useQuery(
		{ scanJobId },
		{
			enabled: !!scanJobId,
			staleTime: Number.POSITIVE_INFINITY,
			refetchOnWindowFocus: false,
		},
	);
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery();
	const { mutateAsync: updateRuntimeSettings } =
		api.scan.updateRuntimeSettings.useMutation();
	const graphWithQueueCounts = useMemo(() => {
		if (!graph) return graph;
		const queueByStage = new Map(
			(queueCounts ?? []).map((queue) => [queue.stageName, queue]),
		);
		return {
			...graph,
			nodes: graph.nodes.map((node) => {
				const queue = queueByStage.get(node.stageName);
				return {
					...node,
					counts: queue
						? {
								waiting: queue.waitingCount,
								queued: queue.queuedCount,
								launching: queue.launchingCount,
								launched: queue.launchedCount,
								starting: queue.startingCount,
								running: queue.runningCount,
								completed: queue.completedCount,
								failed: queue.failedCount,
								exited: queue.exitedCount,
								total: queue.totalCount,
								pending: queue.pendingCount,
							}
						: emptyStageCounts(),
				};
			}),
		};
	}, [graph, queueCounts]);
	const handleStageSettingSave = async (
		stageName: string,
		setting: RuntimeStageSetting,
	) => {
		const nextSettings = {
			...scanRuntimeSettings,
			stages: {
				...(scanRuntimeSettings?.stages ?? {}),
				[stageName]: setting,
			},
		};
		await updateRuntimeSettings({
			scanJobId,
			scanRuntimeSettings: nextSettings,
		});
		await Promise.all([
			utils.scan.jobOverview.invalidate({ scanJobId }),
			utils.scan.jobPipeline.invalidate({ scanJobId }),
			utils.scan.jobQueueCounts.invalidate({ scanJobId }),
		]);
	};
	return (
		<ScanStageGraphPanel
			graph={graphWithQueueCounts}
			isLoading={isLoading}
			error={error}
			scanRuntimeSettings={scanRuntimeSettings}
			agentProfiles={agentProfiles}
			onStageSettingSave={handleStageSettingSave}
		/>
	);
};
