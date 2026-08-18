import * as React from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

/**
 * Unified "Run Pipeline" entry (Phase 6): replaces the four hardcoded
 * scanType dialogs on application/compose pages.
 *
 * Defaults to the profile's `defaultPipelineId` current version; the advanced
 * section can pick a historical version for this run only — the profile
 * default never changes.
 */

const NONE_PROFILE = "__none__";

export type RunPipelineDialogProps = {
	target:
		| { type: "application"; applicationId: string }
		| { type: "compose"; composeId: string };
	defaultPipelineId?: string | null;
	triggerClassName?: string;
};

export const RunPipelineDialog = ({
	target,
	defaultPipelineId,
	triggerClassName,
}: RunPipelineDialogProps) => {
	const options = api.pipeline.publishedOptions.useQuery({ targetType: "project" });
	const run = api.pipeline.run.useMutation();

	const [open, setOpen] = React.useState(false);
	const [pipelineId, setPipelineId] = React.useState<string>("");
	const [versionId, setVersionId] = React.useState<string>("");
	const [profileId, setProfileId] = React.useState<string>(NONE_PROFILE);
	const [targetRef, setTargetRef] = React.useState("");
	const [targetTag, setTargetTag] = React.useState("");
	const versions = api.pipeline.listVersions.useQuery(
		{ pipelineId: pipelineId || "__none__" },
		{ enabled: Boolean(pipelineId) },
	);
	const profiles = api.pipeline.profilesList.useQuery(
		{ pipelineId: pipelineId || "__none__" },
		{ enabled: Boolean(pipelineId) },
	);

	// Default to the profile pipeline's current version when the dialog opens.
	React.useEffect(() => {
		if (!open) return;
		const preferred =
			pipelineId ||
			(defaultPipelineId && options.data?.some((o) => o.pipelineId === defaultPipelineId)
				? defaultPipelineId
				: (options.data?.[0]?.pipelineId ?? ""));
		if (preferred) {
			setPipelineId(preferred);
			const preferredVersion =
				options.data?.find((o) => o.pipelineId === preferred)
					?.currentVersionId ?? "";
			setVersionId(preferredVersion);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, options.data]);

	React.useEffect(() => {
		if (!profiles.data) return;
		if (
			profileId !== NONE_PROFILE &&
			!profiles.data.some((item) => item.pipelineProfileId === profileId)
		) {
			setProfileId(NONE_PROFILE);
		}
	}, [profileId, profiles.data]);

	const selectedVersion = versions.data?.find(
		(v) => v.pipelineVersionId === versionId,
	);
	const canRun = Boolean(pipelineId && versionId && !run.isLoading);

	const submit = async () => {
		if (!canRun) return;
		try {
			await run.mutateAsync({
				target,
				pipelineId,
				pipelineVersionId: versionId || undefined,
				pipelineProfileId:
					profileId === NONE_PROFILE ? undefined : profileId,
				repository: {
					targetRef: targetRef || undefined,
					targetTag: targetTag || undefined,
				},
			});
			toast.success("Scan started");
			setOpen(false);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to start scan");
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button className={triggerClassName}>
					<Play className="size-4" />
					Run Pipeline
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Run pipeline</DialogTitle>
					<DialogDescription>
						Runs a published pipeline version against this target. Choosing a
						runtime profile applies its stage settings to this scan only.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-1">
						<Label>Pipeline</Label>
						<Select value={pipelineId} onValueChange={(value) => {
							setPipelineId(value);
							const current = options.data?.find((o) => o.pipelineId === value)
								?.currentVersionId;
							setVersionId(current ?? "");
							setProfileId(NONE_PROFILE);
						}}>
							<SelectTrigger className="h-9">
								<SelectValue placeholder="Choose a pipeline…" />
							</SelectTrigger>
							<SelectContent>
								{options.data?.map((option) => (
									<SelectItem key={option.pipelineId} value={option.pipelineId}>
										{option.name} · v{option.currentVersionNumber}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1">
						<Label>Profile</Label>
						<Select
							value={profileId}
							onValueChange={setProfileId}
							disabled={!pipelineId}
						>
							<SelectTrigger className="h-9">
								<SelectValue placeholder="Pipeline defaults" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={NONE_PROFILE}>
									Pipeline defaults
								</SelectItem>
								{profiles.data?.map((profile) => (
									<SelectItem
										key={profile.pipelineProfileId}
										value={profile.pipelineProfileId}
									>
										{profile.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-xs text-muted-foreground">
							{profiles.isLoading
								? "Loading profiles…"
								: profiles.data?.length
									? "Applies this profile's model, concurrency, and stage switches to the run."
									: "No profiles for this pipeline. The run uses YAML defaults."}
						</p>
					</div>

					<div className="space-y-1">
						<Label>Version (advanced — this run only)</Label>
						<Select value={versionId} onValueChange={setVersionId}>
							<SelectTrigger className="h-9">
								<SelectValue
									placeholder={
										selectedVersion
											? `v${selectedVersion.versionNumber}`
											: "Current version"
									}
								/>
							</SelectTrigger>
							<SelectContent>
								{versions.data?.map((version) => (
									<SelectItem
										key={version.pipelineVersionId}
										value={version.pipelineVersionId}
									>
										v{version.versionNumber} · {version.source}
										{version.pipelineVersionId ===
										options.data?.find((o) => o.pipelineId === pipelineId)
											?.currentVersionId
											? " · current"
											: ""}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<Label>Ref</Label>
							<Input
								value={targetRef}
								onChange={(event) => setTargetRef(event.target.value)}
								placeholder="main"
							/>
						</div>
						<div className="space-y-1">
							<Label>Tag</Label>
							<Input
								value={targetTag}
								onChange={(event) => setTargetTag(event.target.value)}
								placeholder="latest"
							/>
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button onClick={() => void submit()} disabled={!canRun}>
						{run.isLoading ? "Starting…" : "Start scan"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
