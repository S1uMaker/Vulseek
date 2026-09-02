"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { BotIcon, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import {
	buildPipelineStageTree,
	getStageSelectionState,
	toggleStageSelection,
} from "./scan-stage-settings-tree";

type AgentProfileOption = {
	agentProfileId: string;
	name: string;
	provider?: "codex" | "claude_code" | "grok_build" | string;
	isEnabled: boolean;
};

export type ScanStageSettings = Record<
	string,
	{
		agentProfileId?: string | null;
		concurrency?: number | null;
	}
>;

export type ScanStageSettingsTarget = {
	scanStageSettings?: ScanStageSettings | null;
};

type StageDefinition = {
	stageName: string;
	label: string;
	role: "scan" | "analysis" | "verification";
	group: string;
	concurrency: number;
	maxConcurrency: number;
	disableable: boolean;
	description: string;
};

const titleCase = (value: string) =>
	value
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());

const PIPELINE_TITLES: Record<string, string> = {
	full: "Full Scan",
	delta: "Delta Scan",
	research: "Research Scan",
	"tob-goal": "Goal Scan",
};

const PIPELINE_ORDER = ["full", "delta", "research", "tob-goal"];

const StageSettingsFormSchema = z.object({
	agentProfileId: z.string().min(1),
	concurrency: z.coerce.number().int().min(1).max(128),
});

type StageSettingsForm = z.infer<typeof StageSettingsFormSchema>;

const BatchEditFormSchema = z.object({
	agentProfileId: z.string().min(1),
});

type BatchEditForm = z.infer<typeof BatchEditFormSchema>;

const getStageAgentProfileId = (
	target: ScanStageSettingsTarget,
	stage: StageDefinition,
	enabledProfiles: AgentProfileOption[],
) =>
	target.scanStageSettings?.[stage.stageName]?.agentProfileId ||
	enabledProfiles[0]?.agentProfileId ||
	"";

const getStageConcurrency = (
	target: ScanStageSettingsTarget,
	stage: StageDefinition,
) =>
	target.scanStageSettings?.[stage.stageName]?.concurrency ||
	stage.concurrency;

