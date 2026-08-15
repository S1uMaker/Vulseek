import type {
	PipelineDocumentV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import type { OnNodeDrag } from "@xyflow/react";
import {
	applyNodeChanges,
	Background,
	BaseEdge,
	type Connection,
	Controls,
	EdgeLabelRenderer,
	type EdgeProps,
	type Edge as FlowEdge,
	type Node as FlowNode,
	Handle,
	MarkerType,
	MiniMap,
	type NodeChange,
	type NodeProps,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useNodesInitialized,
	useReactFlow,
} from "@xyflow/react";
import {
	AlignStartHorizontal,
	AlignStartVertical,
	Focus,
	LayoutGrid,
	Lock,
	Maximize2,
	Minimize2,
	MousePointer2,
	Plus,
} from "lucide-react";
import * as React from "react";
import {
	buildPipelineDisplayGraph,
	type PipelineDisplayEdge,
} from "@/lib/pipeline-editor/pipeline-display-graph";
import {
	buildEdgePath,
	CURRENT_PIPELINE_LAYOUT_VERSION,
	computePipelineLayout,
	defaultEdgeFactory,
	defaultHandlesForDisplayEdge,
	expandPersistedEdgeLayout,
	isLegacyLayout,
	NODE_HEIGHT,
	NODE_WIDTH,
	nextUniqueId,
	type PipelineLayoutDirection,
	type PipelineLayoutEdge,
	resolveStagePositions,
	type TransientPipelineLayout,
} from "@/lib/pipeline-editor/pipeline-layout";
import { StageCreateDialog } from "@/components/dashboard/pipelines/stage-create-dialog";
import { cn } from "@/lib/utils";

/**
 * ELK-driven pipeline canvas rendered from the *display graph*.
 *
 * - Layout: one ELK Layered pass owns every node, port, forward edge,
 *   feedback edge, and self-loop (see `pipeline-layout.ts`).
 * - `ui.layoutVersion` gates saved positions: legacy layouts (no version, or
 *   an older one) are ignored for the initial transient preview so stale
 *   horizontal positions cannot override the top-to-bottom layout.
 * - Parallel edges with the same `(from, to)` render as one grouped path
 *   with a route-label cluster; clicking the path selects the primary
 *   member, clicking an individual label selects that original edge.
 * - Every directed display edge carries an arrowhead and stays
 *   keyboard-selectable via semantic route-label buttons.
 * - Viewport policy: initial fit targets the root + forward path with a
 *   minimum zoom of 0.55; explicit Fit All may zoom farther out. A
 *   ResizeObserver (not just window.resize) triggers settled refits, and
 *   the Minimap reserves its safe area so no initially fitted node or label
 *   lands underneath it.
 */

const ROLE_COLORS: Record<PipelineStageV3["role"], string> = {
	scan: "border-sky-500/60 bg-sky-500/10",
	analysis: "border-amber-500/60 bg-amber-500/10",
	verification: "border-emerald-500/60 bg-emerald-500/10",
};

/** Solid role-colored fill used by contextual handles. */
const ROLE_HANDLE_COLORS: Record<PipelineStageV3["role"], string> = {
	scan: "bg-sky-500",
	analysis: "bg-amber-500",
	verification: "bg-emerald-500",
};

const ROLE_MINIMAP_COLORS: Record<PipelineStageV3["role"], string> = {
	scan: "#38bdf8",
	analysis: "#f59e0b",
	verification: "#34d399",
};

const roleLabel: Record<PipelineStageV3["role"], string> = {
	scan: "Scan",
	analysis: "Analysis",
	verification: "Verification",
};

export const MIN_READABLE_ZOOM = 0.55;
const FIT_ALL_MIN_ZOOM = 0.1;
const MINIMAP_SAFE_AREA = { width: 216, height: 166 };
/** How many forward-reachable ranks the initial fit keeps readable. */
const PRIMARY_PATH_PREFIX_LENGTH = 5;
const MINIMAP_HIDE_BELOW_WIDTH = 1000;

// ---------------------------------------------------------------------------
// Node / edge renderers
// ---------------------------------------------------------------------------

type StageNodeData = {
	stage: PipelineStageV3;
	isRoot: boolean;
	readOnly: boolean;
	isConnecting: boolean;
};

const PipelineStageNode = ({
	data,
	selected,
}: NodeProps<FlowNode<StageNodeData>>) => {
	const { stage, isRoot, readOnly, isConnecting } = data;
	const handleColor = ROLE_HANDLE_COLORS[stage.role];
	// Contextual handles: hidden at rest, solid role-colored on hover or
	// selection, ~18px transparent hit target, no white center. Read-only
	// and published views keep invisible handles in the DOM so React Flow can
	// resolve edge endpoints, but disable their interaction. Hover is driven by
	// the card's plain
	// `group` class (Tailwind-verifiable), while the handle keeps its own
	// named `group/handle` so the inner dot can react to React Flow's
	// connectingfrom/connectingto wrapper classes.
	const handleClass = cn(
		"transition-opacity duration-150",
		"opacity-0 group-hover:opacity-100",
		selected && "opacity-100",
	);
	const renderHandle = (
		id: string,
		position: Position,
		type: "source" | "target",
	) => {
		const interactionClass =
			type === "source"
				? isConnecting
					? "!pointer-events-none !opacity-0"
					: cn("!pointer-events-auto", handleClass)
				: isConnecting
					? "!pointer-events-auto !opacity-100"
					: "!pointer-events-none !opacity-0";
		return (
			<Handle
				id={id}
				type={type}
				position={position}
				aria-hidden={readOnly}
				className={cn(
					// Transparent 18px hit target: the wrapper itself must not paint
					// (React Flow's default handle background would turn the whole
					// 18px box into a visible dot). Only the inner 6px span is the
					// solid role-colored point. Named group lets the span react to
					// the wrapper's connection classes.
					"group/handle !size-[18px] !min-w-[18px] !min-h-[18px] !w-[18px] !h-[18px] !rounded-full !border-0 !bg-transparent",
					"!flex !items-center !justify-center",
					readOnly ? "!pointer-events-none !opacity-0" : interactionClass,
				)}
			>
				<span
					className={cn(
						// 6px solid dot; grows to 8px while a connection is being
						// dragged from/to this handle (React Flow adds connectingfrom /
						// connectingto to the handle wrapper during connection).
						"pointer-events-none block size-[6px] rounded-full transition-transform duration-150",
						handleColor,
						"group-[.connectingfrom]/handle:scale-[1.33] group-[.connectingto]/handle:scale-[1.33]",
					)}
				/>
			</Handle>
		);
	};
	return (
		<div
			className={cn(
				// Plain `group` drives handle hover; `rounded-[8px]` is the exact
				// plan-mandated corner radius (rounded-lg would compute to 10px).
				"group h-16 w-60 rounded-[8px] border bg-background p-3 shadow-sm transition-colors",
				ROLE_COLORS[stage.role],
				selected && "ring-2 ring-ring",
			)}
		>
			{/* Route-geometry handles. Strict connection mode: every side carries
			    BOTH a source and a target handle so forward edges (bottom→top /
			    right→left) and feedback lanes (left/right in DOWN, top/bottom in
			    RIGHT) each resolve to real source/target pairs. */}
			{renderHandle("top-source", Position.Top, "source")}
			{renderHandle("top-target", Position.Top, "target")}
			{renderHandle("bottom-source", Position.Bottom, "source")}
			{renderHandle("bottom-target", Position.Bottom, "target")}
			{renderHandle("left-source", Position.Left, "source")}
			{renderHandle("left-target", Position.Left, "target")}
			{renderHandle("right-source", Position.Right, "source")}
			{renderHandle("right-target", Position.Right, "target")}
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium leading-5">
						{stage.name}
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="truncate">{stage.group}</span>
						{stage.runtime.skills?.length ? (
							<span className="truncate">
								· {stage.runtime.skills.join(", ")}
							</span>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
						{roleLabel[stage.role]}
					</span>
					{isRoot ? (
						<span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
							root
						</span>
					) : null}
				</div>
			</div>
		</div>
	);
};

type GroupedEdgeData = {
	displayEdge: PipelineDisplayEdge;
	onSelectLabel?: (edgeId: string) => void;
};

/**
 * Pick the longest orthogonal segment of a path and return its midpoint,
 * so route labels sit on the safest readable stretch.
 */
const longestSegmentMidpoint = (
	points: Array<{ x: number; y: number }>,
): { x: number; y: number } | null => {
	if (points.length < 2) return null;
	let best: { x: number; y: number } | null = null;
	let bestLength = -1;
	for (let index = 0; index < points.length - 1; index += 1) {
		const a = points[index]!;
		const b = points[index + 1]!;
		const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
		if (length > bestLength) {
			bestLength = length;
			best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		}
	}
	return best;
};

const GroupedPipelineEdge = ({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	data,
	markerEnd,
	selected,
}: EdgeProps) => {
	const displayEdge = (data as GroupedEdgeData | undefined)?.displayEdge;
	const onSelectLabel = (data as GroupedEdgeData | undefined)?.onSelectLabel;
	const bendPoints = displayEdge?.bendPoints ?? [];
	const path = buildEdgePath(sourceX, sourceY, targetX, targetY, bendPoints);

	// Label position: longest orthogonal segment, or the path midpoint.
	const points = [
		{ x: sourceX, y: sourceY },
		...bendPoints,
		{ x: targetX, y: targetY },
	];
	const labelPosition = longestSegmentMidpoint(points) ?? {
		x: (sourceX + targetX) / 2,
		y: (sourceY + targetY) / 2,
	};

	// Plain edges already communicate direction with their arrow. Showing
	// generated ids such as `track-plan-to-vulnerability-discovery` makes the
	// graph look like a debug trace. Only explicit route conditions belong on
	// the canvas; grouped conditional edges remain fully selectable.
	const labels = (displayEdge?.labels ?? []).filter(
		(label) => !label.isDefault,
	);

	return (
		<>
			<g
				onClick={(event) => {
					event.stopPropagation();
					onSelectLabel?.(displayEdge?.memberEdgeIds[0] ?? id);
				}}
			>
				<BaseEdge
					id={id}
					path={path}
					markerEnd={markerEnd}
					className={cn(
						"transition-[stroke,stroke-width]",
						selected ? "stroke-foreground stroke-[2.5]" : "stroke-[1.8]",
					)}
				/>
			</g>
			{labels.length > 0 ? (
				<EdgeLabelRenderer>
					<div
						className="pointer-events-none absolute z-10"
						style={{
							transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`,
						}}
					>
						<div className="flex flex-wrap items-center justify-center gap-1">
							{labels.map((label) => (
								<button
									key={label.edgeId}
									type="button"
									onClick={(event) => {
										event.stopPropagation();
										onSelectLabel?.(label.edgeId);
									}}
									title={`Select edge ${label.edgeId}`}
									className={cn(
										"nodrag nopan pointer-events-auto rounded-full border bg-background/95 px-1.5 py-0.5 text-[10px] shadow-sm",
										"transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
										label.isDefault
											? "border-primary/50 font-medium text-primary"
											: "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
									)}
								>
									{label.label}
								</button>
							))}
						</div>
					</div>
				</EdgeLabelRenderer>
			) : onSelectLabel ? (
				<EdgeLabelRenderer>
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onSelectLabel(displayEdge?.memberEdgeIds[0] ?? id);
						}}
						title={`Select edge ${displayEdge?.memberEdgeIds[0] ?? id}`}
						aria-label={`Select edge ${displayEdge?.memberEdgeIds[0] ?? id}`}
						className="nodrag nopan pointer-events-auto absolute z-10 size-5 rounded-full opacity-0 outline-none hover:bg-primary/10 hover:opacity-100 focus-visible:bg-primary/10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
						style={{
							transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`,
						}}
					/>
				</EdgeLabelRenderer>
			) : null}
		</>
	);
};

const nodeTypes = { pipelineStage: PipelineStageNode };
const edgeTypes = { pipelineEdge: GroupedPipelineEdge };

// ---------------------------------------------------------------------------
// Canvas error boundary — keeps Raw YAML accessible if the canvas throws.
// ---------------------------------------------------------------------------

type CanvasErrorBoundaryProps = {
	children: React.ReactNode;
};

type CanvasErrorBoundaryState = {
	hasError: boolean;
	message: string;
};

class CanvasErrorBoundary extends React.Component<
	CanvasErrorBoundaryProps,
	CanvasErrorBoundaryState
> {
	state: CanvasErrorBoundaryState = { hasError: false, message: "" };

	static getDerivedStateFromError(error: unknown): CanvasErrorBoundaryState {
		return {
			hasError: true,
			message: error instanceof Error ? error.message : String(error),
		};
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
					<p className="text-sm font-medium text-destructive">
						The canvas hit an unexpected error.
					</p>
					<p
						className="max-w-md truncate text-xs text-muted-foreground"
						title={this.state.message}
					>
						{this.state.message}
					</p>
					<button
						type="button"
						onClick={() => this.setState({ hasError: false, message: "" })}
						className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
					>
						Reload canvas
					</button>
					<p className="text-xs text-muted-foreground">
						Your YAML is still available in the YAML tab.
					</p>
				</div>
			);
		}
		return this.props.children;
	}
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type CanvasEditorProps = {
	document: PipelineDocumentV3;
	readOnly: boolean;
	onChange?: (document: PipelineDocumentV3) => void;
	onSelect?: (entity: { type: "stage" | "edge"; id: string } | null) => void;
	onAddStage?: () => void;
	/** External selection (Inspector / diagnostics) kept in sync with canvas. */
	selection?: {
		type: "stage" | "edge" | "schema" | "group";
		id: string;
	} | null;
	className?: string;
};

type EditorFlowNode = FlowNode<StageNodeData>;
type EditorFlowEdge = FlowEdge & {
	data?: GroupedEdgeData;
};

const areFlowNodesEquivalent = (
	left: EditorFlowNode[],
	right: EditorFlowNode[],
): boolean => {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	return left.every((node, index) => {
		const other = right[index];
		if (!other) return false;
		return (
			node.id === other.id &&
			node.type === other.type &&
			node.selected === other.selected &&
			node.dragging === other.dragging &&
			node.hidden === other.hidden &&
			node.width === other.width &&
			node.height === other.height &&
			node.position.x === other.position.x &&
			node.position.y === other.position.y &&
			node.zIndex === other.zIndex &&
			node.data === other.data
		);
	});
};

const CanvasEditorInner = ({
	document,
	readOnly,
	onChange,
	onSelect,
	onAddStage,
	selection,
	className,
}: CanvasEditorProps) => {
	const { fitView, setCenter, getViewport, setViewport } = useReactFlow();
	const [interactionLock, setInteractionLock] = React.useState(false);
	const [isConnecting, setIsConnecting] = React.useState(false);
	const [minimapExpanded, setMinimapExpanded] = React.useState(false);

	// True once React Flow has measured every node, so fitView sees real
	// bounds instead of zeros (the first-open root-visibility fix).
	const nodesInitialized = useNodesInitialized();

	const legacyLayout = isLegacyLayout(document);
	// Legacy layouts must preview top-to-bottom regardless of the stale
	// `ui.direction` they carry; only non-legacy saved directions apply.
	const direction: PipelineLayoutDirection = legacyLayout
		? "DOWN"
		: (document.ui?.direction ?? "DOWN");
	// Stable references: document.ui?.nodes is a fresh object identity per
	// render when undefined, which would re-trigger the transient layout
	// effect on every render and drop every async result.
	const savedPositions = React.useMemo(
		() => document.ui?.nodes ?? {},
		[document.ui?.nodes],
	);

	// Display graph: one node per stage, grouped parallel edges.
	const displayGraph = React.useMemo(
		() => buildPipelineDisplayGraph(document),
		[document],
	);

	// Transient layout: computed when any node or route is missing, or the
	// saved layout is legacy. Node positions and edge geometry always come
	// from the same ELK result so they cannot drift apart.
	const [transientLayout, setTransientLayout] =
		React.useState<TransientPipelineLayout | null>(null);
	const layoutToken = React.useRef(0);

	const savedEdgeLayouts = document.ui?.edges ?? {};
	const needsTransient =
		legacyLayout ||
		Object.keys(document.stages).some((id) => !savedPositions[id]) ||
		displayGraph.edges.some((edge) => {
			const saved = savedEdgeLayouts[edge.id];
			return !saved?.sourceHandle || !saved.targetHandle;
		});

	React.useEffect(() => {
		if (!needsTransient) {
			setTransientLayout(null);
			return;
		}
		const token = ++layoutToken.current;
		void computePipelineLayout(
			document,
			direction,
			legacyLayout ? undefined : savedPositions,
		).then((result) => {
			if (token !== layoutToken.current) return; // stale
			setTransientLayout(result);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [document, direction, needsTransient, legacyLayout, savedPositions]);

	const positions = React.useMemo(
		() => transientLayout?.nodes ?? resolveStagePositions(document, {}),
		[document, transientLayout],
	);

	const selectedEdgeId =
		selection?.type === "edge"
			? document.edges.find((edge) => edge.id === selection.id)
				? selection.id
				: null
			: null;
	const selectedStageId = selection?.type === "stage" ? selection.id : null;

	const nodes: EditorFlowNode[] = React.useMemo(() => {
		const result: EditorFlowNode[] = [];
		for (const id of displayGraph.stageOrder) {
			const stage = document.stages[id];
			if (!stage) continue;
			result.push({
				id,
				type: "pipelineStage",
				position: positions[id] ?? { x: 0, y: 0 },
				// MiniMap renders before the custom node's CSS dimensions have
				// necessarily been measured. Seed the same dimensions used by the
				// node card so the first minimap pass cannot drop every node.
				initialWidth: NODE_WIDTH,
				initialHeight: NODE_HEIGHT,
				selected: id === selectedStageId,
				data: {
					stage,
					isRoot: id === document.root,
					readOnly,
					isConnecting,
				},
			});
		}
		return result;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		document,
		readOnly,
		isConnecting,
		positions,
		displayGraph,
		selectedStageId,
	]);

	const edges: EditorFlowEdge[] = React.useMemo(() => {
		// Stable persisted geometry wins only when the complete layout is
		// current. Otherwise all nodes and routes use the same transient ELK
		// result. The renderer does not repair or independently reroute edges.
		const persistedEdges = isLegacyLayout(document)
			? {}
			: (document.ui?.edges ?? {});
		const transientEdges = transientLayout?.edges ?? {};
		return displayGraph.edges.map((displayEdge) => {
			const stable =
				transientEdges[displayEdge.id] ?? persistedEdges[displayEdge.id];
			const fallbackHandles = defaultHandlesForDisplayEdge(
				displayEdge,
				direction,
			);
			const sourceHandle = stable?.sourceHandle ?? fallbackHandles.sourceHandle;
			const targetHandle = stable?.targetHandle ?? fallbackHandles.targetHandle;
			const bendPoints = stable?.bendPoints ?? [];
			return {
				id: displayEdge.id,
				source: displayEdge.from,
				target: displayEdge.to,
				// Read-only nodes still render invisible Handles. Keep the explicit
				// ids so React Flow can resolve the exact persisted port geometry.
				sourceHandle,
				targetHandle,
				type: "pipelineEdge",
				selected:
					selectedEdgeId !== null &&
					displayEdge.memberEdgeIds.includes(selectedEdgeId),
				data: {
					displayEdge: {
						...displayEdge,
						bendPoints,
						sourceHandle,
						targetHandle,
					},
					onSelectLabel: (edgeId) => onSelect?.({ type: "edge", id: edgeId }),
				},
				markerEnd: { type: MarkerType.ArrowClosed },
			};
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		displayGraph,
		selectedEdgeId,
		transientLayout,
		document,
		direction,
		onSelect,
	]);

	const [localNodes, setLocalNodes] = React.useState<EditorFlowNode[]>(nodes);
	React.useEffect(() => {
		setLocalNodes((previous) =>
			areFlowNodesEquivalent(previous, nodes) ? previous : nodes,
		);
	}, [nodes]);

	// Canvas size tracking: ResizeObserver (not only window.resize) so
	// Inspector toggles and sidebar changes trigger settled refits.
	const canvasRef = React.useRef<HTMLDivElement>(null);
	const [canvasWidth, setCanvasWidth] = React.useState(0);

	// Minimap hidden by default below 1000px canvas width; user can expand.
	const minimapVisible =
		canvasWidth >= MINIMAP_HIDE_BELOW_WIDTH || minimapExpanded;

	const ensureMinimapClearance = React.useCallback(
		(targetIds: string[]) => {
			const canvas = canvasRef.current;
			if (!minimapVisible || targetIds.length === 0 || !canvas) return;
			const viewport = getViewport();
			const minimapLeft = canvas.clientWidth - MINIMAP_SAFE_AREA.width - 12;
			const minimapTop = canvas.clientHeight - MINIMAP_SAFE_AREA.height - 12;
			let maxOverlapX = 0;
			let maxOverlapY = 0;
			for (const id of targetIds) {
				const position = positions[id];
				if (!position) continue;
				const screenX = (position.x + NODE_WIDTH) * viewport.zoom + viewport.x;
				const screenY = (position.y + NODE_HEIGHT) * viewport.zoom + viewport.y;
				const overlapX =
					Math.min(screenX, minimapLeft + MINIMAP_SAFE_AREA.width) -
					minimapLeft;
				const overlapY =
					Math.min(screenY, minimapTop + MINIMAP_SAFE_AREA.height) - minimapTop;
				if (overlapX > 0 && overlapY > 0) {
					maxOverlapX = Math.max(maxOverlapX, overlapX);
					maxOverlapY = Math.max(maxOverlapY, overlapY);
				}
			}
			if (maxOverlapX > 0 || maxOverlapY > 0) {
				void setViewport({
					...viewport,
					x: viewport.x - maxOverlapX - 24,
					y: viewport.y - maxOverlapY - 24,
				});
			}
		},
		[minimapVisible, positions, getViewport, setViewport],
	);

	// Initial / Fit view: fit the root and a readable *prefix* of the forward
	// path (root + the first few forward-reachable ranks). Fitting every
	// reachable stage at minZoom 0.55 can overflow the viewport and push the
	// root above the pane; a prefix keeps the top of the graph readable.
	// Explicit Fit All may zoom farther out. After any fit, clamp the viewport
	// so the root stays inside the pane (minZoom overflow, resize, inspector
	// toggles all funnel through here).
	const fitInitialView = React.useCallback(
		(forceAll: boolean) => {
			const reachableIds = displayGraph.stageOrder.filter(
				(id) => displayGraph.nodes.get(id)?.reachableFromRoot,
			);
			const targetIds = forceAll
				? displayGraph.stageOrder
				: reachableIds.slice(0, PRIMARY_PATH_PREFIX_LENGTH).length > 0
					? reachableIds.slice(0, PRIMARY_PATH_PREFIX_LENGTH)
					: [document.root];
			void fitView({
				padding: minimapVisible ? 0.32 : 0.2,
				minZoom: forceAll ? FIT_ALL_MIN_ZOOM : MIN_READABLE_ZOOM,
				duration: forceAll ? 300 : 0,
				nodes: targetIds.map((id) => ({ id })) as never,
			});
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					const rootPos = positions[document.root];
					if (!rootPos) return;
					const { x, y, zoom } = getViewport();
					const rootScreenY = rootPos.y * zoom + y;
					const rootScreenX = rootPos.x * zoom + x;
					const canvas = canvasRef.current;
					if (!canvas) return;
					const topOverflow = rootScreenY < 8;
					const leftOverflow = rootScreenX < 8;
					const bottomOverflow =
						rootScreenY + NODE_HEIGHT * zoom > canvas.clientHeight - 8;
					const rightOverflow =
						rootScreenX + NODE_WIDTH * zoom > canvas.clientWidth - 8;
					if (topOverflow || leftOverflow || bottomOverflow || rightOverflow) {
						const nextY = topOverflow
							? 24 - rootPos.y * zoom
							: bottomOverflow
								? canvas.clientHeight - 24 - (rootPos.y + NODE_HEIGHT) * zoom
								: y;
						const nextX = leftOverflow
							? 24 - rootPos.x * zoom
							: rightOverflow
								? canvas.clientWidth - 24 - (rootPos.x + NODE_WIDTH) * zoom
								: x;
						void setViewport({ x: nextX, y: nextY, zoom });
					}
				});
			});
			void ensureMinimapClearance(targetIds);
		},
		[
			displayGraph,
			minimapVisible,
			fitView,
			positions,
			document.root,
			getViewport,
			setViewport,
			ensureMinimapClearance,
		],
	);

	React.useEffect(() => {
		const el = canvasRef.current;
		if (!el) return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const { width } = entry.contentRect;
			setCanvasWidth(width);
			requestAnimationFrame(() =>
				requestAnimationFrame(() => void fitInitialView(false)),
			);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [fitInitialView]);

	// First-open fit waits until both node measurement and asynchronous ELK
	// layout have settled; otherwise React Flow can fit zero-sized bounds.
	const didInitialFit = React.useRef(false);
	React.useEffect(() => {
		if (!nodesInitialized) return;
		if (needsTransient && !transientLayout) return;
		if (didInitialFit.current) return;
		didInitialFit.current = true;
		requestAnimationFrame(() => void fitInitialView(false));
	}, [nodesInitialized, needsTransient, transientLayout, fitInitialView]);

	const persistUi = React.useCallback(
		(
			nextNodes: Record<string, { x: number; y: number }>,
			nextEdges?: Record<string, PipelineLayoutEdge>,
		) => {
			if (readOnly || !onChange) return;
			onChange({
				...document,
				ui: {
					layoutVersion: CURRENT_PIPELINE_LAYOUT_VERSION,
					direction,
					nodes: nextNodes,
					...(nextEdges ? { edges: nextEdges } : {}),
				},
			});
		},
		[document, readOnly, onChange, direction],
	);

	const onNodesChange = React.useCallback(
		(changes: NodeChange<EditorFlowNode>[]) => {
			if (changes.length === 0) return;
			setLocalNodes((previous) => {
				const next = applyNodeChanges(changes, previous) as EditorFlowNode[];
				return areFlowNodesEquivalent(previous, next) ? previous : next;
			});
		},
		[],
	);

	const selectEdge = React.useCallback(
		(edge: EditorFlowEdge) => {
			onSelect?.({
				type: "edge",
				id:
					(edge.data as GroupedEdgeData | undefined)?.displayEdge
						?.memberEdgeIds[0] ?? edge.id,
			});
		},
		[onSelect],
	);

	// Dragging supplies preferred positions to ELK's interactive layered mode.
	// The resulting full graph is persisted atomically, so moving one stage
	// never leaves stale routes attached to the old node bounds.
	const dragLayoutToken = React.useRef(0);
	const onNodeDragStop: OnNodeDrag<EditorFlowNode> = React.useCallback(
		(_event, node) => {
			const nextNodes = { ...positions };
			for (const current of localNodes) {
				nextNodes[current.id] = {
					x: Math.round(current.position.x),
					y: Math.round(current.position.y),
				};
			}
			nextNodes[node.id] = {
				x: Math.round(node.position.x),
				y: Math.round(node.position.y),
			};
			const token = ++dragLayoutToken.current;
			void computePipelineLayout(document, direction, nextNodes).then(
				(result) => {
					if (token !== dragLayoutToken.current) return;
					const expandedEdges = expandPersistedEdgeLayout(
						displayGraph.edges.map((displayEdge) => ({
							...displayEdge,
							...(result.edges[displayEdge.id] ??
								defaultHandlesForDisplayEdge(displayEdge, direction)),
							bendPoints: result.edges[displayEdge.id]?.bendPoints ?? [],
						})),
					);
					persistUi(result.nodes, expandedEdges);
				},
			);
		},
		[localNodes, positions, persistUi, displayGraph, direction, document],
	);

	const onConnect = React.useCallback(
		(connection: Connection) => {
			if (readOnly || !onChange) return;
			const { source, target } = connection;
			if (!source || !target) return;
			const id = nextUniqueId(
				`${source}-to-${target}`,
				new Set(document.edges.map((edge) => edge.id)),
			);
			const nextEdge = defaultEdgeFactory(id, source, target);
			onChange({
				...document,
				edges: [...document.edges, nextEdge],
			});
		},
		[document, readOnly, onChange],
	);

	const createStage = React.useCallback(
		(id: string, stage: PipelineStageV3) => {
			if (readOnly || !onChange) return;
			onChange({
				...document,
				stages: { ...document.stages, [id]: stage },
			});
			onSelect?.({ type: "stage", id });
		},
		[document, onChange, onSelect, readOnly],
	);

	const onNodesDelete = React.useCallback(
		(deleted: Array<{ id: string }>) => {
			if (readOnly || !onChange) return;
			const deletedIds = new Set(deleted.map((node) => node.id));
			const nextStages: PipelineDocumentV3["stages"] = {};
			for (const [id, stage] of Object.entries(document.stages)) {
				if (!deletedIds.has(id)) nextStages[id] = stage;
			}
			const nextRoot =
				document.root in nextStages
					? document.root
					: (Object.keys(nextStages)[0] ?? document.root);
			const nextUiNodes: Record<string, { x: number; y: number }> = {};
			for (const [id, position] of Object.entries(savedPositions)) {
				if (!deletedIds.has(id)) nextUiNodes[id] = position;
			}
			onChange({
				...document,
				root: nextRoot,
				stages: nextStages,
				edges: document.edges.filter(
					(edge) => !deletedIds.has(edge.from) && !deletedIds.has(edge.to),
				),
				ui: {
					layoutVersion: CURRENT_PIPELINE_LAYOUT_VERSION,
					direction,
					nodes: nextUiNodes,
				},
			});
		},
		[document, readOnly, onChange, direction, savedPositions],
	);

	const onEdgesDelete = React.useCallback(
		(deleted: Array<{ id: string }>) => {
			if (readOnly || !onChange) return;
			const deletedIds = new Set(deleted.map((edge) => edge.id));
			const nextEdges = document.edges.filter(
				(edge) => !deletedIds.has(edge.id),
			);
			const nextBendPoints: Record<string, PipelineLayoutEdge> = {};
			for (const [id, bend] of Object.entries(document.ui?.edges ?? {})) {
				if (!deletedIds.has(id) && bend.sourceHandle && bend.targetHandle) {
					nextBendPoints[id] = {
						bendPoints: bend.bendPoints,
						sourceHandle: bend.sourceHandle,
						targetHandle: bend.targetHandle,
					};
				}
			}
			onChange({
				...document,
				edges: nextEdges,
				ui: {
					layoutVersion: CURRENT_PIPELINE_LAYOUT_VERSION,
					direction,
					nodes: savedPositions,
					...(Object.keys(nextBendPoints).length
						? { edges: nextBendPoints }
						: {}),
				},
			});
		},
		[document, readOnly, onChange, direction, savedPositions],
	);

	const applyLayout = React.useCallback(async () => {
		if (readOnly || !onChange) return;
		const result = await computePipelineLayout(document, direction);
		const expandedEdges = expandPersistedEdgeLayout(
			displayGraph.edges.map((displayEdge) => ({
				...displayEdge,
				...(result.edges[displayEdge.id] ??
					defaultHandlesForDisplayEdge(displayEdge, direction)),
				bendPoints: result.edges[displayEdge.id]?.bendPoints ?? [],
			})),
		);
		persistUi(result.nodes, expandedEdges);
		requestAnimationFrame(() =>
			requestAnimationFrame(() => void fitInitialView(false)),
		);
	}, [
		document,
		readOnly,
		onChange,
		persistUi,
		direction,
		displayGraph,
		fitInitialView,
	]);

	const switchDirection = React.useCallback(
		(next: PipelineLayoutDirection) => {
			if (readOnly || !onChange) return;
			// Compute with the *new* direction immediately — applyLayout would
			// still see the previous document/direction in its closure.
			void computePipelineLayout(document, next).then((result) => {
				const expandedEdges = expandPersistedEdgeLayout(
					displayGraph.edges.map((displayEdge) => ({
						...displayEdge,
						...(result.edges[displayEdge.id] ??
							defaultHandlesForDisplayEdge(displayEdge, next)),
						bendPoints: result.edges[displayEdge.id]?.bendPoints ?? [],
					})),
				);
				onChange({
					...document,
					ui: {
						layoutVersion: CURRENT_PIPELINE_LAYOUT_VERSION,
						direction: next,
						nodes: result.nodes,
						edges: expandedEdges,
					},
				});
				requestAnimationFrame(() => void fitInitialView(false));
			});
		},
		[document, readOnly, onChange, displayGraph, fitInitialView],
	);

	const centerRoot = React.useCallback(() => {
		const rootPosition = positions[document.root];
		if (!rootPosition) return;
		void setCenter(
			rootPosition.x + NODE_WIDTH / 2,
			rootPosition.y + NODE_HEIGHT / 2,
			{
				zoom: 1,
				duration: 300,
			},
		);
	}, [positions, document.root, setCenter]);

	return (
		<div
			ref={canvasRef}
			className={cn("relative h-full min-h-0 w-full overflow-hidden", className)}
		>
			{!readOnly && (
				<div className="absolute left-3 top-3 z-10 flex flex-col gap-1.5 rounded-lg border bg-background/95 p-1.5 shadow-sm">
					{onAddStage ? (
						<ToolbarButton label="Add stage" onClick={onAddStage}>
							<Plus className="size-4" />
						</ToolbarButton>
					) : (
						<StageCreateDialog
							existingIds={Object.keys(document.stages)}
							defaultGroup={document.groups[0]?.id}
							onCreate={createStage}
							trigger={
								<ToolbarButton label="Add stage" onClick={() => undefined}>
									<Plus className="size-4" />
								</ToolbarButton>
							}
						/>
					)}
					<ToolbarButton
						label="Apply ELK layout"
						onClick={() => void applyLayout()}
					>
						<LayoutGrid className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label="Direction: DOWN"
						active={direction === "DOWN"}
						onClick={() => void switchDirection("DOWN")}
					>
						<AlignStartVertical className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label="Direction: RIGHT"
						active={direction === "RIGHT"}
						onClick={() => void switchDirection("RIGHT")}
					>
						<AlignStartHorizontal className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label="Center root stage"
						onClick={() => void centerRoot()}
					>
						<Focus className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label="Fit all stages"
						onClick={() => {
							// A manual fit wins over any first-open fit that is still queued
							// behind asynchronous ELK layout or node measurement.
							didInitialFit.current = true;
							void fitInitialView(true);
						}}
					>
						<Maximize2 className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label={minimapVisible ? "Hide minimap" : "Show minimap"}
						active={minimapVisible}
						onClick={() => setMinimapExpanded((expanded) => !expanded)}
					>
						{minimapVisible ? (
							<Minimize2 className="size-4" />
						) : (
							<Maximize2 className="size-4" />
						)}
					</ToolbarButton>
					<ToolbarButton
						label={interactionLock ? "Unlock canvas" : "Lock canvas"}
						active={interactionLock}
						onClick={() => setInteractionLock((locked) => !locked)}
					>
						{interactionLock ? (
							<Lock className="size-4" />
						) : (
							<MousePointer2 className="size-4" />
						)}
					</ToolbarButton>
				</div>
			)}

			<ReactFlow
				nodes={localNodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodesChange={onNodesChange}
				onNodesDelete={onNodesDelete}
				onEdgesDelete={onEdgesDelete}
				onConnect={onConnect}
				onConnectStart={() => setIsConnecting(true)}
				onConnectEnd={() => setIsConnecting(false)}
				onNodeDragStop={onNodeDragStop}
				onNodeClick={(_event, node) =>
					onSelect?.({ type: "stage", id: node.id })
				}
				onEdgeClick={(_event, edge) => selectEdge(edge)}
				onPaneClick={(event) => {
					if ((event.target as Element).classList.contains("react-flow__pane")) {
						onSelect?.(null);
					}
				}}
				nodesDraggable={!readOnly && !interactionLock}
				nodesConnectable={!readOnly && !interactionLock}
				elementsSelectable={!interactionLock}
				nodesFocusable={false}
				autoPanOnNodeFocus={false}
				preventScrolling
				minZoom={0.1}
				proOptions={{ hideAttribution: true }}
			>
				<Background gap={32} size={1} color="#d5dbe5" />
				{minimapVisible ? (
					<MiniMap
						pannable
						zoomable
						className="!bottom-3 !right-3 !h-[132px] !w-[180px]"
						nodeColor={(node) =>
							ROLE_MINIMAP_COLORS[
								(node.data as StageNodeData | undefined)?.stage.role ?? "scan"
							] ?? "#94a3b8"
						}
						nodeStrokeColor="#ffffff"
						nodeStrokeWidth={2}
						maskColor="rgba(0,0,0,0.1)"
					/>
				) : null}
				<Controls />
			</ReactFlow>
		</div>
	);
};

export const CanvasEditor = (props: CanvasEditorProps) => (
	<CanvasErrorBoundary>
		<ReactFlowProvider>
			<CanvasEditorInner {...props} />
		</ReactFlowProvider>
	</CanvasErrorBoundary>
);

const ToolbarButton = React.forwardRef<
	HTMLButtonElement,
	{
		label: string;
		onClick: () => void;
		active?: boolean;
		children: React.ReactNode;
	}
>(({ label, onClick, active = false, children }, ref) => (
	<button
		ref={ref}
		type="button"
		title={label}
		aria-label={label}
		onClick={onClick}
		className={cn(
			"inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
			active && "bg-primary/10 text-primary",
		)}
	>
		{children}
	</button>
));

ToolbarButton.displayName = "ToolbarButton";
