import * as React from "react";
import { Plus } from "lucide-react";
import type { PipelineStageV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nextUniqueId } from "@/lib/pipeline-editor/pipeline-layout";

/**
 * Stage creation dialog: stable slug (auto-suggested, editable), name, role
 * and group. Existing stage ids are immutable — the slug is generated unique
 * against the current document.
 */

export type StageCreateDialogProps = {
	existingIds: readonly string[];
	onCreate: (id: string, stage: PipelineStageV3) => void;
	/** Optional trigger for embedding the dialog in another toolbar. */
	trigger?: React.ReactElement;
	defaultGroup?: string;
};

const defaultStage = (
	id: string,
	name: string,
	role: PipelineStageV3["role"],
	group: string,
): PipelineStageV3 => ({
	name,
	role,
	group,
	concurrency: 1,
	disableable: true,
	goal: false,
	goalPreserving: false,
	inputArtifacts: [],
	outputArtifacts: [],
	jobOutput: false,
	effects: [],
	containerNameParts: [],
	allowAgentExit: false,
	promptValues: {},
	runtime: {
		kind: "agent",
		prompt: "Analyze this target.",
		prepareRepository: "none",
		includePolicy: false,
		plugins: [],
	},
});

export const StageCreateDialog = ({
	existingIds,
	onCreate,
	trigger,
	defaultGroup = "custom",
}: StageCreateDialogProps) => {
	const [open, setOpen] = React.useState(false);
	const [slug, setSlug] = React.useState("");
	const [name, setName] = React.useState("");
	const [role, setRole] = React.useState<PipelineStageV3["role"]>("scan");
	const [group, setGroup] = React.useState("custom");

	const resetForm = () => {
		const base = nextUniqueId("stage", new Set(existingIds));
		setSlug(base);
		setName("New Stage");
		setRole("scan");
		setGroup(defaultGroup);
	};

	const openDialog = () => {
		resetForm();
		setOpen(true);
	};

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen) resetForm();
		setOpen(nextOpen);
	};

	const submit = () => {
		const id = slug.trim() || nextUniqueId("stage", new Set(existingIds));
		if (existingIds.includes(id)) return;
		onCreate(
			id,
			defaultStage(id, name.trim() || "New Stage", role, group.trim() || defaultGroup),
		);
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				{trigger ?? (
					<Button variant="outline" size="sm" onClick={openDialog}>
						<Plus className="size-3.5" />
						Add stage
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Add stage</DialogTitle>
					<DialogDescription>
						The slug is permanent and URL-safe; the name and group can change
						later.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1">
						<Label>Slug (immutable)</Label>
						<Input
							value={slug}
							onChange={(event) =>
								setSlug(
									event.target.value
										.toLowerCase()
										.replace(/[^a-z0-9_-]/g, "-"),
								)
							}
							/>
						{existingIds.includes(slug.trim()) ? (
							<p className="text-xs text-red-600" role="alert">
								A stage with this slug already exists.
							</p>
						) : null}
					</div>
					<div className="space-y-1">
						<Label>Name</Label>
						<Input value={name} onChange={(event) => setName(event.target.value)} />
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<Label>Role</Label>
							<select
								value={role}
								onChange={(event) =>
									setRole(event.target.value as PipelineStageV3["role"])
								}
								className="h-9 w-full rounded-md border bg-background px-2 text-sm"
							>
								<option value="scan">scan</option>
								<option value="analysis">analysis</option>
								<option value="verification">verification</option>
							</select>
						</div>
						<div className="space-y-1">
							<Label>Group</Label>
							<Input
								value={group}
								onChange={(event) => setGroup(event.target.value)}
							/>
						</div>
					</div>
				</div>
				<DialogFooter>
					<Button disabled={existingIds.includes(slug.trim())} onClick={submit}>
						Create stage
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
