import { Trash2 } from "lucide-react";
import * as React from "react";
import type {
	PipelineDocumentV3,
	PipelineEdgeV3,
	PipelineGroupV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { JsonEditor } from "./json-editor";
import { McpMultiSelect } from "./mcp-multi-select";
import { SkillMultiSelect } from "./skill-multi-select";
import { SchemaReferenceField } from "./workbench/workbench-fields";

/**
 * Full V3 inspector: stage (runtime, artifacts, effects, schemas, prompt
 * values, task naming), edge (map/fanOut, route, fork, input, artifacts,
 * output schema), groups and pipeline-level settings. JSON-heavy fields use
 * the embedded JSON editor instead of raw YAML.
 */

export type PipelineInspectorProps = {
	document: PipelineDocumentV3;
	selection: { type: "stage" | "edge" | "schema" | "group"; id: string } | null;
	onChange: (document: PipelineDocumentV3) => void;
	onSelect: (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => void;
	/** Keep the full schema registry in Definition/Raw YAML, not the canvas inspector. */
	showPipelineSchemas?: boolean;
};

const roleOptions: Array<PipelineStageV3["role"]> = ["scan", "analysis", "verification"];
const prepareOptions: Array<PipelineStageV3["runtime"]["prepareRepository"]> = [
	"none",
	"target",
	"diff",
];
const PLUGIN_OPTIONS = ["research-track", "research-deadline"] as const;
const EFFECT_OPTIONS = [
	"sync-candidates",
	"project-candidate-result",
	"research-registry",
	"tob-goal-registry",
] as const;

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
	<div className="space-y-2">
		<h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{title}
		</h4>
		{children}
	</div>
);

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
	<div className="space-y-1">
		<Label className="text-xs">{label}</Label>
		{children}
	</div>
);

const SelectField = ({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly string[];
	onChange: (value: string) => void;
}) => (
	<Field label={label}>
		<select
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className="h-9 w-full rounded-md border bg-background px-2 text-sm"
		>
			{options.map((option) => (
				<option key={option} value={option}>
					{option}
				</option>
			))}
		</select>
	</Field>
);

