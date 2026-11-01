import type { PipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import type * as React from "react";
import { entityCounts } from "@/lib/pipeline-editor/definition-helpers";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import {
	CheckboxField,
	FieldTemplate,
	NumberField,
	SectionHeading,
	TextAreaField,
	TextField,
} from "./workbench-fields";

/**
 * Overview editor: pipeline identity, supported targets, root stage, and
 * limits, plus a read-only summary of entity counts and draft state.
 */

export type OverviewEditorProps = {
	document: PipelineDocumentV3;
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
	draftState: {
		dirty: boolean;
		draftRevision: number;
		publishedVersion: string | null;
	};
};

export const OverviewEditor = ({
	document,
	dispatch,
	readOnly,
	draftState,
}: OverviewEditorProps) => {
	const counts = entityCounts(document);
	const stageOptions = Object.keys(document.stages).map((id) => ({
		value: id,
		label: `${document.stages[id]?.name ?? id} (${id})`,
	}));

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto pb-12">
			<SectionHeading
				title="Overview"
				subtitle={`${counts.stages} stages · ${counts.edges} edges · ${counts.schemas} schemas · ${counts.groups} groups`}
			/>
			<div className="space-y-4 p-4">
				<TextField
					label="Name"
					value={document.name}
					readOnly={readOnly}
					onChange={(name) =>
						dispatch({
							type: "patch",
							ops: [{ op: "updateOverview", overview: { name } }],
							key: "overview:name",
						})
					}
				/>
				<TextAreaField
					label="Description"
					value={document.description ?? ""}
					readOnly={readOnly}
					rows={3}
					onChange={(description) =>
						dispatch({
							type: "patch",
							ops: [
								{
									op: "updateOverview",
									overview: { description: description || undefined },
								},
							],
							key: "overview:description",
						})
					}
				/>
				<FieldTemplate
					label="Supported targets"
					description="Which project kinds can run this pipeline."
				>
					<div className="space-y-2">
						{(["project", "evaluation"] as const).map((target) => (
							<CheckboxField
								key={target}
								label={target}
								checked={document.supportedTargets.includes(target)}
								readOnly={readOnly}
								onChange={(checked) => {
									const next = checked
										? [...document.supportedTargets, target]
										: document.supportedTargets.filter((t) => t !== target);
									dispatch({
										type: "patch",
										ops: [
											{
												op: "updateOverview",
												overview: { supportedTargets: next },
											},
										],
										key: "overview:targets",
									});
								}}
							/>
						))}
					</div>
				</FieldTemplate>
				<FieldTemplate
					label="Root stage"
					description="The pipeline always starts here."
				>
					<select
						value={document.root}
						disabled={readOnly}
						onChange={(event) =>
							dispatch({
								type: "patch",
								ops: [
									{
										op: "updateOverview",
										overview: { root: event.target.value },
									},
								],
								key: "overview:root",
							})
						}
						className="h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
					>
						{stageOptions.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</FieldTemplate>
				<FieldTemplate
					label="Limits"
					description="Hard caps enforced by the scheduler; publishing warns above the defaults (10,000 tasks / 24h)."
				>
					<div className="grid grid-cols-2 gap-2">
						<NumberField
							label="Max tasks"
							value={document.limits.maxTasks}
							min={1}
							readOnly={readOnly}
							onChange={(maxTasks) =>
								dispatch({
									type: "patch",
									ops: [
										{
											op: "updateLimits",
											limits: {
												maxTasks,
												maxDurationSeconds: document.limits.maxDurationSeconds,
											},
										},
									],
									key: "overview:limits",
								})
							}
						/>
						<NumberField
							label="Max duration (s)"
							value={document.limits.maxDurationSeconds}
							min={1}
							readOnly={readOnly}
							onChange={(maxDurationSeconds) =>
								dispatch({
									type: "patch",
									ops: [
										{
											op: "updateLimits",
											limits: {
												maxTasks: document.limits.maxTasks,
												maxDurationSeconds,
											},
										},
									],
									key: "overview:limits",
								})
							}
						/>
					</div>
				</FieldTemplate>

				<div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
					<p className="font-medium text-foreground">Draft state</p>
					<p className="mt-1">
						{draftState.dirty
							? "Draft (unsaved)"
							: "In sync with the saved draft"}
						{draftState.publishedVersion
							? ` · current published v${draftState.publishedVersion}`
							: " · no published version"}
					</p>
				</div>
			</div>
		</div>
	);
};
