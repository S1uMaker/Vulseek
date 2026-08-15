import * as React from "react";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";
import type {
	PipelineDiagnostic,
	PipelineDocumentV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	createEdgeDraft,
	createGroupDraft,
	createStageDraft,
	deleteBlockers,
	diagnosticsForEntity,
	duplicateDiagnostics,
	entityCounts,
	filterVisibleSchemaDiagnostics,
	relatedSchemaIds,
	schemaReferrers,
} from "@/lib/pipeline-editor/definition-helpers";
import type {
	PipelineEditorAction,
	PipelineEditorState,
} from "@/lib/pipeline-editor/pipeline-editor-state";
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
import { cn } from "@/lib/utils";
import { EdgeEditor } from "./edge-editor";
import { EntityList } from "./entity-list";
import { GroupEditor } from "./group-editor";
import { LayoutEditor } from "./layout-editor";
import { OverviewEditor } from "./overview-editor";
import { SchemaEditor } from "./schema-editor";
import { StageEditor } from "./stage-editor";
import { EmptyState, SelectField } from "./workbench-fields";

/**
 * Definition view: the three-column workspace (left rail → entity list →
 * entity editor). On narrow screens the columns become drill-down screens
 * with a visible back path. All mutations flow through typed YAML patches.
 */

export type DefinitionSection =
	| "overview"
	| "stages"
	| "edges"
	| "schemas"
	| "groups"
	| "layout";

export type DrillLevel = "rail" | "list" | "editor";

export type DefinitionViewProps = {
	document: PipelineDocumentV3;
	state: PipelineEditorState;
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
	draftState: { dirty: boolean; draftRevision: number; publishedVersion: string | null };
	narrow: boolean;
	drill: DrillLevel;
	setDrill: (level: DrillLevel) => void;
	onSelect: (entity: NonNullable<PipelineEditorState["selectedEntity"]>) => void;
	onNavigateToVisual: () => void;
};

const sectionLabel: Record<DefinitionSection, string> = {
	overview: "Overview",
	stages: "Stages",
	edges: "Edges",
	schemas: "Schemas",
	groups: "Groups",
	layout: "Layout",
};

const hasList = (section: DefinitionSection): boolean =>
	section === "stages" || section === "edges" || section === "schemas" || section === "groups";

