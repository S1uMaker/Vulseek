import * as React from "react";
import type { PipelineDiagnostic, PipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import { relatedSchemaIds } from "@/lib/pipeline-editor/definition-helpers";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";

/**
 * Ctrl/Cmd+P quick switcher: jump to any stage, edge, schema, group, or
 * diagnostic from anywhere in the workbench.
 */

export type QuickSwitcherProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	document: PipelineDocumentV3;
	diagnostics: PipelineDiagnostic[];
	dispatch: React.Dispatch<PipelineEditorAction>;
	/** Switch the workbench to the Definition view for the entity. */
	onNavigateToDefinition: () => void;
};

const labelForDiagnostic = (message: string): string =>
	message.length > 72 ? `${message.slice(0, 69)}…` : message;

export const QuickSwitcher = ({
	open,
	onOpenChange,
	document,
	diagnostics,
	dispatch,
	onNavigateToDefinition,
}: QuickSwitcherProps) => {
	const jump = (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => {
		dispatch({ type: "select", entity });
		onNavigateToDefinition();
		onOpenChange(false);
	};

	const jumpFromEntity = (entity: PipelineDiagnostic["entity"]): void => {
		if (!entity || entity.type === "pipeline") {
			onOpenChange(false);
			return;
		}
		jump({ type: entity.type, id: entity.id });
	};

	return (
		<CommandDialog open={open} onOpenChange={onOpenChange}>
			<CommandInput placeholder="Jump to a stage, edge, schema, group, or diagnostic…" />
			<CommandList>
				<CommandEmpty>No results.</CommandEmpty>
				<CommandGroup heading="Stages">
					{Object.entries(document.stages).map(([id, stage]) => (
						<CommandItem key={id} value={`stage ${id} ${stage.name}`} onSelect={() => jump({ type: "stage", id })}>
							{stage.name}
							<span className="ml-2 text-xs text-muted-foreground">{id}</span>
						</CommandItem>
					))}
				</CommandGroup>
				<CommandGroup heading="Edges">
					{document.edges.map((edge) => (
						<CommandItem
							key={edge.id}
							value={`edge ${edge.id} ${edge.from} ${edge.to}`}
							onSelect={() => jump({ type: "edge", id: edge.id })}
						>
							{edge.from} → {edge.to}
							<span className="ml-2 text-xs text-muted-foreground">{edge.id}</span>
						</CommandItem>
					))}
				</CommandGroup>
				<CommandGroup heading="Schemas">
					{relatedSchemaIds(document).map((id) => (
						<CommandItem key={id} value={`schema ${id}`} onSelect={() => jump({ type: "schema", id })}>
							{id}
						</CommandItem>
					))}
				</CommandGroup>
				<CommandGroup heading="Groups">
					{document.groups.map((group) => (
						<CommandItem
							key={group.id}
							value={`group ${group.id} ${group.name}`}
							onSelect={() => jump({ type: "group", id: group.id })}
						>
							{group.name}
							<span className="ml-2 text-xs text-muted-foreground">{group.id}</span>
						</CommandItem>
					))}
				</CommandGroup>
				{diagnostics.length > 0 ? (
					<CommandGroup heading="Diagnostics">
						{diagnostics.map((diagnostic, index) => (
							<CommandItem
								key={`${diagnostic.code}-${index}`}
								value={`diagnostic ${diagnostic.message} ${diagnostic.entity?.id ?? ""}`}
								onSelect={() => jumpFromEntity(diagnostic.entity)}
							>
								<span className={diagnostic.severity === "error" ? "text-red-600" : "text-amber-600"}>
									{diagnostic.severity === "error" ? "error" : "warning"}
								</span>
								<span className="ml-2 truncate">{labelForDiagnostic(diagnostic.message)}</span>
							</CommandItem>
						))}
					</CommandGroup>
				) : null}
			</CommandList>
		</CommandDialog>
	);
};