const ToggleField = ({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) => (
	<div className="flex items-center justify-between">
		<Label className="text-xs">{label}</Label>
		<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
	</div>
);

// ---------------------------------------------------------------------------
// Stage inspector
// ---------------------------------------------------------------------------

const StageInspector = ({
	stage,
	stageId,
	document,
	onChange,
	onSelect,
}: {
	stage: PipelineStageV3;
	stageId: string;
	document: PipelineDocumentV3;
	onChange: (document: PipelineDocumentV3) => void;
	onSelect: (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => void;
}) => {
	const update = (patch: Partial<PipelineStageV3>) =>
		onChange({
			...document,
			stages: { ...document.stages, [stageId]: { ...stage, ...patch } },
		});
	const updateRuntime = (patch: Partial<PipelineStageV3["runtime"]>) =>
		update({ runtime: { ...stage.runtime, ...patch } });

	return (
		<div className="space-y-5">
			<Section title="Stage">
				<Field label="ID (immutable)">
					<Input value={stageId} readOnly className="bg-muted/40" />
				</Field>
				<Field label="Name">
					<Input value={stage.name} onChange={(event) => update({ name: event.target.value })} />
				</Field>
				<Field label="Description">
					<Textarea
						rows={2}
						value={stage.description ?? ""}
						onChange={(event) => update({ description: event.target.value || undefined })}
					/>
				</Field>
				<SelectField
					label="Role"
					value={stage.role}
					options={roleOptions}
					onChange={(value) => update({ role: value as PipelineStageV3["role"] })}
				/>
				<Field label="Group">
					<Input value={stage.group} onChange={(event) => update({ group: event.target.value })} />
				</Field>
				<Field label="Concurrency">
					<Input
						type="number"
						min={1}
						value={stage.concurrency}
						onChange={(event) =>
							update({ concurrency: Math.max(1, Number(event.target.value) || 1) })
						}
					/>
				</Field>
				<Field label="Max concurrency (optional)">
					<Input
						type="number"
						min={1}
						value={stage.maxConcurrency ?? ""}
						placeholder="inherit"
						onChange={(event) =>
							update({
								maxConcurrency: event.target.value
									? Math.max(1, Number(event.target.value) || 1)
									: undefined,
							})
						}
					/>
				</Field>
				<ToggleField
					label="Disableable"
					checked={stage.disableable}
					onChange={(checked) => update({ disableable: checked })}
				/>
			</Section>

			<Section title="Runtime">
				<Field label="Agent profile ID">
					<Input
						value={stage.runtime.agentProfileId ?? ""}
						placeholder="inherit"
						onChange={(event) =>
							updateRuntime({
								agentProfileId: event.target.value || null,
							})
						}
					/>
				</Field>
				<Field label="Skills">
					<SkillMultiSelect
						value={stage.runtime.skills}
						onChange={(skills) =>
							updateRuntime({
								skills: skills.length > 0 ? skills : undefined,
							})
						}
					/>
				</Field>
				<Field label="MCP">
					<McpMultiSelect
						value={stage.runtime.mcp}
						onChange={(mcp) =>
							updateRuntime({
								mcp: mcp.length > 0 ? mcp : undefined,
							})
						}
					/>
				</Field>
				<SelectField
					label="Prepare repository"
					value={stage.runtime.prepareRepository}
					options={prepareOptions}
					onChange={(value) =>
						updateRuntime({
							prepareRepository: value as PipelineStageV3["runtime"]["prepareRepository"],
						})
					}
				/>
				<Field label="cwd">
					<Input
						value={stage.runtime.cwd ?? ""}
						placeholder="/workspace/repo"
						onChange={(event) => updateRuntime({ cwd: event.target.value || undefined })}
					/>
				</Field>
				<ToggleField
					label="Persistent container"
					checked={stage.runtime.persistent ?? true}
					onChange={(checked) => {
						updateRuntime({ persistent: checked });
						if (!checked) update({ goalPreserving: false });
					}}
				/>
				<ToggleField
					label="Reuse container"
					checked={stage.runtime.reuseContainer ?? true}
					onChange={(checked) => updateRuntime({ reuseContainer: checked })}
				/>
				<ToggleField
					label="Nullable output"
					checked={stage.runtime.nullableOutput ?? false}
					onChange={(checked) => updateRuntime({ nullableOutput: checked })}
				/>
				<ToggleField
					label="Include security policy"
					checked={stage.runtime.includePolicy ?? false}
					onChange={(checked) => updateRuntime({ includePolicy: checked })}
				/>
				<Field label="Plugins">
					<div className="flex flex-wrap gap-1.5">
						{PLUGIN_OPTIONS.map((plugin) => (
							<button
								key={plugin}
								type="button"
								onClick={() => {
									const current = stage.runtime.plugins ?? [];
									updateRuntime({
										plugins: current.includes(plugin)
											? current.filter((item) => item !== plugin)
											: [...current, plugin],
									});
								}}
								className={cn(
									"rounded-full border px-2 py-0.5 text-[11px]",
									stage.runtime.plugins?.includes(plugin)
										? "border-primary bg-primary/10 text-primary"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{plugin}
							</button>
						))}
					</div>
				</Field>
				<Field label="Prompt">
					<Textarea
						rows={10}
						value={stage.runtime.prompt}
						onChange={(event) => updateRuntime({ prompt: event.target.value })}
						className="font-mono text-xs"
					/>
				</Field>
			</Section>

			<Section title="Artifacts & effects">
				<Field label="Input artifacts">
					<JsonEditor
						value={stage.inputArtifacts ?? []}
						onChange={(value) => update({ inputArtifacts: value as never })}
						label="ArtifactMapping[]"
						rows={4}
					/>
				</Field>
				<Field label="Output artifacts">
					<JsonEditor
						value={stage.outputArtifacts ?? []}
						onChange={(value) => update({ outputArtifacts: value as never })}
						label="ArtifactMapping[]"
						rows={4}
					/>
				</Field>
				<Field label="Effects">
					<div className="flex flex-wrap gap-1.5">
						{EFFECT_OPTIONS.map((effect) => (
							<button
								key={effect}
								type="button"
								onClick={() => {
									const current = stage.effects ?? [];
									update({
										effects: current.some((item) => item.type === effect)
											? current.filter((item) => item.type !== effect)
											: [...current, { type: effect } as never],
									});
								}}
								className={cn(
									"rounded-full border px-2 py-0.5 text-[11px]",
									stage.effects?.some((item) => item.type === effect)
										? "border-primary bg-primary/10 text-primary"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{effect}
							</button>
						))}
					</div>
				</Field>
			</Section>

			<Section title="Schemas & values">
				<SchemaReferenceField
					label="Input schema"
					value={stage.inputSchema}
					schemaIds={Object.keys(document.schemas)}
					onNavigateToSchema={(schemaId) => onSelect({ type: "schema", id: schemaId })}
					onChange={(inputSchema) => update({ inputSchema: inputSchema as never })}
				/>
				<SchemaReferenceField
					label="Output schema"
					value={stage.outputSchema}
					schemaIds={Object.keys(document.schemas)}
					onNavigateToSchema={(schemaId) => onSelect({ type: "schema", id: schemaId })}
					onChange={(outputSchema) => update({ outputSchema: outputSchema as never })}
				/>
				<Field label="Prompt values">
					<JsonEditor
						value={stage.promptValues ?? {}}
						onChange={(value) => update({ promptValues: value as never })}
						rows={5}
					/>
				</Field>
			</Section>

			<Section title="Task & container">
				<Field label="Task name template">
					<Input
						value={stage.taskName ?? ""}
						placeholder="$file($input.targetPath).name"
						onChange={(event) => update({ taskName: event.target.value || undefined })}
					/>
				</Field>
				<Field label="Container name parts">
					<Input
						value={stage.containerNameParts?.join(", ") ?? ""}
						placeholder="comma separated parts"
						onChange={(event) =>
							update({
								containerNameParts: event.target.value
									.split(",")
									.map((part) => part.trim())
									.filter(Boolean),
							})
						}
					/>
				</Field>
				<ToggleField
					label="Goal prompt"
					checked={stage.goal ?? false}
					onChange={(checked) => update({ goal: checked })}
				/>
				<ToggleField
					label="Goal preserving"
					checked={stage.goalPreserving ?? false}
					onChange={(checked) => {
						if (stage.runtime.persistent !== true) return;
						update({ goalPreserving: checked });
					}}
				/>
				<ToggleField
					label="Allow agent exit"
					checked={stage.allowAgentExit ?? false}
					onChange={(checked) => update({ allowAgentExit: checked })}
				/>
				<ToggleField
					label="Publish job output"
					checked={stage.jobOutput ?? false}
					onChange={(checked) => update({ jobOutput: checked })}
				/>
				<Field label="Report path">
					<Input
						value={stage.report?.path ?? ""}
						placeholder="/task/01_report.md"
						onChange={(event) =>
							update({
								report: event.target.value
									? { path: event.target.value, required: stage.report?.required ?? true }
									: undefined,
							})
						}
					/>
				</Field>
			</Section>
		</div>
	);
};

// ---------------------------------------------------------------------------
// Edge inspector
// ---------------------------------------------------------------------------

/**
 * Sibling routes for a selected edge: every persisted V3 edge that shares
 * the same `(from, to)` pair. Lets the user switch between parallel routes
 * that the canvas renders as one grouped path.
 */
const SiblingRouteSwitcher = ({
	edge,
	document,
	onSelect,
}: {
	edge: PipelineEdgeV3;
	document: PipelineDocumentV3;
	onSelect: (edgeId: string) => void;
}) => {
	const siblings = document.edges.filter(
		(item) => item.from === edge.from && item.to === edge.to,
	);
	if (siblings.length <= 1) return null;
	return (
		<Section title="Routes (same source/target)">
			<div className="flex flex-wrap gap-1.5">
				{siblings.map((sibling) => (
					<button
						key={sibling.id}
						type="button"
						onClick={() => onSelect(sibling.id)}
						className={cn(
							"rounded-full border px-2 py-0.5 text-[11px]",
							sibling.id === edge.id
								? "border-primary bg-primary/10 text-primary"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{sibling.route?.key ?? sibling.name} — {sibling.id}
					</button>
				))}
			</div>
		</Section>
	);
};

const EdgeInspector = ({
	edge,
	document,
	onChange,
	onSelectEdge,
	onSelect,
}: {
	edge: PipelineEdgeV3;
	document: PipelineDocumentV3;
	onChange: (document: PipelineDocumentV3) => void;
	onSelectEdge: (edgeId: string) => void;
	onSelect: (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => void;
}) => {
	const update = (patch: Partial<PipelineEdgeV3>) =>
		onChange({
			...document,
			edges: document.edges.map((item) =>
				item.id === edge.id ? { ...item, ...patch } : item,
			),
		});
	const updateRouteMetadata = (
		patch: Partial<NonNullable<PipelineEdgeV3["route"]>>,
	) => {
		const routeKey = edge.route?.key;
		if (!routeKey) return;
		onChange({
			...document,
			edges: document.edges.map((item) =>
				item.from === edge.from && item.route?.key === routeKey
					? { ...item, route: { ...item.route, ...patch, key: routeKey } }
					: item,
		),
		});
	};

	return (
		<div className="space-y-5">
			<SiblingRouteSwitcher
				edge={edge}
				document={document}
				onSelect={(edgeId) => onSelectEdge(edgeId)}
			/>
			<Section title="Edge">
				<Field label="ID (immutable)">
					<Input value={edge.id} readOnly className="bg-muted/40" />
				</Field>
				<Field label="Name">
					<Input value={edge.name} onChange={(event) => update({ name: event.target.value })} />
				</Field>
				<Field label="From">
					<Input value={edge.from} readOnly className="bg-muted/40" />
				</Field>
				<Field label="To">
					<Input value={edge.to} readOnly className="bg-muted/40" />
				</Field>
				<SelectField
					label="Mode"
					value={edge.mode}
					options={["map", "fanOut"]}
					onChange={(value) => update({ mode: value as "map" | "fanOut" })}
				/>
				{edge.mode === "fanOut" && (
					<Field label="foreach">
						<Input
							value={edge.foreach ?? ""}
							placeholder="$.items[*]"
							onChange={(event) => update({ foreach: event.target.value || undefined })}
						/>
					</Field>
				)}
				<ToggleField
					label="Fork"
					checked={edge.fork}
					onChange={(checked) => update({ fork: checked })}
				/>
			</Section>

			<Section title="Route">
				<ToggleField
					label="Routed edge"
					checked={Boolean(edge.route)}
					onChange={(checked) =>
						update({
						route: checked
								? {
										key: edge.route?.key ?? "default",
										default: edge.route?.default,
										description: edge.route?.description,
									}
								: undefined,
						})
					}
				/>
				{(() => {
					const route = edge.route;
					if (!route) return null;
					return (
					<>
						<Field label="Route key">
							<Input
								value={route.key}
								onChange={(event) =>
									update({ route: { ...route, key: event.target.value } })
								}
							/>
						</Field>
						<Field label="Route description (optional)">
							<Textarea
								value={route.description ?? ""}
								placeholder="Explain when this route should be selected"
								onChange={(event) =>
									updateRouteMetadata({
										description: event.target.value.trim() || undefined,
									})
								}
								rows={3}
							/>
						</Field>
						<ToggleField
							label="Default route"
							checked={route.default ?? false}
							onChange={(checked) =>
								updateRouteMetadata({ default: checked })
							}
						/>
					</>
					);
				})()}
			</Section>

			<Section title="Input & artifacts">
				<Field label="Input mapping">
					<JsonEditor
						value={edge.input ?? {}}
						onChange={(value) => update({ input: value as never })}
						rows={5}
					/>
				</Field>
				<Field label="Artifacts">
					<JsonEditor
						value={edge.artifacts ?? []}
						onChange={(value) => update({ artifacts: value as never })}
						rows={4}
					/>
				</Field>
			</Section>

			<Section title="Output schema">
				<SchemaReferenceField
					label="Output schema"
					value={edge.outputSchema}
					schemaIds={Object.keys(document.schemas)}
					onNavigateToSchema={(schemaId) => onSelect({ type: "schema", id: schemaId })}
					onChange={(outputSchema) => update({ outputSchema: outputSchema as never })}
				/>
			</Section>
		</div>
	);
};

// ---------------------------------------------------------------------------
// Group inspector
// ---------------------------------------------------------------------------

const GroupInspector = ({
	group,
	document,
	onChange,
}: {
	group: PipelineGroupV3;
	document: PipelineDocumentV3;
	onChange: (document: PipelineDocumentV3) => void;
}) => {
	const stageIds = Object.keys(document.stages);
	const update = (patch: Partial<PipelineGroupV3>) =>
		onChange({
			...document,
			groups: (document.groups ?? []).map((item) =>
				item.id === group.id ? { ...item, ...patch } : item,
			),
		});

	const toggleMember = (stageId: string) => {
		const members = group.members ?? [];
		update({
			members: members.includes(stageId)
				? members.filter((member) => member !== stageId)
				: [...members, stageId],
		});
	};

	return (
		<div className="space-y-5">
			<Section title="Group">
				<Field label="ID (immutable)">
					<Input value={group.id} readOnly className="bg-muted/40" />
				</Field>
				<Field label="Name">
					<Input
						value={group.name}
						onChange={(event) => update({ name: event.target.value })}
					/>
				</Field>
				<SelectField
					label="Leader"
					value={group.leader}
					options={stageIds}
					onChange={(value) => update({ leader: value })}
				/>
			</Section>
			<Section title="Members">
				<div className="flex flex-wrap gap-1.5">
					{stageIds.map((stageId) => (
						<button
							key={stageId}
							type="button"
							onClick={() => toggleMember(stageId)}
							className={cn(
								"rounded-full border px-2 py-0.5 text-[11px]",
								group.members?.includes(stageId)
									? "border-primary bg-primary/10 text-primary"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{stageId}
						</button>
					))}
				</div>
			</Section>
		</div>
	);
};

// ---------------------------------------------------------------------------
// Pipeline-level inspector
// ---------------------------------------------------------------------------

const PipelineInspectorBody = ({
	document,
	onChange,
	showPipelineSchemas,
}: {
	document: PipelineDocumentV3;
	onChange: (document: PipelineDocumentV3) => void;
	showPipelineSchemas: boolean;
}) => {
	const stageIds = Object.keys(document.stages);
	const update = (patch: Partial<PipelineDocumentV3>) => onChange({ ...document, ...patch });

	return (
		<div className="space-y-5">
			<Section title="Pipeline">
				<Field label="Name">
					<Input
						value={document.name}
						onChange={(event) => update({ name: event.target.value })}
					/>
				</Field>
				<Field label="Description">
					<Textarea
						rows={2}
						value={document.description ?? ""}
						onChange={(event) => update({ description: event.target.value || undefined })}
					/>
				</Field>
				<SelectField
					label="Root stage"
					value={document.root}
					options={stageIds}
					onChange={(value) => update({ root: value })}
				/>
				<Field label="Supported targets">
					<div className="flex flex-wrap gap-1.5">
						{(["project", "evaluation"] as const).map((target) => (
							<button
								key={target}
								type="button"
								onClick={() =>
									update({
										supportedTargets: document.supportedTargets.includes(target)
											? document.supportedTargets.filter((item) => item !== target)
											: [...document.supportedTargets, target],
									})
								}
								className={cn(
									"rounded-full border px-2 py-0.5 text-[11px]",
									document.supportedTargets.includes(target)
										? "border-primary bg-primary/10 text-primary"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{target}
							</button>
						))}
					</div>
				</Field>
			</Section>

			<Section title="Limits">
				<Field label="Max tasks">
					<Input
						type="number"
						min={1}
						value={document.limits.maxTasks}
						onChange={(event) =>
							update({
								limits: {
									...document.limits,
									maxTasks: Math.max(1, Number(event.target.value) || 1),
								},
							})
						}
					/>
				</Field>
				<Field label="Max duration (seconds)">
					<Input
						type="number"
						min={1}
						value={document.limits.maxDurationSeconds}
						onChange={(event) =>
							update({
								limits: {
									...document.limits,
									maxDurationSeconds: Math.max(1, Number(event.target.value) || 1),
								},
							})
						}
					/>
				</Field>
			</Section>

			{showPipelineSchemas ? (
				<Section title="Schemas">
					<Field label="Pipeline schemas">
						<JsonEditor
							value={document.schemas ?? {}}
							onChange={(value) => update({ schemas: value as never })}
							rows={8}
						/>
					</Field>
				</Section>
			) : null}
		</div>
	);
};

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export const PipelineInspector = ({
	document,
	selection,
	onChange,
	onSelect,
	showPipelineSchemas = true,
}: PipelineInspectorProps) => {
	const deleteEntity = React.useCallback(() => {
		if (!selection) return;
		if (selection.type === "stage") {
			const next: PipelineDocumentV3 = {
				...document,
				stages: Object.fromEntries(
					Object.entries(document.stages).filter(([id]) => id !== selection.id),
				),
				edges: document.edges.filter(
					(edge) => edge.from !== selection.id && edge.to !== selection.id,
				),
				root:
					document.root === selection.id
						? (Object.keys(document.stages).find((id) => id !== selection.id) ??
							document.root)
						: document.root,
			};
			onChange(next);
			return;
		}
		if (selection.type === "edge") {
			onChange({
				...document,
				edges: document.edges.filter((edge) => edge.id !== selection.id),
			});
			return;
		}
		if (selection.type === "group") {
			onChange({
				...document,
				groups: (document.groups ?? []).filter((group) => group.id !== selection.id),
			});
		}
	}, [document, selection, onChange]);

	if (!selection) {
		return (
			<div className="flex h-full flex-col">
				<div className="border-b px-4 py-3">
					<h3 className="text-sm font-semibold">Pipeline</h3>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					<PipelineInspectorBody
						document={document}
						onChange={onChange}
						showPipelineSchemas={showPipelineSchemas}
					/>
				</div>
			</div>
		);
	}

	if (selection.type === "stage") {
		const stage = document.stages[selection.id];
		if (!stage) {
			return <div className="p-4 text-sm text-muted-foreground">Stage no longer exists.</div>;
		}
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b px-4 py-3">
					<h3 className="text-sm font-semibold">{stage.name}</h3>
					<Button
						variant="ghost"
						size="icon"
						className="size-7 text-muted-foreground hover:text-red-600"
						onClick={deleteEntity}
						aria-label="Delete stage"
					>
						<Trash2 className="size-4" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					<StageInspector
						stage={stage}
						stageId={selection.id}
						document={document}
						onChange={onChange}
						onSelect={onSelect}
					/>
				</div>
				<div className="border-t p-3">
					<Button
						variant="outline"
						size="sm"
						className={cn("w-full", document.root === selection.id && "opacity-50")}
						disabled={document.root === selection.id}
						onClick={() => onChange({ ...document, root: selection.id })}
					>
						{document.root === selection.id ? "Root stage" : "Set as root stage"}
					</Button>
				</div>
			</div>
		);
	}

	if (selection.type === "edge") {
		const edge = document.edges.find((item) => item.id === selection.id);
		if (!edge) {
			return <div className="p-4 text-sm text-muted-foreground">Edge no longer exists.</div>;
		}
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b px-4 py-3">
					<h3 className="text-sm font-semibold">{edge.name}</h3>
					<Button
						variant="ghost"
						size="icon"
						className="size-7 text-muted-foreground hover:text-red-600"
						onClick={deleteEntity}
						aria-label="Delete edge"
					>
						<Trash2 className="size-4" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					<EdgeInspector
						edge={edge}
						document={document}
						onChange={onChange}
						onSelectEdge={(edgeId) => onSelect({ type: "edge", id: edgeId })}
						onSelect={onSelect}
					/>
				</div>
			</div>
		);
	}

	if (selection.type === "group") {
		const group = (document.groups ?? []).find((item) => item.id === selection.id);
		if (!group) {
			return <div className="p-4 text-sm text-muted-foreground">Group no longer exists.</div>;
		}
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b px-4 py-3">
					<h3 className="text-sm font-semibold">{group.name}</h3>
					<Button
						variant="ghost"
						size="icon"
						className="size-7 text-muted-foreground hover:text-red-600"
						onClick={deleteEntity}
						aria-label="Delete group"
					>
						<Trash2 className="size-4" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					<GroupInspector group={group} document={document} onChange={onChange} />
				</div>
			</div>
		);
	}

	return (
		<div className="p-4 text-sm text-muted-foreground">Schema editing is available in YAML mode.</div>
	);
};
