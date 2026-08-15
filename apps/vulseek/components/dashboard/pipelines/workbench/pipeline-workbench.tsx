import * as React from "react";
import {
	AlertTriangle,
	ChevronLeft,
	ChevronRight,
	GripVertical,
	PanelRightClose,
	PanelRightOpen,
} from "lucide-react";
import type {
	PipelineDiagnostic,
	PipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	parsePipelineDocumentV3,
	validatePipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { CanvasEditor } from "@/components/dashboard/pipelines/canvas-editor";
import { DiagnosticsBar } from "@/components/dashboard/pipelines/diagnostics-bar";
import { PipelineInspector } from "@/components/dashboard/pipelines/pipeline-inspector";
import { YamlEditor, type YamlEditorHandle } from "@/components/dashboard/pipelines/yaml-editor";
import { DashboardPageTabs } from "@/components/dashboard/ui-system";
import type {
	PipelineEditorAction,
	PipelineEditorState,
} from "@/lib/pipeline-editor/pipeline-editor-state";
import { validDocument } from "@/lib/pipeline-editor/pipeline-editor-state";
import { filterVisibleSchemaDiagnostics } from "@/lib/pipeline-editor/definition-helpers";
import { cn } from "@/lib/utils";
import { DefinitionView, type DrillLevel } from "./definition-view";
import { QuickSwitcher } from "./quick-switcher";

/**
 * Pipeline Definition Workbench: one local draft, three synchronized views.
 *
 * - Definition: three-column structured editing (rail → list → editor) with
 *   typed YAML patches, diagnostics badges, CRUD, and reference navigation.
 * - Visual: React Flow + ELK canvas with a resizable Inspector, sharing the
 *   selection and document with the other views.
 * - Raw YAML: the existing CodeMirror editor, retained as the advanced and
 *   diagnostic interface; diagnostics focus reveals source ranges here.
 *
 * All views read the same reducer state (one undo/redo history, one dirty
 * flag). On narrow screens the Definition columns become drill-down screens
 * and the Inspector becomes an overlay sheet.
 */

export type WorkbenchView = "definition" | "visual" | "raw" | "profiles";

export type PipelineWorkbenchProps = {
	state: PipelineEditorState;
	dispatch: React.Dispatch<PipelineEditorAction>;
	/** Read-only mode: published/version view (no mutations anywhere). */
	readOnly: boolean;
	/** Version YAML rendered by all three views in read-only mode (the
	 *  reducer keeps the draft, which must not leak into the version view). */
	readOnlyYaml?: string;
	/** Label shown when viewing a published version (e.g. "v3 · source"). */
	versionLabel?: string | null;
	draftState: { dirty: boolean; draftRevision: number; publishedVersion: string | null };
	/** Raw YAML editor handle, for the page to flush before saving. */
	onYamlReady?: (handle: YamlEditorHandle | null) => void;
	initialView?: WorkbenchView;
	profilesContent?: React.ReactNode;
	onViewChange?: (view: WorkbenchView) => void;
};

const useMediaQuery = (query: string): boolean => {
	const [matches, setMatches] = React.useState(false);
	React.useEffect(() => {
		const media = window.matchMedia(query);
		const update = () => setMatches(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, [query]);
	return matches;
};

export const PipelineWorkbench = ({
	state,
	dispatch,
	readOnly,
	readOnlyYaml,
	versionLabel,
	draftState,
	onYamlReady,
	initialView,
	profilesContent,
	onViewChange,
}: PipelineWorkbenchProps) => {
	const [view, setView] = React.useState<WorkbenchView>(initialView ?? "definition");
	React.useEffect(() => {
		if (initialView) setView(initialView);
	}, [initialView]);
	const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
	const [switcherOpen, setSwitcherOpen] = React.useState(false);
	const [drill, setDrill] = React.useState<DrillLevel>("rail");

	// Responsive: definition columns drill down below 900px; the Inspector
	// becomes an overlay sheet below 1100px.
	const narrowDefinition = useMediaQuery("(max-width: 900px)");
	const narrowInspector = useMediaQuery("(max-width: 1100px)");
	const [inspectorOpen, setInspectorOpen] = React.useState(!narrowInspector);
	React.useEffect(() => {
		if (narrowInspector) setInspectorOpen(false);
	}, [narrowInspector]);

	const INSPECTOR_STORAGE_KEY = "pipeline-editor:inspector-width";
	const [inspectorWidth, setInspectorWidth] = React.useState(() => {
		if (typeof window === "undefined") return 360;
		const stored = Number.parseInt(
			window.localStorage.getItem(INSPECTOR_STORAGE_KEY) ?? "",
			10,
		);
		return Number.isFinite(stored) && stored >= 300 && stored <= 480 ? stored : 360;
	});
	const inspectorRef = React.useRef<HTMLDivElement>(null);
	const [resizingInspector, setResizingInspector] = React.useState(false);

	const startInspectorResize = React.useCallback((event: React.PointerEvent) => {
		event.preventDefault();
		setResizingInspector(true);
		const startX = event.clientX;
		const startWidth = inspectorRef.current?.getBoundingClientRect().width ?? 360;
		const onMove = (moveEvent: PointerEvent) => {
			const delta = startX - moveEvent.clientX; // drag left = wider
			setInspectorWidth(Math.min(480, Math.max(300, startWidth + delta)));
		};
		const onUp = () => {
			setResizingInspector(false);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.localStorage.setItem(
				INSPECTOR_STORAGE_KEY,
				String(inspectorRef.current?.getBoundingClientRect().width ?? 360),
			);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, []);

	// Ctrl/Cmd+P quick switcher.
	React.useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
				event.preventDefault();
				setSwitcherOpen(true);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	const document = validDocument(state);
	const staleDocument =
		state.status.kind === "valid" && state.status.stale && !readOnly;
	const editable = !readOnly && state.status.kind === "valid" && !state.status.stale;
	const yamlEditorRef = React.useRef<YamlEditorHandle | null>(null);

	// Read-only mode renders the *version* YAML, never the reducer draft.
	const readOnlyAnalysis = React.useMemo(() => {
		if (!readOnly || !readOnlyYaml) return null;
		const parsed = parsePipelineDocumentV3(readOnlyYaml);
		const semantic = parsed.document
			? validatePipelineDocumentV3(parsed.document)
			: [];
		return {
			document: parsed.document,
			diagnostics: [...parsed.diagnostics, ...semantic],
			yaml: readOnlyYaml,
		};
	}, [readOnly, readOnlyYaml]);
	const viewDocument = readOnly ? (readOnlyAnalysis?.document ?? null) : document;
	const rawViewDiagnostics = readOnly
		? (readOnlyAnalysis?.diagnostics ?? [])
		: state.diagnostics;
	const viewDiagnostics = filterVisibleSchemaDiagnostics(viewDocument, rawViewDiagnostics);
	const viewYaml = readOnly ? (readOnlyAnalysis?.yaml ?? "") : state.rawYamlBuffer;

	const errorCount = viewDiagnostics.filter((d) => d.severity === "error").length;
	const warningCount = viewDiagnostics.filter((d) => d.severity === "warning").length;

	const navigateToDefinition = React.useCallback(() => {
		setView("definition");
		if (narrowDefinition) setDrill("editor");
	}, [narrowDefinition]);

	const handleDiagnosticsSelect = (diagnostic: PipelineDiagnostic) => {
		const entity = diagnostic.entity;
		if (entity && entity.type !== "pipeline") {
			// Focus the referenced entity in the Definition view; the shared
			// selection also highlights it on the Visual canvas.
			dispatch({ type: "select", entity: { type: entity.type, id: entity.id } });
			setView("definition");
			if (narrowDefinition) setDrill("editor");
			return;
		}
		// No visual entity: reveal the source range in Raw YAML.
		if (diagnostic.location) {
			setView("raw");
			requestAnimationFrame(() => {
				yamlEditorRef.current?.reveal(
					diagnostic.location?.line ?? 1,
					diagnostic.location?.column ?? 1,
				);
			});
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* View tabs: use the same sub-navigation treatment as project pages. */}
			<DashboardPageTabs
				tabs={[
					{ value: "definition", label: "Definition" },
					{ value: "visual", label: "Visual" },
					{ value: "raw", label: "Raw YAML" },
					{ value: "profiles", label: "Profiles" },
				]}
				fallback="definition"
				activeValue={view}
				onTabChange={(value) => {
					const nextView = value as WorkbenchView;
					setView(nextView);
					onViewChange?.(nextView);
				}}
				trailing={
					<>
					{view !== "profiles" && readOnly && versionLabel ? (
						<span className="text-xs text-muted-foreground">
							Read-only view of {versionLabel}
						</span>
					) : null}
					{state.canvasTouched && view !== "visual" && view !== "profiles" ? (
						<span className="text-xs text-muted-foreground">
							Canvas edits use stable serialization — original comments may be rewritten.
						</span>
					) : null}
					{view !== "profiles" && state.patchError ? (
						<span
							className="rounded bg-red-500/10 px-2 py-0.5 text-xs text-red-600"
							title={state.patchError}
						>
							Patch failed: {state.patchError}
						</span>
					) : null}
					{view !== "visual" && view !== "profiles" ? (
						<button
							type="button"
							onClick={() => setInspectorOpen((open) => !open)}
							className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
							aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
						>
							{inspectorOpen ? (
								<PanelRightClose className="size-4" />
							) : (
								<PanelRightOpen className="size-4" />
							)}
						</button>
					) : null}
					</>
				}
			/>

			{/* View body */}
			<div
				className={cn(
					"flex w-full min-w-0 p-4 pt-5 sm:px-6",
					view === "profiles" ? "flex-none" : "min-h-0 flex-1",
				)}
			>
				<div
					className={cn(
						"w-full min-w-0 rounded-xl border bg-background shadow-sm",
						view === "profiles"
							? "overflow-visible"
							: "flex min-h-0 flex-1 overflow-hidden",
					)}
				>
					<div
						className={cn(
							"relative flex w-full min-w-0 flex-col",
							view === "profiles" ? "" : "h-full min-h-0 flex-1",
						)}
					>
					{view === "definition" && viewDocument ? (
						<DefinitionView
							document={viewDocument}
							state={state}
							dispatch={dispatch}
							readOnly={readOnly}
							draftState={draftState}
							narrow={narrowDefinition}
							drill={drill}
							setDrill={setDrill}
							onSelect={(entity) => dispatch({ type: "select", entity })}
							onNavigateToVisual={() => setView("visual")}
						/>
					) : null}
					{view === "definition" && !viewDocument ? (
						<div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
							{state.status.kind === "invalid" || state.status.kind === "empty"
								? "The YAML does not parse yet — fix it in Raw YAML to unlock structured editing."
								: "Nothing to show yet."}
						</div>
					) : null}

					{view === "visual" && viewDocument ? (
						<>
							{staleDocument ? (
								<div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-600">
									<AlertTriangle className="size-3.5 shrink-0" />
									<span>
										The YAML does not parse — visual edits are disabled. Fix the YAML or
										undo to restore editing.
									</span>
								</div>
							) : null}
							<div className="flex h-full min-h-0 overflow-hidden">
								<div
									data-testid="pipeline-visual-canvas"
									className="relative min-h-0 min-w-0 flex-1 overflow-hidden isolate"
								>
									<CanvasEditor
										document={viewDocument}
										readOnly={readOnly || staleDocument}
										selection={state.selectedEntity}
										onChange={(next) =>
											dispatch({ type: "canvasModified", document: next })
										}
										onSelect={(entity) => dispatch({ type: "select", entity: entity as never })}
									/>
								</div>
								{editable && inspectorOpen ? (
									<aside
										ref={inspectorRef}
										className={cn(
											"shrink-0 border-l bg-background",
											narrowInspector
												? "absolute inset-y-0 right-0 z-30 max-w-[85%] shadow-xl"
												: "relative",
											resizingInspector && "select-none",
										)}
										style={narrowInspector ? undefined : { width: inspectorWidth }}
									>
										<div className="flex h-9 items-center justify-between border-b px-3">
											<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
												Inspector
											</span>
											<div className="flex items-center gap-1">
												{!narrowInspector ? (
													<button
														type="button"
														onPointerDown={startInspectorResize}
														className="h-5 w-4 cursor-ew-resize text-muted-foreground hover:text-foreground"
														aria-label="Resize inspector"
													>
														<GripVertical className="mx-auto size-3.5" />
													</button>
												) : null}
												<button
													type="button"
													onClick={() => setInspectorOpen(false)}
													className="text-muted-foreground hover:text-foreground"
													aria-label="Collapse inspector"
												>
													<ChevronRight className="size-4" />
												</button>
											</div>
										</div>
										<div className="h-[calc(100%-2.25rem)]">
										<PipelineInspector
											document={viewDocument}
											selection={state.selectedEntity as never}
											showPipelineSchemas={false}
											onChange={(next) =>
													dispatch({ type: "canvasModified", document: next })
												}
												onSelect={(entity) => {
													dispatch({
														type: "select",
														entity: entity as never,
													});
													if (entity.type === "schema") navigateToDefinition();
												}}
											/>
										</div>
									</aside>
								) : null}
							</div>
						</>
					) : null}
					{view === "visual" && !viewDocument ? (
						<div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
							{state.status.kind === "invalid" || state.status.kind === "empty"
								? "The YAML does not parse yet — the canvas shows the last valid document in Raw YAML mode only."
								: "Nothing to render yet."}
						</div>
					) : null}

					{view === "raw" ? (
						<YamlEditor
							ref={(handle) => {
								yamlEditorRef.current = handle;
								onYamlReady?.(handle);
							}}
							value={viewYaml}
							onChange={(yaml) => dispatch({ type: "setBuffer", yaml })}
							diagnostics={viewDiagnostics}
							readOnly={readOnly}
						/>
					) : null}
					{view === "profiles" ? profilesContent : null}
					</div>
				</div>
			</div>

			{/* Diagnostics panel */}
			{view === "profiles" ? null : readOnly ? (
				<div className="flex h-8 shrink-0 items-center border-t px-3 text-xs text-muted-foreground">
					Read-only view{versionLabel ? ` of ${versionLabel}` : ""}
					<span className="ml-auto">Use "Copy to draft" in the header to edit.</span>
				</div>
			) : (
				<div className="shrink-0 border-t">
					<button
						type="button"
						onClick={() => setDiagnosticsOpen((open) => !open)}
						className="flex h-8 w-full items-center justify-between px-3 text-xs text-muted-foreground hover:bg-muted/40"
					>
						<span>
							Diagnostics: {errorCount} error(s), {warningCount} warning(s)
						</span>
						{diagnosticsOpen ? (
							<ChevronLeft className="size-3.5" />
						) : (
							<ChevronRight className="size-3.5" />
						)}
					</button>
					{diagnosticsOpen ? (
						<div className="max-h-40 overflow-y-auto border-t">
							<DiagnosticsBar
								diagnostics={viewDiagnostics}
								onSelect={handleDiagnosticsSelect}
							/>
						</div>
					) : null}
				</div>
			)}

			<QuickSwitcher
				open={switcherOpen}
				onOpenChange={setSwitcherOpen}
				document={
					viewDocument ?? {
						version: 3,
						name: "",
						supportedTargets: [],
						root: "",
						limits: { maxTasks: 1, maxDurationSeconds: 1 },
						schemas: {},
						stages: {},
						edges: [],
						groups: [],
					}
				}
				diagnostics={viewDiagnostics}
				dispatch={dispatch}
				onNavigateToDefinition={navigateToDefinition}
			/>
		</div>
	);
};