export const ScanStageSettingsPanel = ({
	target,
	agentProfiles,
	onSave,
}: {
	target?: ScanStageSettingsTarget | null;
	agentProfiles?: AgentProfileOption[];
	onSave: (payload: Record<string, unknown>) => Promise<void>;
}) => {
	const [selectedStageName, setSelectedStageName] = useState<string | null>(
		null,
	);
	const [checkedStageNames, setCheckedStageNames] = useState<Set<string>>(
		new Set(),
	);
	const [expandedPipelineIds, setExpandedPipelineIds] = useState<Set<string>>(
		new Set(),
	);
	const [isBatchEditOpen, setIsBatchEditOpen] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const { data: pipelineDefinitions, isLoading: isLoadingPipelineDefinitions } =
		api.scan.pipelineDefinitions.useQuery();
	const stages = useMemo<StageDefinition[]>(
		() =>
			pipelineDefinitions?.stages.map((stage) => ({
				stageName: stage.id,
				label: stage.name,
				role: stage.role,
				group: stage.group,
				concurrency: stage.concurrency,
				maxConcurrency: stage.maxConcurrency ?? 128,
				disableable: stage.disableable,
				description: stage.description ?? stage.name,
			})) ?? [],
		[pipelineDefinitions],
	);
	const pipelines = useMemo(
		() =>
			Object.values(pipelineDefinitions?.pipelines ?? {})
				.map((pipeline) => ({
					id: pipeline.id,
					name: PIPELINE_TITLES[pipeline.id] ?? titleCase(pipeline.name),
					stageIds: pipeline.stageIds,
				}))
				.sort((left, right) => {
					const leftOrder = PIPELINE_ORDER.indexOf(left.id);
					const rightOrder = PIPELINE_ORDER.indexOf(right.id);
					return (
						(leftOrder === -1 ? Number.MAX_SAFE_INTEGER : leftOrder) -
						(rightOrder === -1 ? Number.MAX_SAFE_INTEGER : rightOrder)
					);
				}),
		[pipelineDefinitions],
	);
	const enabledProfiles = useMemo(
		() => agentProfiles?.filter((profile) => profile.isEnabled) ?? [],
		[agentProfiles],
	);
	const selectedStage =
		stages.find((stage) => stage.stageName === selectedStageName) ?? null;
	const form = useForm<StageSettingsForm>({
		defaultValues: {
			agentProfileId: "",
			concurrency: 1,
		},
		resolver: zodResolver(StageSettingsFormSchema),
	});

	const batchForm = useForm<BatchEditForm>({
		defaultValues: { agentProfileId: "" },
		resolver: zodResolver(BatchEditFormSchema),
	});

	const allChecked =
		checkedStageNames.size === stages.length && stages.length > 0;
	const someChecked =
		checkedStageNames.size > 0 && checkedStageNames.size < stages.length;

	const toggleAll = (checked: boolean) => {
		setCheckedStageNames((previous) =>
			toggleStageSelection(
				previous,
				stages.map((stage) => stage.stageName),
				checked,
			),
		);
	};

	const toggleStage = (stageName: string, checked: boolean) => {
		setCheckedStageNames((previous) =>
			toggleStageSelection(previous, [stageName], checked),
		);
	};

	const togglePipeline = (pipelineId: string) => {
		setExpandedPipelineIds((previous) => {
			const next = new Set(previous);
			if (next.has(pipelineId)) {
				next.delete(pipelineId);
			} else {
				next.add(pipelineId);
			}
			return next;
		});
	};

	const rows = useMemo(
		() =>
			stages.map((stage) => {
				const agentProfileId = target
					? getStageAgentProfileId(target, stage, enabledProfiles)
					: "";
				const agentProfile = enabledProfiles.find(
					(profile) => profile.agentProfileId === agentProfileId,
				);
				return {
					...stage,
					agentProfileId,
					agentProfileName: agentProfile?.name || "Default",
					concurrency: target
						? getStageConcurrency(target, stage)
						: stage.concurrency,
				};
			}),
		[target, enabledProfiles, stages],
	);

	const pipelineTree = useMemo(
		() =>
			buildPipelineStageTree(pipelines, rows).map((pipeline) => ({
				...pipeline,
				selection: getStageSelectionState(
					checkedStageNames,
					pipeline.stageIds,
				),
			})),
		[checkedStageNames, pipelines, rows],
	);

	useEffect(() => {
		if (!selectedStage || !target) {
			return;
		}
		form.reset({
			agentProfileId: getStageAgentProfileId(
				target,
				selectedStage,
				enabledProfiles,
			),
			concurrency: getStageConcurrency(target, selectedStage),
		});
	}, [selectedStage, target, enabledProfiles, form]);

	if (isLoadingPipelineDefinitions) {
		return (
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<BotIcon className="size-5 text-muted-foreground" />
						Stage Agent Settings
					</CardTitle>
					<CardDescription>
						Loading scan pipeline definitions.
					</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	if (enabledProfiles.length === 0) {
		return (
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<BotIcon className="size-5 text-muted-foreground" />
						Agent Settings
					</CardTitle>
					<CardDescription>
						Configure dedicated agent profiles and concurrency per scan stage.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="text-sm text-muted-foreground">
						No enabled agent profile found. Create one in{" "}
						<Link href="/dashboard/settings/ai" className="text-primary">
							Agent Profiles
						</Link>
						.
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex items-center gap-2">
					<BotIcon className="size-5 text-muted-foreground" />
					Stage Agent Settings
				</CardTitle>
				<CardDescription>
					Configure agent profile and concurrency per scan stage.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="mb-4 flex h-16 items-center justify-between gap-3 overflow-hidden rounded-xl border bg-muted/20 px-3">
					<div className="flex min-w-0 items-center gap-3">
						<Checkbox
							checked={allChecked || (someChecked ? "indeterminate" : false)}
							onCheckedChange={(v) => toggleAll(Boolean(v))}
							aria-label="Select all stages"
						/>
						<div className="min-w-0">
							<div className="text-sm font-medium">All stages</div>
							<div className="hidden truncate text-xs text-muted-foreground sm:block">
								Select every visible stage for batch profile edits.
							</div>
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{checkedStageNames.size > 0 ? (
							<>
								<Badge variant="secondary" className="hidden sm:inline-flex">
									{checkedStageNames.size} selected
								</Badge>
								<Button
									type="button"
									size="sm"
									aria-label={`Edit ${checkedStageNames.size} selected stages`}
									onClick={() => {
										batchForm.reset({
											agentProfileId:
												enabledProfiles[0]?.agentProfileId ?? "",
										});
										setIsBatchEditOpen(true);
									}}
								>
									<span aria-hidden="true" className="hidden sm:inline">
										Edit Selected
									</span>
									<span aria-hidden="true" className="sm:hidden">
										Edit
									</span>{" "}
									<span aria-hidden="true">({checkedStageNames.size})</span>
								</Button>
							</>
						) : (
							<Badge variant="secondary">{stages.length} stages</Badge>
						)}
					</div>
				</div>

				<div className="overflow-hidden rounded-xl border bg-card">
					{pipelineTree.map((pipeline, pipelineIndex) => {
						const expanded = expandedPipelineIds.has(pipeline.id);
						return (
							<section
								key={pipeline.id}
								className={pipelineIndex > 0 ? "border-t" : undefined}
							>
								<div className="flex h-14 items-center gap-2 px-3 transition-colors hover:bg-muted/35">
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-8 shrink-0"
										onClick={() => togglePipeline(pipeline.id)}
										aria-label={`${expanded ? "Collapse" : "Expand"} ${pipeline.name}`}
										aria-expanded={expanded}
									>
										{expanded ? (
											<ChevronDown className="size-4" />
										) : (
											<ChevronRight className="size-4" />
										)}
									</Button>
									<Checkbox
									checked={
										pipeline.selection.allChecked ||
										(pipeline.selection.someChecked
											? "indeterminate"
											: false)
									}
									onCheckedChange={(v) =>
										setCheckedStageNames((previous) =>
											toggleStageSelection(
												previous,
												pipeline.stageIds,
												Boolean(v),
											),
										)
									}
									aria-label={`Select ${pipeline.name}`}
								/>
									<button
										type="button"
										className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
										onClick={() => togglePipeline(pipeline.id)}
									>
										<span className="truncate text-sm font-semibold">
											{pipeline.name}
										</span>
										<span className="flex shrink-0 items-center gap-2">
											{pipeline.selection.checkedCount > 0 ? (
												<Badge variant="secondary">
													{pipeline.selection.checkedCount} selected
												</Badge>
											) : null}
											<Badge variant="outline">
												{pipeline.stages.length} stages
											</Badge>
										</span>
									</button>
								</div>

								{expanded ? (
									<div className="border-t bg-muted/10">
										{pipeline.stages.map((stage) => (
									<div
											key={`${pipeline.id}-${stage.stageName}`}
											className="flex min-h-16 items-center gap-3 border-t px-3 pl-12 first:border-t-0 hover:bg-muted/25"
									>
												<Checkbox
													checked={checkedStageNames.has(stage.stageName)}
													onCheckedChange={(v) =>
														toggleStage(stage.stageName, Boolean(v))
													}
													aria-label={`Select ${stage.label}`}
												/>
												<div className="min-w-0 flex-1">
													<div className="flex min-w-0 items-center gap-2">
														<span className="truncate text-sm font-medium">
														{stage.label}
														</span>
													{!stage.disableable ? (
														<Badge variant="secondary" className="shrink-0">
															Required
														</Badge>
													) : null}
													</div>
													<div className="truncate text-xs text-muted-foreground">
														{stage.stageName}
													</div>
												</div>
												<div className="hidden w-40 shrink-0 md:block">
													<div className="text-[11px] text-muted-foreground">
														Profile
													</div>
													<div className="truncate text-sm font-medium">
														{stage.agentProfileName}
													</div>
												</div>
												<div className="hidden w-24 shrink-0 sm:block">
													<div className="text-[11px] text-muted-foreground">
														Concurrency
													</div>
													<div className="text-sm font-medium">
														{stage.concurrency} / {stage.maxConcurrency}
													</div>
											</div>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="size-8 shrink-0"
												onClick={() => setSelectedStageName(stage.stageName)}
												aria-label={`Edit ${stage.label}`}
											>
												<Pencil className="size-4" />
											</Button>
									</div>
										))}
									</div>
								) : null}
							</section>
						);
					})}
				</div>

				<Dialog
					open={Boolean(selectedStage)}
					onOpenChange={(open) => {
						if (!open) {
							setSelectedStageName(null);
						}
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{selectedStage ? `Edit ${selectedStage.label}` : "Edit Stage"}
							</DialogTitle>
							<DialogDescription>
								Set the agent profile and concurrency for this stage.
							</DialogDescription>
						</DialogHeader>
						<Form {...form}>
							<form
								id="scan-stage-settings-form"
								className="grid gap-4"
								onSubmit={form.handleSubmit(async (values) => {
									if (!selectedStage || !target) {
										return;
									}
									setIsSaving(true);
									try {
										const nextScanStageSettings = {
											...(target.scanStageSettings ?? {}),
											[selectedStage.stageName]: {
												agentProfileId: values.agentProfileId,
												concurrency: values.concurrency,
											},
										};
										await onSave({
											scanStageSettings: nextScanStageSettings,
										});
										toast.success("Stage settings updated");
										setSelectedStageName(null);
									} catch {
										toast.error("Failed to update stage settings");
									} finally {
										setIsSaving(false);
									}
								})}
							>
								<FormField
									control={form.control}
									name="agentProfileId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Agent Profile</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue placeholder="Select an agent profile" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{enabledProfiles.map((profile) => (
														<SelectItem
															key={profile.agentProfileId}
															value={profile.agentProfileId}
														>
															{profile.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="concurrency"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Concurrency</FormLabel>
											<FormControl>
												<Input
													type="number"
													min={1}
													max={selectedStage?.maxConcurrency ?? 128}
													step={1}
													name={field.name}
													ref={field.ref}
													value={field.value ?? ""}
													onBlur={field.onBlur}
													onChange={(event) =>
														field.onChange(event.target.value)
													}
												/>
											</FormControl>
											<FormDescription>
												Maximum number of tasks this stage may run in parallel.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							</form>
						</Form>
						<DialogFooter>
							<Button
								type="button"
								variant="secondary"
								onClick={() => setSelectedStageName(null)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								form="scan-stage-settings-form"
								isLoading={isSaving}
							>
								Save
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				<Dialog
					open={isBatchEditOpen}
					onOpenChange={(open) => {
						if (!open) setIsBatchEditOpen(false);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								Edit {checkedStageNames.size} Stage
								{checkedStageNames.size > 1 ? "s" : ""}
							</DialogTitle>
							<DialogDescription>
								The selected agent profile will be applied to all selected
								stages. Each stage keeps its existing concurrency setting.
							</DialogDescription>
						</DialogHeader>
						<Form {...batchForm}>
							<form
								id="batch-stage-settings-form"
								onSubmit={batchForm.handleSubmit(async (values) => {
									if (!target) return;
									setIsSaving(true);
									try {
										const nextScanStageSettings = {
											...(target.scanStageSettings ?? {}),
										};
										for (const stageName of checkedStageNames) {
											nextScanStageSettings[stageName] = {
												...nextScanStageSettings[stageName],
												agentProfileId: values.agentProfileId,
											};
										}
										await onSave({ scanStageSettings: nextScanStageSettings });
										toast.success(
											`Agent profile applied to ${checkedStageNames.size} stage${checkedStageNames.size > 1 ? "s" : ""}`,
										);
										setIsBatchEditOpen(false);
										setCheckedStageNames(new Set());
									} catch {
										toast.error("Failed to update stage settings");
									} finally {
										setIsSaving(false);
									}
								})}
							>
								<FormField
									control={batchForm.control}
									name="agentProfileId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Agent Profile</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue placeholder="Select an agent profile" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{enabledProfiles.map((profile) => (
														<SelectItem
															key={profile.agentProfileId}
															value={profile.agentProfileId}
														>
															{profile.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
							</form>
						</Form>
						<DialogFooter>
							<Button
								type="button"
								variant="secondary"
								onClick={() => setIsBatchEditOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								form="batch-stage-settings-form"
								isLoading={isSaving}
							>
								Apply to {checkedStageNames.size} Stage
								{checkedStageNames.size > 1 ? "s" : ""}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</CardContent>
		</Card>
	);
};
