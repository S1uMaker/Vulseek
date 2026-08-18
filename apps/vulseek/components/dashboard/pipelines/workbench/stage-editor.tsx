import * as React from "react";
import type {
	PipelineDiagnostic,
	PipelineDocumentV3,
	PipelineEffectV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { ALLOWED_RUNTIME_PLUGINS } from "@vulseek/server/services/scan/pipeline/document-v3";
import { SkillMultiSelect } from "@/components/dashboard/pipelines/skill-multi-select";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import { cn } from "@/lib/utils";
import {
	ArrayField,
	CheckboxField,
	EntityDiagnostics,
	FieldTemplate,
	JsonField,
	NumberField,
	SchemaReferenceField,
	SectionHeading,
	SelectField,
	TextField,
	TextAreaField,
	ToggleField,
} from "./workbench-fields";

/**
 * Stage editor (Definition view). Every mutation dispatches a typed YAML
 * patch keyed for undo/redo coalescing; the full V3 stage contract is
 * covered: General, Runtime, Prompt, I/O, Artifacts, and Effects.
 */

const ROLE_OPTIONS = [
	{ value: "scan", label: "Scan" },
	{ value: "analysis", label: "Analysis" },
	{ value: "verification", label: "Verification" },
] as const;

const PREPARE_OPTIONS = [
	{ value: "none", label: "None" },
	{ value: "target", label: "Target" },
	{ value: "diff", label: "Diff" },
] as const;

const EFFECT_OPERATIONS: Record<string, readonly string[]> = {
	"project-candidate-result": ["analyze", "critique", "verify", "triage"],
	"research-registry": [
		"persist-scope",
		"persist-track-plan",
		"apply-track-review",
		"record-discovery",
		"record-finding-validation",
		"record-finding-review",
		"persist-chain",
		"apply-chain-review",
		"record-exploit-validation",
		"apply-exploit-review",
		"persist-report",
	],
	"tob-goal-registry": ["persist-candidate", "apply-judge", "apply-dedup"],
};

const effectLabel = (effect: PipelineEffectV3): string => {
	if (effect.type === "sync-candidates") return "sync-candidates";
	if (effect.type === "project-candidate-result") {
		return `project-candidate-result (${effect.resultStage})`;
	}
	return `${effect.type} (${effect.operation})`;
};

export type StageEditorProps = {
	stageId: string;
	stage: PipelineStageV3;
	document: PipelineDocumentV3;
	diagnostics: PipelineDiagnostic[];
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
	onSelect: (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => void;
};

export const StageEditor = ({
	stageId,
	stage,
	document,
	diagnostics,
	dispatch,
	readOnly,
	onSelect,
}: StageEditorProps) => {
	const [tab, setTab] = React.useState<
		"general" | "runtime" | "prompt" | "io" | "artifacts" | "effects"
	>("general");

	const patch = (next: PipelineStageV3, key: string) =>
		dispatch({ type: "patch", ops: [{ op: "updateStage", stageId, stage: next }], key });
	const patchRuntime = (next: PipelineStageV3["runtime"], key: string) =>
		patch({ ...stage, runtime: next }, key);

	const schemaIds = Object.keys(document.schemas);
	const groupIds = document.groups.map((group) => group.id);
	const incoming = document.edges.filter((edge) => edge.to === stageId);
	const outgoing = document.edges.filter((edge) => edge.from === stageId);
	const routedOutgoing = outgoing.filter((edge) => edge.route);

	const tabs = [
		{ id: "general" as const, label: "General" },
		{ id: "runtime" as const, label: "Runtime" },
		{ id: "prompt" as const, label: "Prompt" },
		{ id: "io" as const, label: "I/O" },
		{ id: "artifacts" as const, label: "Artifacts" },
		{ id: "effects" as const, label: "Effects" },
	];

	return (
		<div className="flex h-full min-h-0 flex-col">
			<SectionHeading
				title={stage.name}
				subtitle={`${stageId} · ${stage.role} · concurrency ${stage.concurrency}`}
			/>
			<EntityDiagnostics diagnostics={diagnostics} />
			<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2">
				{tabs.map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => setTab(item.id)}
						className={cn(
							"rounded-t-md px-2.5 py-1.5 text-xs font-medium transition-colors",
							tab === item.id
								? "border-b-2 border-primary text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{item.label}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-4 pb-12">
				{tab === "general" ? (
					<div className="space-y-4">
						<TextField
							label="ID (immutable)"
							value={stageId}
							readOnly
							description="Stage IDs become immutable after creation; rename changes the display name only."
						/>
						<TextField
							label="Display name"
							value={stage.name}
							readOnly={readOnly}
							onChange={(name) => patch({ ...stage, name }, `stage:${stageId}:name`)}
						/>
						<SelectField
							label="Role"
							value={stage.role}
							options={ROLE_OPTIONS}
							readOnly={readOnly}
							onChange={(role) =>
								patch(
									{ ...stage, role: role as PipelineStageV3["role"] },
									`stage:${stageId}:role`,
								)
							}
						/>
						<TextAreaField
							label="Description"
							value={stage.description ?? ""}
							rows={3}
							readOnly={readOnly}
							onChange={(description) =>
								patch(
									{ ...stage, description: description || undefined },
									`stage:${stageId}:description`,
								)
							}
						/>
						<SelectField
							label="Group"
							value={stage.group}
							options={groupIds.map((id) => ({ value: id, label: id }))}
							allowEmpty
							readOnly={readOnly}
							onChange={(group) =>
								patch({ ...stage, group: group || "default" }, `stage:${stageId}:group`)
							}
						/>
						<TextField
							label="Task name"
							value={stage.taskName ?? ""}
							readOnly={readOnly}
							description="Optional task naming template; supports $file(...) and $input.* expressions."
							onChange={(taskName) =>
								patch(
									{ ...stage, taskName: taskName || undefined },
									`stage:${stageId}:taskName`,
								)
							}
						/>
						<JsonField
							label="Container name parts"
							value={stage.containerNameParts ?? []}
							rows={2}
							readOnly={readOnly}
							onChange={(containerNameParts) =>
								patch(
									{ ...stage, containerNameParts: (containerNameParts as string[]) ?? [] },
									`stage:${stageId}:container`,
								)
							}
						/>
					</div>
				) : null}

				{tab === "runtime" ? (
					<div className="space-y-4">
						<div className="grid grid-cols-2 gap-2">
							<NumberField
								label="Concurrency"
								value={stage.concurrency}
								min={1}
								readOnly={readOnly}
								onChange={(concurrency) =>
									patch({ ...stage, concurrency }, `stage:${stageId}:concurrency`)
								}
							/>
							<NumberField
								label="Max concurrency"
								value={stage.maxConcurrency ?? stage.concurrency}
								min={1}
								readOnly={readOnly}
								onChange={(maxConcurrency) =>
									patch({ ...stage, maxConcurrency }, `stage:${stageId}:maxConcurrency`)
								}
							/>
						</div>
						<ToggleField
							label="Persistent"
							description="Keep the container across tasks."
							checked={stage.runtime.persistent ?? false}
							readOnly={readOnly}
							onChange={(persistent) =>
								patch(
									{
										...stage,
										runtime: { ...stage.runtime, persistent },
										...(!persistent ? { goalPreserving: false } : {}),
									},
									`stage:${stageId}:persistent`,
								)
							}
						/>
						<ToggleField
							label="Reuse container"
							checked={stage.runtime.reuseContainer ?? false}
							readOnly={readOnly}
							onChange={(reuseContainer) =>
								patchRuntime({ ...stage.runtime, reuseContainer }, `stage:${stageId}:reuse`)
							}
						/>
						<ToggleField
							label="Nullable output"
							checked={stage.runtime.nullableOutput ?? false}
							readOnly={readOnly}
							onChange={(nullableOutput) =>
								patchRuntime({ ...stage.runtime, nullableOutput }, `stage:${stageId}:nullable`)
							}
						/>
						<ToggleField
							label="Disableable"
							checked={stage.disableable ?? true}
							readOnly={readOnly}
							onChange={(disableable) =>
								patch({ ...stage, disableable }, `stage:${stageId}:disableable`)
							}
						/>
						<ToggleField
							label="Goal prompt"
							description="Prefix the prompt with /goal and render task input as readable context."
							checked={stage.goal ?? false}
							readOnly={readOnly}
							onChange={(goal) => patch({ ...stage, goal }, `stage:${stageId}:goal`)}
						/>
						<ToggleField
							label="Goal preserving"
							description="Only valid on persistent stages. Driver records the first goal and re-issues it with the next prompt after ACP reports the previous goal complete."
							checked={stage.goalPreserving ?? false}
							readOnly={readOnly || stage.runtime.persistent !== true}
							onChange={(goalPreserving) =>
								patch(
									{ ...stage, goalPreserving },
									`stage:${stageId}:goalPreserving`,
								)
							}
						/>
						<ToggleField
							label="Allow agent exit"
							checked={stage.allowAgentExit ?? false}
							readOnly={readOnly}
							onChange={(allowAgentExit) =>
								patch({ ...stage, allowAgentExit }, `stage:${stageId}:allowAgentExit`)
							}
						/>
						<ToggleField
							label="Publish job output"
							description="Copy files referenced by output.json into /task/job-output."
							checked={stage.jobOutput ?? false}
							readOnly={readOnly}
							onChange={(jobOutput) =>
								patch({ ...stage, jobOutput }, `stage:${stageId}:jobOutput`)
							}
						/>
						<TextField
							label="Working directory (cwd)"
							value={stage.runtime.cwd ?? ""}
							readOnly={readOnly}
							description="Must stay inside /workspace, /scan-context, or /task."
							onChange={(cwd) =>
								patchRuntime({ ...stage.runtime, cwd: cwd || undefined }, `stage:${stageId}:cwd`)
							}
						/>
						<TextField
							label="Agent profile ID"
							value={stage.runtime.agentProfileId ?? ""}
							readOnly={readOnly}
							onChange={(agentProfileId) =>
								patchRuntime(
									{ ...stage.runtime, agentProfileId: agentProfileId || null },
									`stage:${stageId}:agentProfileId`,
								)
							}
						/>
						<SelectField
							label="Prepare repository"
							value={stage.runtime.prepareRepository ?? "none"}
							options={PREPARE_OPTIONS}
							readOnly={readOnly}
							onChange={(prepareRepository) =>
								patchRuntime(
									{ ...stage.runtime, prepareRepository: prepareRepository as PipelineStageV3["runtime"]["prepareRepository"] },
									`stage:${stageId}:prepare`,
								)
							}
						/>
						<ToggleField
							label="Include policy"
							checked={stage.runtime.includePolicy ?? false}
							readOnly={readOnly}
							onChange={(includePolicy) =>
								patchRuntime({ ...stage.runtime, includePolicy }, `stage:${stageId}:policy`)
							}
						/>
						<FieldTemplate
							label="Skills"
							description="Search and select skills to load into the sandbox. Their names and SKILL.md paths are prepended to the generated prompt."
						>
							<SkillMultiSelect
								value={stage.runtime.skills}
								readOnly={readOnly}
								onChange={(skills) =>
									patchRuntime(
										{
											...stage.runtime,
											skills: skills.length > 0 ? skills : undefined,
										},
										`stage:${stageId}:skills`,
									)
								}
							/>
						</FieldTemplate>
						<div className="space-y-2">
							<p className="text-xs font-medium text-foreground">Plugins</p>
							{ALLOWED_RUNTIME_PLUGINS.map((plugin) => (
								<CheckboxField
									key={plugin}
									label={plugin}
									checked={(stage.runtime.plugins ?? []).includes(plugin)}
									readOnly={readOnly}
									onChange={(checked) => {
										const plugins = checked
											? [...(stage.runtime.plugins ?? []), plugin]
											: (stage.runtime.plugins ?? []).filter((p) => p !== plugin);
										patchRuntime({ ...stage.runtime, plugins }, `stage:${stageId}:plugins`);
									}}
								/>
							))}
						</div>
					</div>
				) : null}

				{tab === "prompt" ? (
					<div className="space-y-4">
						<TextAreaField
							label="Prompt template"
							value={stage.runtime.prompt}
							rows={12}
							readOnly={readOnly}
							placeholder="Instructions for the agent. Supports {{variables}} and markdown."
							onChange={(prompt) =>
								patchRuntime({ ...stage.runtime, prompt }, `stage:${stageId}:prompt`)
							}
						/>
						<JsonField
							label="Prompt values"
							value={stage.promptValues ?? {}}
							readOnly={readOnly}
							onChange={(promptValues) =>
								patch(
									{ ...stage, promptValues: (promptValues as Record<string, unknown>) ?? {} },
									`stage:${stageId}:promptValues`,
								)
							}
						/>
					</div>
				) : null}

				{tab === "io" ? (
					<div className="space-y-4">
						<SchemaReferenceField
							label="Input schema"
							value={stage.inputSchema}
							schemaIds={schemaIds}
							readOnly={readOnly}
							onNavigateToSchema={(schemaId) => onSelect({ type: "schema", id: schemaId })}
							onChange={(inputSchema) =>
								patch({ ...stage, inputSchema }, `stage:${stageId}:inputSchema`)
							}
						/>
						<SchemaReferenceField
							label="Output schema"
							value={stage.outputSchema}
							schemaIds={schemaIds}
							readOnly={readOnly}
							onNavigateToSchema={(schemaId) => onSelect({ type: "schema", id: schemaId })}
							onChange={(outputSchema) =>
								patch({ ...stage, outputSchema }, `stage:${stageId}:outputSchema`)
							}
						/>
						<div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
							<p className="font-medium text-foreground">Route envelope</p>
							<p className="mt-1">
								{outgoing.length === 0
									? "No downstream edges."
									: routedOutgoing.length === outgoing.length
										? `${outgoing.length} routed downstream edge(s): ${routedOutgoing.map((e) => e.route?.key ?? e.id).join(", ")}`
										: routedOutgoing.length > 0
											? `Mixed routed/unrouted downstream edges — validation requires all-or-none routing.`
											: `${outgoing.length} downstream edge(s), none routed.`}
							</p>
							<p className="mt-1">
								{incoming.length} incoming edge(s)
								{incoming.length > 0
									? `: ${incoming.map((e) => `${e.from} → ${e.id}`).join(", ")}`
									: ""}
							</p>
						</div>
					</div>
				) : null}

				{tab === "artifacts" ? (
					<div className="space-y-6">
						<ArrayField
							label="Input artifacts"
							items={stage.inputArtifacts ?? []}
							readOnly={readOnly}
							onAdd={() =>
								patch(
									{ ...stage, inputArtifacts: [...(stage.inputArtifacts ?? []), { from: "$input.path", to: "/workspace", required: true }] },
									`stage:${stageId}:inputArtifacts`,
								)
							}
							onRemove={(index) =>
								patch(
									{ ...stage, inputArtifacts: (stage.inputArtifacts ?? []).filter((_, i) => i !== index) },
									`stage:${stageId}:inputArtifacts`,
								)
							}
							onChange={(index, artifact) =>
								patch(
									{ ...stage, inputArtifacts: (stage.inputArtifacts ?? []).map((a, i) => (i === index ? artifact : a)) },
									`stage:${stageId}:inputArtifacts`,
								)
							}
							renderItem={(artifact, _index, onChange) => (
								<div className="grid grid-cols-2 gap-2">
									<input
										value={artifact.from}
										disabled={readOnly}
										placeholder="from (expression)"
										onChange={(event) => onChange({ ...artifact, from: event.target.value })}
										className="h-8 rounded-md border bg-background px-2 text-xs"
									/>
									<input
										value={artifact.to}
										disabled={readOnly}
										placeholder="to (container path)"
										onChange={(event) => onChange({ ...artifact, to: event.target.value })}
										className="h-8 rounded-md border bg-background px-2 text-xs"
									/>
									<input
										value={artifact.inputField ?? ""}
										disabled={readOnly}
										placeholder="inputField (optional)"
										onChange={(event) =>
											onChange({ ...artifact, inputField: event.target.value || undefined })
										}
										className="h-8 rounded-md border bg-background px-2 text-xs"
									/>
									<CheckboxField
										label="Required"
										checked={artifact.required ?? true}
										readOnly={readOnly}
										onChange={(required) => onChange({ ...artifact, required })}
									/>
								</div>
							)}
						/>
						<ArrayField
							label="Output artifacts"
							items={stage.outputArtifacts ?? []}
							readOnly={readOnly}
							onAdd={() =>
								patch(
									{ ...stage, outputArtifacts: [...(stage.outputArtifacts ?? []), { from: "$output.path", to: "/workspace", required: true }] },
									`stage:${stageId}:outputArtifacts`,
								)
							}
							onRemove={(index) =>
								patch(
									{ ...stage, outputArtifacts: (stage.outputArtifacts ?? []).filter((_, i) => i !== index) },
									`stage:${stageId}:outputArtifacts`,
								)
							}
							onChange={(index, artifact) =>
								patch(
									{ ...stage, outputArtifacts: (stage.outputArtifacts ?? []).map((a, i) => (i === index ? artifact : a)) },
									`stage:${stageId}:outputArtifacts`,
								)
							}
							renderItem={(artifact, _index, onChange) => (
								<div className="grid grid-cols-2 gap-2">
									<input
										value={artifact.from}
										disabled={readOnly}
										placeholder="from (expression)"
										onChange={(event) => onChange({ ...artifact, from: event.target.value })}
										className="h-8 rounded-md border bg-background px-2 text-xs"
									/>
									<input
										value={artifact.to}
										disabled={readOnly}
										placeholder="to (container path)"
										onChange={(event) => onChange({ ...artifact, to: event.target.value })}
										className="h-8 rounded-md border bg-background px-2 text-xs"
									/>
									<CheckboxField
										label="Required"
										checked={artifact.required ?? true}
										readOnly={readOnly}
										onChange={(required) => onChange({ ...artifact, required })}
									/>
								</div>
							)}
						/>
					</div>
				) : null}

				{tab === "effects" ? (
					<ArrayField
						label="Effects"
						items={stage.effects ?? []}
						readOnly={readOnly}
						addLabel="Add effect"
						onAdd={() =>
							patch(
								{ ...stage, effects: [...(stage.effects ?? []), { type: "sync-candidates" }] },
								`stage:${stageId}:effects`,
							)
						}
						onRemove={(index) =>
							patch(
								{ ...stage, effects: (stage.effects ?? []).filter((_, i) => i !== index) },
								`stage:${stageId}:effects`,
							)
						}
						onChange={(index, effect) =>
							patch(
								{ ...stage, effects: (stage.effects ?? []).map((e, i) => (i === index ? effect : e)) },
								`stage:${stageId}:effects`,
							)
						}
						renderItem={(effect, _index, onChange) => (
							<div className="space-y-2">
								<SelectField
									label="Type"
									value={effect.type}
									options={[
										{ value: "sync-candidates", label: "sync-candidates" },
										{ value: "project-candidate-result", label: "project-candidate-result" },
										{ value: "research-registry", label: "research-registry" },
										{ value: "tob-goal-registry", label: "tob-goal-registry" },
									]}
									readOnly={readOnly}
									onChange={(type) => {
										if (type === "sync-candidates") {
											onChange({ type: "sync-candidates" } as PipelineEffectV3);
										} else if (type === "project-candidate-result") {
											onChange({ type, resultStage: "analyze" } as PipelineEffectV3);
										} else {
											const operations = EFFECT_OPERATIONS[type] ?? [];
											onChange({ type, operation: operations[0] } as PipelineEffectV3);
										}
									}}
								/>
								{effect.type !== "sync-candidates" ? (
									<SelectField
										label={effect.type === "project-candidate-result" ? "Result stage" : "Operation"}
										value={
											effect.type === "project-candidate-result"
												? effect.resultStage
												: "operation" in effect
													? effect.operation
													: ""
										}
										options={(EFFECT_OPERATIONS[effect.type] ?? []).map((value) => ({
											value,
											label: value,
										}))}
										readOnly={readOnly}
										onChange={(next) =>
											onChange(
												effect.type === "project-candidate-result"
													? ({ type: effect.type, resultStage: next } as PipelineEffectV3)
													: ({ type: effect.type, operation: next } as PipelineEffectV3),
											)
										}
									/>
								) : null}
								<p className="text-xs text-muted-foreground">{effectLabel(effect)}</p>
							</div>
						)}
					/>
				) : null}
			</div>
		</div>
	);
};
