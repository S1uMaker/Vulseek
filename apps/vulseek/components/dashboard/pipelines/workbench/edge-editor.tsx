import * as React from "react";
import type {
	PipelineDiagnostic,
	PipelineDocumentV3,
	PipelineEdgeV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import { cn } from "@/lib/utils";
import {
	ArrayField,
	CheckboxField,
	EntityDiagnostics,
	JsonField,
	SchemaReferenceField,
	SectionHeading,
	SelectField,
	TextField,
	ToggleField,
} from "./workbench-fields";

/**
 * Edge editor (Definition view): General, Route, Transform, Artifacts, and
 * Output Contract. Multiple edges between the same endpoints stay valid when
 * ids or routes differ; the route section surfaces sibling routes.
 */

export type EdgeEditorProps = {
	edgeId: string;
	edge: PipelineEdgeV3;
	document: PipelineDocumentV3;
	diagnostics: PipelineDiagnostic[];
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
	onSelect: (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => void;
};

export const EdgeEditor = ({
	edgeId,
	edge,
	document,
	diagnostics,
	dispatch,
	readOnly,
	onSelect,
}: EdgeEditorProps) => {
	const [tab, setTab] = React.useState<
		"general" | "route" | "transform" | "artifacts" | "output"
	>("general");

	const patch = (next: PipelineEdgeV3, key: string) =>
		dispatch({ type: "patch", ops: [{ op: "updateEdge", edgeId, edge: next }], key });
	const patchRouteMetadata = (
		updateRoute: (route: NonNullable<PipelineEdgeV3["route"]>) => NonNullable<PipelineEdgeV3["route"]>,
		key: string,
	) => {
		const routeKey = edge.route?.key;
		const matchingEdges = routeKey
			? document.edges.filter(
					(other) => other.from === edge.from && other.route?.key === routeKey,
				)
			: [edge];
		dispatch({
			type: "patch",
			ops: matchingEdges.map((other) => ({
				op: "updateEdge" as const,
				edgeId: other.id,
				edge: {
					...other,
					route: other.route ? updateRoute(other.route) : other.route,
				},
			})),
			key,
		});
	};

	const stageOptions = Object.keys(document.stages).map((id) => ({
		value: id,
		label: `${document.stages[id]?.name ?? id} (${id})`,
	}));
	const siblings = document.edges.filter(
		(other) => other.id !== edgeId && other.from === edge.from && other.to === edge.to,
	);
	const routedSiblings = document.edges.filter(
		(other) => other.id !== edgeId && other.from === edge.from && other.route?.key,
	);

	const tabs = [
		{ id: "general" as const, label: "General" },
		{ id: "route" as const, label: "Route" },
		{ id: "transform" as const, label: "Transform" },
		{ id: "artifacts" as const, label: "Artifacts" },
		{ id: "output" as const, label: "Output contract" },
	];

	return (
		<div className="flex h-full min-h-0 flex-col">
			<SectionHeading
				title={`${edge.from} → ${edge.to}`}
				subtitle={`${edgeId} · ${edge.mode}${edge.route ? ` · route ${edge.route.key}` : ""}`}
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
						<TextField label="ID (immutable)" value={edgeId} readOnly />
						<TextField
							label="Name"
							value={edge.name}
							readOnly={readOnly}
							onChange={(name) => patch({ ...edge, name }, `edge:${edgeId}:name`)}
						/>
						<SelectField
							label="Source stage"
							value={edge.from}
							options={stageOptions}
							readOnly={readOnly}
							onChange={(from) => patch({ ...edge, from }, `edge:${edgeId}:from`)}
						/>
						<SelectField
							label="Target stage"
							value={edge.to}
							options={stageOptions}
							readOnly={readOnly}
							onChange={(to) => patch({ ...edge, to }, `edge:${edgeId}:to`)}
						/>
						<SelectField
							label="Mode"
							value={edge.mode}
							options={[
								{ value: "map", label: "Map" },
								{ value: "fanOut", label: "Fan-out" },
							]}
							readOnly={readOnly}
							onChange={(mode) =>
								patch({ ...edge, mode: mode as PipelineEdgeV3["mode"] }, `edge:${edgeId}:mode`)
							}
						/>
						<ToggleField
							label="Fork"
							description="Branch downstream processing."
							checked={edge.fork ?? false}
							readOnly={readOnly}
							onChange={(fork) => patch({ ...edge, fork }, `edge:${edgeId}:fork`)}
						/>
					</div>
				) : null}

				{tab === "route" ? (
					<div className="space-y-4">
						<div className="grid grid-cols-[1fr_auto] gap-2">
							<TextField
								label="Route key"
								value={edge.route?.key ?? ""}
								readOnly={readOnly}
								description="Used for condition routing; keys must match the stage's other routed edges."
								onChange={(key) =>
									patch(
										{ ...edge, route: key ? { ...edge.route, key } : undefined },
										`edge:${edgeId}:routeKey`,
									)
								}
							/>
							<div className="pt-5">
								<ToggleField
									label="Default route"
									checked={edge.route?.default ?? false}
									readOnly={readOnly}
									onChange={(isDefault) =>
										edge.route
										? patchRouteMetadata(
											(route) => ({ ...route, default: isDefault }),
											`edge:${edgeId}:routeDefault`,
										)
										: patch(
												{ ...edge, route: { key: edge.name || edgeId, default: isDefault } },
												`edge:${edgeId}:routeDefault`,
											)
								}
								/>
							</div>
						</div>
						<TextField
							label="Route description (optional)"
							value={edge.route?.description ?? ""}
							readOnly={readOnly}
							description="Explain when this route should be selected. Leave empty when the route is self-explanatory."
							onChange={(description) =>
								edge.route
									? patchRouteMetadata(
											(route) => ({ ...route, description: description.trim() || undefined }),
											`edge:${edgeId}:routeDescription`,
										)
									: undefined
						}
						/>
						{siblings.length > 0 || routedSiblings.length > 0 ? (
							<div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
								<p className="font-medium text-foreground">Sibling routes</p>
								<ul className="mt-1 space-y-1">
									{siblings.map((sibling) => (
										<li key={sibling.id}>
											<button
												type="button"
												onClick={() => onSelect({ type: "edge", id: sibling.id })}
												className="text-sky-600 hover:underline"
											>
												{sibling.id}
											</button>{" "}
											· {sibling.route?.key ?? "no route key"}
										</li>
									))}
									{routedSiblings.map((sibling) => (
										<li key={sibling.id}>
											<button
												type="button"
												onClick={() => onSelect({ type: "edge", id: sibling.id })}
												className="text-sky-600 hover:underline"
											>
												{sibling.id}
											</button>{" "}
											· route {sibling.route?.key}
										</li>
									))}
								</ul>
							</div>
						) : null}
					</div>
				) : null}

				{tab === "transform" ? (
					<div className="space-y-4">
						<TextField
							label="foreach"
							value={edge.foreach ?? ""}
							readOnly={readOnly}
							description="Expression expanding fan-out items (e.g. $item, $input.files)."
							onChange={(foreach) =>
								patch({ ...edge, foreach: foreach || undefined }, `edge:${edgeId}:foreach`)
							}
						/>
						<JsonField
							label="Input"
							value={edge.input}
							readOnly={readOnly}
							onChange={(input) => patch({ ...edge, input }, `edge:${edgeId}:input`)}
						/>
					</div>
				) : null}

				{tab === "artifacts" ? (
					<ArrayField
						label="Artifacts"
						items={edge.artifacts ?? []}
						readOnly={readOnly}
						onAdd={() =>
							patch(
								{ ...edge, artifacts: [...(edge.artifacts ?? []), { from: "$input.path", to: "/workspace", required: true }] },
								`edge:${edgeId}:artifacts`,
							)
						}
						onRemove={(index) =>
							patch(
								{ ...edge, artifacts: (edge.artifacts ?? []).filter((_, i) => i !== index) },
								`edge:${edgeId}:artifacts`,
							)
						}
						onChange={(index, artifact) =>
							patch(
								{ ...edge, artifacts: (edge.artifacts ?? []).map((a, i) => (i === index ? artifact : a)) },
								`edge:${edgeId}:artifacts`,
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
				) : null}

				{tab === "output" ? (
					<div className="space-y-4">
						<SchemaReferenceField
							label="Output schema"
							value={edge.outputSchema}
							schemaIds={Object.keys(document.schemas)}
							readOnly={readOnly}
							onNavigateToSchema={(schemaId) => onSelect({ type: "schema", id: schemaId })}
							onChange={(outputSchema) =>
								patch({ ...edge, outputSchema }, `edge:${edgeId}:outputSchema`)
							}
						/>
					</div>
				) : null}
			</div>
		</div>
	);
};
