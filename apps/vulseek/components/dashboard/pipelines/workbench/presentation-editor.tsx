import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { PipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	JOB_TAB_DATA_SOURCE_CATALOG,
	JOB_TAB_DATA_SOURCES,
	type PipelineJobTab,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import { Button } from "@/components/ui/button";
import {
	CheckboxField,
	FieldTemplate,
	SectionHeading,
	SelectField,
	TextField,
} from "./workbench-fields";

export type PresentationEditorProps = {
	document: PipelineDocumentV3;
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
};

const emptyTab = (index: number): PipelineJobTab => ({
	id: `results-${index + 1}`,
	label: "Results",
	renderer: "entity-table",
	dataSource: "vulnerability-candidates",
	columns: [...JOB_TAB_DATA_SOURCE_CATALOG["vulnerability-candidates"].fields],
	filters: [...JOB_TAB_DATA_SOURCE_CATALOG["vulnerability-candidates"].filters],
	defaultSort: { field: "createdAt", direction: "desc" },
	detail: "vulnerability-candidate",
});

export const PresentationEditor = ({
	document,
	dispatch,
	readOnly,
}: PresentationEditorProps) => {
	const tabs = document.presentation?.jobTabs ?? [];
	const [selectedIndex, setSelectedIndex] = React.useState(0);
	const selected = tabs[selectedIndex] ?? null;
	const catalog = selected
		? JOB_TAB_DATA_SOURCE_CATALOG[selected.dataSource]
		: null;

	const commit = (next: PipelineJobTab[]) => {
		dispatch({
			type: "patch",
			ops: [{ op: "updatePresentation", presentation: { jobTabs: next } }],
			key: "presentation:jobTabs",
		});
	};

	const updateTab = (index: number, patch: Partial<PipelineJobTab>) => {
		commit(tabs.map((tab, i) => (i === index ? { ...tab, ...patch } : tab)));
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto pb-12">
			<SectionHeading
				title="Presentation"
				subtitle="Job result tabs shown between Tasks and Monitoring"
			/>
			<div className="space-y-4 p-4">
				<div className="flex items-center justify-between">
					<p className="text-xs text-muted-foreground">{tabs.length} tab(s)</p>
					<Button
						size="sm"
						variant="outline"
						disabled={readOnly}
						onClick={() => {
							commit([...tabs, emptyTab(tabs.length)]);
							setSelectedIndex(tabs.length);
						}}
					>
						<Plus className="size-3.5" />
						Add tab
					</Button>
				</div>
				<div className="space-y-1">
					{tabs.map((tab, index) => (
						<button
							key={`${tab.id}-${index}`}
							type="button"
							className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm ${
								index === selectedIndex
									? "border-ring bg-muted/60"
									: "border-transparent hover:bg-muted/40"
							}`}
							onClick={() => setSelectedIndex(index)}
						>
							<span className="font-medium">{tab.label}</span>
							<span className="ml-auto text-xs text-muted-foreground">
								{tab.id}
							</span>
						</button>
					))}
				</div>
				{selected && catalog ? (
					<div className="space-y-3 rounded-md border p-3">
						<div className="flex gap-1">
							<Button
								size="icon"
								variant="ghost"
								className="size-8"
								disabled={readOnly || selectedIndex === 0}
								onClick={() => {
									const next = [...tabs];
									[next[selectedIndex - 1], next[selectedIndex]] = [
										next[selectedIndex]!,
										next[selectedIndex - 1]!,
									];
									commit(next);
									setSelectedIndex(selectedIndex - 1);
								}}
							>
								<ArrowUp className="size-3.5" />
							</Button>
							<Button
								size="icon"
								variant="ghost"
								className="size-8"
								disabled={readOnly || selectedIndex === tabs.length - 1}
								onClick={() => {
									const next = [...tabs];
									[next[selectedIndex], next[selectedIndex + 1]] = [
										next[selectedIndex + 1]!,
										next[selectedIndex]!,
									];
									commit(next);
									setSelectedIndex(selectedIndex + 1);
								}}
							>
								<ArrowDown className="size-3.5" />
							</Button>
							<Button
								size="icon"
								variant="ghost"
								className="size-8 text-red-600"
								disabled={readOnly}
								onClick={() => {
									commit(tabs.filter((_, index) => index !== selectedIndex));
									setSelectedIndex(Math.max(0, selectedIndex - 1));
								}}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
						<TextField
							label="ID"
							value={selected.id}
							readOnly={readOnly}
							onChange={(id) => updateTab(selectedIndex, { id })}
						/>
						<TextField
							label="Label"
							value={selected.label}
							readOnly={readOnly}
							onChange={(label) => updateTab(selectedIndex, { label })}
						/>
						<SelectField
							label="Data source"
							value={selected.dataSource}
							readOnly={readOnly}
							options={JOB_TAB_DATA_SOURCES.map((id) => ({
								value: id,
								label: JOB_TAB_DATA_SOURCE_CATALOG[id].label,
							}))}
							onChange={(value) => {
								const dataSource = value as PipelineJobTab["dataSource"];
								const next = JOB_TAB_DATA_SOURCE_CATALOG[dataSource];
								updateTab(selectedIndex, {
									dataSource,
									renderer: next.renderers[0],
									columns: [...next.fields],
									filters: [...next.filters],
									defaultSort: next.sortable[0]
										? { field: next.sortable[0], direction: "desc" }
										: undefined,
									detail: next.details[0],
								});
							}}
						/>
						<SelectField
							label="Renderer"
							value={selected.renderer}
							readOnly={readOnly}
							options={catalog.renderers.map((renderer) => ({
								value: renderer,
								label: renderer,
							}))}
							onChange={(renderer) =>
								updateTab(selectedIndex, {
									renderer: renderer as PipelineJobTab["renderer"],
								})
							}
						/>
						<FieldTemplate label="Columns" description="Fields shown in the table.">
							<div className="space-y-1">
								{catalog.fields.map((field) => (
									<CheckboxField
										key={field}
										label={field}
										checked={selected.columns.includes(field)}
										readOnly={readOnly}
										onChange={(checked) =>
											updateTab(selectedIndex, {
												columns: checked
													? [...selected.columns, field]
													: selected.columns.filter((item) => item !== field),
											})
										}
									/>
								))}
							</div>
						</FieldTemplate>
						<FieldTemplate label="Filters">
							<div className="space-y-1">
								{catalog.filters.map((field) => (
									<CheckboxField
										key={field}
										label={field}
										checked={selected.filters.includes(field)}
										readOnly={readOnly}
										onChange={(checked) =>
											updateTab(selectedIndex, {
												filters: checked
													? [...selected.filters, field]
													: selected.filters.filter((item) => item !== field),
											})
										}
									/>
								))}
							</div>
						</FieldTemplate>
						<div className="grid grid-cols-2 gap-2">
							<SelectField
								label="Default sort"
								value={selected.defaultSort?.field ?? ""}
								readOnly={readOnly}
								options={[
									{ value: "", label: "None" },
									...catalog.sortable.map((field) => ({
										value: field,
										label: field,
									})),
								]}
								onChange={(field) =>
									updateTab(selectedIndex, {
										defaultSort: field
											? {
													field,
													direction: selected.defaultSort?.direction ?? "desc",
												}
											: undefined,
									})
								}
							/>
							<FieldTemplate label="Direction">
								<select
									value={selected.defaultSort?.direction ?? "desc"}
									disabled={readOnly || !selected.defaultSort}
									onChange={(event) =>
										updateTab(selectedIndex, {
											defaultSort: selected.defaultSort
												? {
														...selected.defaultSort,
														direction: event.target.value as "asc" | "desc",
													}
												: undefined,
										})
									}
									className="h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
								>
									<option value="desc">desc</option>
									<option value="asc">asc</option>
								</select>
							</FieldTemplate>
						</div>
						<SelectField
							label="Detail"
							value={selected.detail ?? ""}
							readOnly={readOnly}
							options={[
								{ value: "", label: "None" },
								...catalog.details.map((detail) => ({
									value: detail,
									label: detail,
								})),
							]}
							onChange={(detail) =>
								updateTab(selectedIndex, {
									detail: detail
										? (detail as PipelineJobTab["detail"])
										: undefined,
								})
							}
						/>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						No result tabs. Add one or leave empty for Overview/Tasks only.
					</p>
				)}
			</div>
		</div>
	);
};