export const DefinitionView = ({
	document,
	state,
	dispatch,
	readOnly,
	draftState,
	narrow,
	drill,
	setDrill,
	onSelect,
	onNavigateToVisual,
}: DefinitionViewProps) => {
	const [section, setSection] = React.useState<DefinitionSection>("overview");
	const [createDialog, setCreateDialog] = React.useState<
		"stage" | "edge" | "schema" | "group" | null
	>(null);

	// Selection sync: a selection arriving from another view (Visual,
	// diagnostics, quick switcher) switches the section to the entity kind.
	const SECTION_BY_ENTITY: Record<
		NonNullable<PipelineEditorState["selectedEntity"]>["type"],
		DefinitionSection
	> = {
		stage: "stages",
		edge: "edges",
		schema: "schemas",
		group: "groups",
	};
	const counts = entityCounts(document);
	const visibleSchemaIds = relatedSchemaIds(document);
	const visibleDiagnostics = filterVisibleSchemaDiagnostics(document, state.diagnostics);
	const selected = state.selectedEntity;
	const selectedMatchesSection =
		selected &&
		((section === "stages" && selected.type === "stage") ||
			(section === "edges" && selected.type === "edge") ||
			(section === "schemas" && selected.type === "schema") ||
			(section === "groups" && selected.type === "group"));
	const selectedId = selectedMatchesSection ? selected.id : null;

	// Selection sync: a selection arriving from another view (Visual,
	// diagnostics, quick switcher) switches the section to the entity kind.
	React.useEffect(() => {
		if (!selected) return;
		const target = SECTION_BY_ENTITY[selected.type];
		if (target && target !== section) {
			setSection(target);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected?.type, selected?.id]);

	const diagnosticsForSection = (kind: "stage" | "edge" | "schema" | "group") =>
		visibleDiagnostics.filter((diagnostic) => diagnostic.entity?.type === kind);

	const changeSection = (next: DefinitionSection) => {
		setSection(next);
		if (narrow) setDrill(hasList(next) ? "list" : "editor");
	};

	const handleSelect = (entity: NonNullable<PipelineEditorState["selectedEntity"]>) => {
		onSelect(entity);
		if (narrow) setDrill("editor");
	};

	const rail = (
		<nav className="flex h-full min-h-0 w-44 shrink-0 flex-col border-r" aria-label="Definition sections">
			{(
				[
					["overview", "Overview", null],
					["stages", `Stages ${counts.stages}`, "stage"],
					["edges", `Edges ${counts.edges}`, "edge"],
					["schemas", `Schemas ${counts.schemas}`, "schema"],
					["groups", `Groups ${counts.groups}`, "group"],
					["layout", "Layout", null],
				] as const
			).map(([id, label, kind]) => {
				const count = kind ? diagnosticsForSection(kind).length : 0;
				return (
					<button
						key={id}
						type="button"
						onClick={() => changeSection(id)}
						className={cn(
							"flex items-center justify-between px-3 py-2 text-left text-xs transition-colors",
							section === id
								? "border-r-2 border-primary bg-primary/5 font-medium text-foreground"
								: "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
						)}
					>
						<span>{label}</span>
						{count > 0 ? (
							<span
								className={cn(
									"rounded-full px-1.5 text-[10px]",
									kind === "stage"
										? "bg-red-500/15 text-red-600"
										: "bg-amber-500/15 text-amber-600",
								)}
							>
								{count}
							</span>
						) : null}
					</button>
				);
			})}
			{!readOnly ? (
				<div className="mt-auto grid gap-1 border-t p-2">
					{(["stage", "edge", "schema", "group"] as const).map((kind) => (
						<Button
							key={kind}
							variant="outline"
							size="sm"
							className="w-full justify-start"
							onClick={() => setCreateDialog(kind)}
						>
							<Plus className="size-3.5" />
							New {kind}
						</Button>
					))}
				</div>
			) : null}
		</nav>
	);

	const entityList = (
		<div className="flex h-full min-h-0 w-56 shrink-0 flex-col border-r">
			{section === "stages" ? (
				<EntityList
					items={Object.entries(document.stages).map(([id, stage]) => ({
						id,
						title: stage.name,
						subtitle: `${id} · concurrency ${stage.concurrency}${stage.group ? ` · ${stage.group}` : ""}`,
						badge: stage.role,
						errorCount: diagnosticsForEntity(state.diagnostics, "stage", id).filter(
							(d) => d.severity === "error",
						).length,
						warningCount: diagnosticsForEntity(state.diagnostics, "stage", id).filter(
							(d) => d.severity === "warning",
						).length,
					}))}
					selectedId={selectedId}
					onSelect={(id) => handleSelect({ type: "stage", id })}
					placeholder="Search stages…"
					emptyText="No stages match."
				/>
			) : null}
			{section === "edges" ? (
				<EntityList
					items={document.edges.map((edge) => ({
						id: edge.id,
						title: `${edge.from} → ${edge.to}`,
						subtitle: edge.name,
						badge: edge.route?.key ?? edge.mode,
						errorCount: diagnosticsForEntity(state.diagnostics, "edge", edge.id).filter(
							(d) => d.severity === "error",
						).length,
						warningCount: diagnosticsForEntity(state.diagnostics, "edge", edge.id).filter(
							(d) => d.severity === "warning",
						).length,
					}))}
					selectedId={selectedId}
					onSelect={(id) => handleSelect({ type: "edge", id })}
					placeholder="Search edges…"
					emptyText="No edges match."
				/>
			) : null}
			{section === "schemas" ? (
				<EntityList
					items={visibleSchemaIds.map((id) => ({
						id,
						title: id,
						subtitle: `${schemaReferrers(document, id).length} usage(s)`,
						errorCount: diagnosticsForEntity(state.diagnostics, "schema", id).filter(
							(d) => d.severity === "error",
						).length,
						warningCount: diagnosticsForEntity(state.diagnostics, "schema", id).filter(
							(d) => d.severity === "warning",
						).length,
					}))}
					selectedId={selectedId}
					onSelect={(id) => handleSelect({ type: "schema", id })}
					placeholder="Search schemas…"
					emptyText="No schemas match."
				/>
			) : null}
			{section === "groups" ? (
				<EntityList
					items={document.groups.map((group) => ({
						id: group.id,
						title: group.name,
						subtitle: `leader ${group.leader} · ${group.members.length} members`,
						errorCount: diagnosticsForEntity(state.diagnostics, "group", group.id).filter(
							(d) => d.severity === "error",
						).length,
						warningCount: diagnosticsForEntity(state.diagnostics, "group", group.id).filter(
							(d) => d.severity === "warning",
						).length,
					}))}
					selectedId={selectedId}
					onSelect={(id) => handleSelect({ type: "group", id })}
					placeholder="Search groups…"
					emptyText="No groups match."
				/>
			) : null}
		</div>
	);

	const editor = (
		<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
			{section === "overview" ? (
				<OverviewEditor
					document={document}
					dispatch={dispatch}
					readOnly={readOnly}
					draftState={draftState}
				/>
			) : null}
			{section === "layout" ? (
				<LayoutEditor document={document} dispatch={dispatch} readOnly={readOnly} />
			) : null}
			{section === "stages" ? (
				selected && selected.type === "stage" && document.stages[selected.id] ? (
					<>
						<DeleteEntityBar
							kind="stage"
							id={selected.id}
							document={document}
							diagnostics={state.diagnostics}
							dispatch={dispatch}
							readOnly={readOnly}
							onDeleted={onNavigateToVisual}
						/>
						<StageEditor
							stageId={selected.id}
							stage={document.stages[selected.id]!}
							document={document}
							diagnostics={diagnosticsForEntity(state.diagnostics, "stage", selected.id)}
							dispatch={dispatch}
							readOnly={readOnly}
							onSelect={handleSelect}
						/>
					</>
				) : (
					<EmptyState title="Select a stage" hint="Pick a stage from the list, or create one to start editing." />
				)
			) : null}
			{section === "edges" ? (
				selected && selected.type === "edge" ? (
					<>
						<DeleteEntityBar
							kind="edge"
							id={selected.id}
							document={document}
							diagnostics={state.diagnostics}
							dispatch={dispatch}
							readOnly={readOnly}
						/>
						<EdgeEditor
							edgeId={selected.id}
							edge={document.edges.find((edge) => edge.id === selected.id)!}
							document={document}
							diagnostics={diagnosticsForEntity(state.diagnostics, "edge", selected.id)}
							dispatch={dispatch}
							readOnly={readOnly}
							onSelect={handleSelect}
						/>
					</>
				) : (
					<EmptyState title="Select an edge" hint="Pick an edge from the list to edit its route and contracts." />
				)
			) : null}
			{section === "schemas" ? (
				selected && selected.type === "schema" && document.schemas[selected.id] ? (
					<SchemaEditor
						schemaId={selected.id}
						schema={document.schemas[selected.id]!}
						document={document}
						diagnostics={diagnosticsForEntity(state.diagnostics, "schema", selected.id)}
						dispatch={dispatch}
						readOnly={readOnly}
						onSelect={handleSelect}
					/>
				) : (
					<EmptyState title="Select a schema" hint="Schemas define stage and edge contracts; pick one to edit." />
				)
			) : null}
			{section === "groups" ? (
				selected && selected.type === "group" ? (
					<GroupEditor
						groupId={selected.id}
						group={document.groups.find((group) => group.id === selected.id)!}
						document={document}
						diagnostics={diagnosticsForEntity(state.diagnostics, "group", selected.id)}
						dispatch={dispatch}
						readOnly={readOnly}
					/>
				) : (
					<EmptyState title="Select a group" hint="Groups organize stages into swimlanes on the canvas." />
				)
			) : null}
		</div>
	);

	if (narrow) {
		const backLabel =
			drill === "editor" && hasList(section) ? sectionLabel[section] : "Sections";
		return (
			<>
				<div className="flex h-full min-h-0 flex-1 flex-col">
					{drill !== "rail" ? (
						<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
							<button
								type="button"
								onClick={() =>
									setDrill(drill === "editor" ? (hasList(section) ? "list" : "rail") : "rail")
								}
								className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
							>
								<ChevronLeft className="size-3.5" />
								{backLabel}
							</button>
							<span className="ml-1 truncate text-xs font-medium">
								{sectionLabel[section]}
								{selectedId ? ` · ${selectedId}` : ""}
							</span>
						</div>
					) : null}
					<div className="flex min-h-0 flex-1">
						{drill === "rail" ? rail : null}
						{drill === "list" ? entityList : null}
						{drill === "editor" ? editor : null}
					</div>
				</div>
				<CreateEntityDialog
					kind={createDialog}
					onClose={() => setCreateDialog(null)}
					document={document}
					dispatch={dispatch}
					readOnly={readOnly}
					onCreated={(entity) => {
						handleSelect(entity);
						setCreateDialog(null);
					}}
				/>
			</>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-1">
			{rail}
			{hasList(section) ? entityList : null}
			{editor}
			<CreateEntityDialog
				kind={createDialog}
				onClose={() => setCreateDialog(null)}
				document={document}
				dispatch={dispatch}
				readOnly={readOnly}
				onCreated={(entity) => {
					handleSelect(entity);
					setCreateDialog(null);
				}}
			/>
		</div>
	);
};

// ---------------------------------------------------------------------------
// Delete bar: safe deletion with explicit reference resolution
// ---------------------------------------------------------------------------

const DeleteEntityBar = ({
	kind,
	id,
	document,
	diagnostics,
	dispatch,
	readOnly,
	onDeleted,
}: {
	kind: "stage" | "edge" | "schema" | "group";
	id: string;
	document: PipelineDocumentV3;
	diagnostics: PipelineDiagnostic[];
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
	onDeleted?: () => void;
}) => {
	const blockers = deleteBlockers(document, kind, id);
	const entityDiagnostics = diagnostics.filter(
		(d) => d.entity?.type === kind && d.entity.id === id,
	);
	const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
	if (readOnly) return null;
	const doDelete = () => {
		const ops =
			kind === "stage"
				? [{ op: "deleteStage" as const, stageId: id }]
				: kind === "edge"
					? [{ op: "deleteEdge" as const, edgeId: id }]
					: kind === "schema"
						? [{ op: "deleteSchema" as const, schemaId: id }]
						: [{ op: "deleteGroup" as const, groupId: id }];
		dispatch({ type: "patch", ops });
		setDeleteDialogOpen(false);
		onDeleted?.();
	};
	return (
		<>
			<div className="flex shrink-0 items-center justify-end border-b px-4 py-1.5">
				<button
					type="button"
					onClick={() => setDeleteDialogOpen(true)}
					className="inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-600 hover:bg-red-500/10"
				>
					<Trash2 className="size-3" />
					Delete {kind}
				</button>
			</div>
			<Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Delete {kind} &quot;{id}&quot;?</DialogTitle>
						<DialogDescription>
							This removes the entity from the draft. Save the draft to persist the change.
						</DialogDescription>
					</DialogHeader>
					{blockers.length > 0 ? (
						<div className="space-y-2 rounded-md border border-red-500/30 bg-red-500/5 p-3">
							<p className="text-sm font-medium text-red-600">Resolve these references before deleting:</p>
							<ul className="list-disc space-y-1 pl-5 text-xs text-red-600">
								{blockers.map((blocker, index) => (
									<li key={index}>{blocker.message}</li>
								))}
							</ul>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">No references block this deletion.</p>
					)}
					{entityDiagnostics.length > 0 ? (
						<p className="text-xs text-muted-foreground">{entityDiagnostics.length} diagnostic(s) are associated with this entity.</p>
					) : null}
					<DialogFooter>
						<Button variant="outline" size="sm" onClick={() => setDeleteDialogOpen(false)}>
							Cancel
						</Button>
						<Button variant="destructive" size="sm" disabled={blockers.length > 0} onClick={doDelete}>
							Delete {kind}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};

// ---------------------------------------------------------------------------
// Create dialogs with inline validation
// ---------------------------------------------------------------------------

const CreateEntityDialog = ({
	kind,
	onClose,
	document,
	dispatch,
	readOnly,
	onCreated,
}: {
	kind: "stage" | "edge" | "schema" | "group" | null;
	onClose: () => void;
	document: PipelineDocumentV3;
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
	onCreated: (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => void;
}) => {
	const [id, setName] = React.useState("");
	const [name, setDisplayName] = React.useState("");
	const [role, setRole] = React.useState("scan");
	const [from, setFrom] = React.useState(document.root);
	const [to, setTo] = React.useState(document.root);
	const [group, setGroup] = React.useState("default");
	const [leader, setLeader] = React.useState(document.root);

	React.useEffect(() => {
		setName("");
		setDisplayName("");
		setRole("scan");
		setFrom(document.root);
		setTo(document.root);
		setGroup("default");
		setLeader(document.root);
	}, [kind, document.root]);

	if (!kind) return null;

	const validation = duplicateDiagnostics(document, kind, id.trim());
	const title =
		kind === "stage" ? "New stage" : kind === "edge" ? "New edge" : kind === "schema" ? "New schema" : "New group";
	const canCreate = id.trim().length > 0 && validation.length === 0;

	const submit = () => {
		if (!canCreate) return;
		if (kind === "stage") {
			const stage = {
				...createStageDraft(id.trim(), group),
				name: name.trim() || id.trim(),
				role: role as PipelineStageV3["role"],
			};
			dispatch({ type: "patch", ops: [{ op: "addStage", stageId: id.trim(), stage }] });
			onCreated({ type: "stage", id: id.trim() });
		} else if (kind === "edge") {
			const edge = createEdgeDraft(id.trim(), from, to, new Set(document.edges.map((e) => e.id)));
			dispatch({ type: "patch", ops: [{ op: "addEdge", edge }] });
			onCreated({ type: "edge", id: edge.id });
		} else if (kind === "schema") {
			dispatch({ type: "patch", ops: [{ op: "setSchema", schemaId: id.trim(), schema: { type: "object" } }] });
			onCreated({ type: "schema", id: id.trim() });
		} else {
			const groupDraft = createGroupDraft(id.trim(), leader, new Set(document.groups.map((g) => g.id)));
			dispatch({ type: "patch", ops: [{ op: "addGroup", group: groupDraft }] });
			onCreated({ type: "group", id: groupDraft.id });
		}
	};

	const stageOptions = Object.keys(document.stages).map((stageId) => ({
		value: stageId,
		label: stageId,
	}));

	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						{"IDs are immutable after creation and must match ^[a-z][a-z0-9_-]{0,63}$."}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1">
						<Label className="text-xs">ID</Label>
						<Input
							value={id}
							autoFocus
							onChange={(event) => setName(event.target.value)}
							className="h-9"
							placeholder={
								kind === "edge" ? "edge-id" : kind === "group" ? "group-id" : "stage-id"
							}
						/>
						{validation.length > 0 ? (
							<p className="text-xs text-red-600" role="alert">
								{validation.map((d) => d.message).join(" ")}
							</p>
						) : null}
					</div>
					{kind === "stage" ? (
						<>
							<div className="space-y-1">
								<Label className="text-xs">Display name</Label>
								<Input value={name} onChange={(event) => setDisplayName(event.target.value)} className="h-9" />
							</div>
							<SelectField label="Role" value={role} options={[
								{ value: "scan", label: "Scan" },
								{ value: "analysis", label: "Analysis" },
								{ value: "verification", label: "Verification" },
							]} onChange={setRole} />
							<div className="space-y-1">
								<Label className="text-xs">Group</Label>
								<Input value={group} onChange={(event) => setGroup(event.target.value)} className="h-9" />
							</div>
						</>
					) : null}
					{kind === "edge" ? (
						<div className="grid grid-cols-2 gap-2">
							<SelectField label="From" value={from} options={stageOptions} onChange={setFrom} />
							<SelectField label="To" value={to} options={stageOptions} onChange={setTo} />
						</div>
					) : null}
					{kind === "group" ? (
						<SelectField label="Leader" value={leader} options={stageOptions} onChange={setLeader} />
					) : null}
				</div>
				<DialogFooter>
					<Button variant="outline" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button size="sm" disabled={!canCreate || readOnly} onClick={submit}>
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
