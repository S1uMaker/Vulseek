import { AlertTriangle, Play } from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import * as React from "react";
import { toast } from "sonner";
import { scanT } from "@/components/dashboard/scanning/scan-i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { buildRunPipelineImageWarnings } from "./run-pipeline-image-warnings";

/**
 * Unified "Run pipeline" entry: replaces the four hardcoded scanType dialogs
 * on application/compose pages, and doubles as the run entry from the
 * pipeline pages.
 *
 * With a `target` prop the dialog runs against that application/compose.
 * Without one (pipeline pages) it shows a project → application picker; the
 * selection only chooses where the scan runs and where the job detail page
 * lives — the pipeline and version are resolved exactly the same way.
 *
 * Defaults to `defaultPipelineId`'s current version; the advanced section can
 * pick a historical version for this run only.
 */

const stripGroupedDigits = (value: string) => value.replace(/,/g, "");

const formatUsGroupedInteger = (value: string) => {
	const digits = stripGroupedDigits(value).replace(/\D/g, "");
	if (!digits) return "";
	const normalized = digits.replace(/^0+(?=\d)/, "");
	return new Intl.NumberFormat("en-US").format(Number(normalized));
};

export type RunPipelineDialogTarget =
	| { type: "application"; applicationId: string }
	| { type: "compose"; composeId: string };

type ApplicationOption = {
	projectId: string;
	projectName: string;
	environmentId: string;
	applicationId: string;
	name: string;
};

export type RunPipelineDialogProps = {
	target?: RunPipelineDialogTarget;
	defaultPipelineId?: string | null;
	triggerClassName?: string;
};

export const RunPipelineDialog = ({
	target,
	defaultPipelineId,
	triggerClassName,
}: RunPipelineDialogProps) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const options = api.pipeline.publishedOptions.useQuery({
		targetType: "project",
	});
	const run = api.pipeline.run.useMutation();
	const [open, setOpen] = React.useState(false);
	const projects = api.project.all.useQuery(undefined, {
		enabled: open && !target,
	});
	const [selectedApplicationId, setSelectedApplicationId] = React.useState("");
	const [pipelineId, setPipelineId] = React.useState<string>("");
	const [versionId, setVersionId] = React.useState<string>("");
	const [profileId, setProfileId] = React.useState<string>("");
	const [targetRef, setTargetRef] = React.useState("");
	const [targetTag, setTargetTag] = React.useState("");
	const [tokenBudget, setTokenBudget] = React.useState("");
	const [timeBudgetSeconds, setTimeBudgetSeconds] = React.useState("");

	const applicationOptions = React.useMemo<ApplicationOption[]>(() => {
		if (target) return [];
		return (projects.data ?? []).flatMap((project) =>
			(project.environments ?? []).flatMap((environment) =>
				(environment.applications ?? []).map((application) => ({
					projectId: project.projectId,
					projectName: project.name,
					environmentId: environment.environmentId,
					applicationId: application.applicationId,
					name: application.name || application.appName,
				})),
			),
		);
	}, [projects.data, target]);

	const selectedApplication = target
		? null
		: (applicationOptions.find(
				(option) => option.applicationId === selectedApplicationId,
			) ?? null);

	// With a target prop we run against it directly; otherwise the picked
	// application becomes the target. All downstream behavior is identical.
	const effectiveTarget: RunPipelineDialogTarget | null = target
		? target
		: selectedApplication
			? {
					type: "application",
					applicationId: selectedApplication.applicationId,
				}
			: null;

	const checkoutTarget = effectiveTarget
		? effectiveTarget.type === "application"
			? { applicationId: effectiveTarget.applicationId }
			: { composeId: effectiveTarget.composeId }
		: { applicationId: "__none__" };

	const versions = api.pipeline.listVersions.useQuery(
		{ pipelineId: pipelineId || "__none__" },
		{ enabled: Boolean(pipelineId) },
	);
	const profiles = api.pipeline.profilesList.useQuery(
		{ pipelineId: pipelineId || "__none__" },
		{ enabled: Boolean(pipelineId) },
	);
	const toolsStatus = api.scan.checkoutToolsStatus.useQuery(undefined, {
		enabled: open,
		refetchInterval: (data) => (data?.state === "building" ? 1800 : false),
	});
	const checkoutImageStatus = api.scan.checkoutImageStatus.useQuery(
		checkoutTarget,
		{ enabled: open && Boolean(effectiveTarget) },
	);

	// Default to the preferred pipeline's current version when the dialog opens.
	React.useEffect(() => {
		if (!open) return;
		const preferred =
			pipelineId ||
			(defaultPipelineId &&
			options.data?.some((o) => o.pipelineId === defaultPipelineId)
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
		if (profiles.data.length === 0) {
			setProfileId("");
			return;
		}
		if (!profiles.data.some((item) => item.pipelineProfileId === profileId)) {
			setProfileId(profiles.data[0]!.pipelineProfileId);
		}
	}, [profileId, profiles.data]);

	const selectedVersion = versions.data?.find(
		(v) => v.pipelineVersionId === versionId,
	);
	const canRun = Boolean(
		pipelineId && versionId && effectiveTarget && !run.isLoading,
	);
	const imageWarnings = buildRunPipelineImageWarnings({
		tools: toolsStatus.data,
		checkout: checkoutImageStatus.data,
		loading: toolsStatus.isLoading || checkoutImageStatus.isLoading,
	});

	const parseOptionalPositiveInt = (value: string) => {
		const trimmed = stripGroupedDigits(value).trim();
		if (!trimmed) return undefined;
		if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
		const parsed = Number(trimmed);
		return Number.isSafeInteger(parsed) ? parsed : null;
	};

	const submit = async () => {
		if (!canRun || !effectiveTarget) return;
		const parsedTokenBudgetK = parseOptionalPositiveInt(tokenBudget);
		const parsedTimeBudget = parseOptionalPositiveInt(timeBudgetSeconds);
		const parsedTokenBudget =
			parsedTokenBudgetK == null
				? parsedTokenBudgetK
				: parsedTokenBudgetK * 1000;
		if (
			tokenBudget.trim() &&
			(parsedTokenBudgetK == null ||
				parsedTokenBudget == null ||
				!Number.isSafeInteger(parsedTokenBudget))
		) {
			toast.error(
				scanT(
					t,
					"scan.dialog.invalidTokenBudget",
					"Token budget must be a positive integer in K",
				),
			);
			return;
		}
		if (timeBudgetSeconds.trim() && parsedTimeBudget == null) {
			toast.error(
				scanT(
					t,
					"scan.dialog.invalidTimeBudget",
					"Time budget must be a positive number of seconds",
				),
			);
			return;
		}
		if (parsedTimeBudget != null && parsedTimeBudget > 30 * 24 * 60 * 60) {
			toast.error(
				scanT(
					t,
					"scan.dialog.invalidTimeBudget",
					"Time budget must be a positive number of seconds",
				),
			);
			return;
		}
		try {
			const scanJob = await run.mutateAsync({
				target: effectiveTarget,
				pipelineId,
				pipelineVersionId: versionId || undefined,
				pipelineProfileId: profileId || undefined,
				repository: {
					targetRef: targetRef || undefined,
					targetTag: targetTag || undefined,
				},
				tokenBudget: parsedTokenBudget,
				timeBudgetSeconds: parsedTimeBudget,
			});
			toast.success(scanT(t, "scan.dialog.scanStarted", "Scan started"));
			setTokenBudget("");
			setTimeBudgetSeconds("");
			setOpen(false);
			const scanJobId = encodeURIComponent(scanJob!.scanJobId);
			if (target) {
				// Mounted on an application/compose page: the job detail lives
				// right below the current path.
				const currentPath = (
					router.asPath.split(/[?#]/, 1)[0] ?? router.asPath
				).replace(/\/$/, "");
				await router.push(`${currentPath}/jobs/${scanJobId}`);
				return;
			}
			if (!selectedApplication) return;
			await router.push(
				`/dashboard/project/${selectedApplication.projectId}/environment/${selectedApplication.environmentId}/services/application/${selectedApplication.applicationId}/jobs/${scanJobId}`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to start scan",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button className={triggerClassName}>
					<Play className="size-4" />
					{scanT(t, "scan.dialog.runTrigger", "Run pipeline")}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{scanT(t, "scan.dialog.title", "Run pipeline")}
					</DialogTitle>
					<DialogDescription>
						Runs a published pipeline version against this target. Choosing a
						runtime profile applies its stage settings to this scan only.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{imageWarnings.length > 0 ? (
						<Alert className="border-amber-500/50 text-amber-950 dark:text-amber-100 [&>svg]:text-amber-600">
							<AlertTriangle className="size-4" />
							<AlertTitle>
								{scanT(
									t,
									"scan.dialog.imageWarningTitle",
									"Scan images need attention",
								)}
							</AlertTitle>
							<AlertDescription>
								<ul className="mt-2 list-disc space-y-1 pl-4">
									{imageWarnings.map((warning) => (
										<li key={warning.id}>
											{scanT(
												t,
												warning.key,
												warning.defaultValue,
												warning.values,
											)}
										</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					) : null}
					{!target ? (
						<div className="space-y-1">
							<Label>{scanT(t, "scan.dialog.projectLabel", "Project")}</Label>
							<Select
								value={selectedApplication?.projectId ?? ""}
								onValueChange={(value) => {
									const first = applicationOptions.find(
										(option) => option.projectId === value,
									);
									setSelectedApplicationId(first?.applicationId ?? "");
								}}
							>
								<SelectTrigger className="h-9">
									<SelectValue placeholder="Choose a project…" />
								</SelectTrigger>
								<SelectContent>
									{(projects.data ?? [])
										.filter((project) =>
											(project.environments ?? []).some(
												(environment) =>
													(environment.applications ?? []).length > 0,
											),
										)
										.map((project) => (
											<SelectItem
												key={project.projectId}
												value={project.projectId}
											>
												{project.name}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</div>
					) : null}
					{!target ? (
						<div className="space-y-1">
							<Label>
								{scanT(t, "scan.dialog.applicationLabel", "Application")}
							</Label>
							<Select
								value={selectedApplicationId}
								onValueChange={setSelectedApplicationId}
							>
								<SelectTrigger className="h-9">
									<SelectValue placeholder="Choose an application…" />
								</SelectTrigger>
								<SelectContent>
									{applicationOptions.map((option) => (
										<SelectItem
											key={option.applicationId}
											value={option.applicationId}
										>
											{option.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{projects.isSuccess && applicationOptions.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									{scanT(
										t,
										"scan.dialog.noApplications",
										"No applications found. Create an application first.",
									)}
								</p>
							) : null}
						</div>
					) : null}
					<div className="space-y-1">
						<Label>{scanT(t, "scan.dialog.pipelineLabel", "Pipeline")}</Label>
						<Select
							value={pipelineId}
							onValueChange={(value) => {
								setPipelineId(value);
								const current = options.data?.find(
									(o) => o.pipelineId === value,
								)?.currentVersionId;
								setVersionId(current ?? "");
								setProfileId("");
							}}
						>
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
						<Label>
							{scanT(t, "scan.dialog.runtimeProfileLabel", "Runtime profile")}
						</Label>
						<Select
							value={profileId}
							onValueChange={setProfileId}
							disabled={!pipelineId}
						>
							<SelectTrigger className="h-9">
								<SelectValue placeholder="Select a runtime profile" />
							</SelectTrigger>
							<SelectContent>
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
									? "Applies this runtime profile's model, concurrency, and stage switches to the run."
									: "No runtime profiles for this pipeline. The run uses YAML defaults."}
						</p>
					</div>

					<div className="space-y-1">
						<Label>
							{scanT(
								t,
								"scan.dialog.versionLabel",
								"Version (advanced — this run only)",
							)}
						</Label>
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
										v{version.versionNumber}
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
							<Label>{scanT(t, "scan.dialog.ref", "Ref")}</Label>
							<Input
								value={targetRef}
								onChange={(event) => setTargetRef(event.target.value)}
								placeholder="main"
							/>
						</div>
						<div className="space-y-1">
							<Label>{scanT(t, "scan.dialog.tag", "Tag")}</Label>
							<Input
								value={targetTag}
								onChange={(event) => setTargetTag(event.target.value)}
								placeholder="latest"
							/>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<Label htmlFor="run-pipeline-token-budget">
								{scanT(t, "scan.dialog.tokenBudget", "Token usage budget (K)")}
							</Label>
							<div className="relative">
								<Input
									id="run-pipeline-token-budget"
									type="text"
									inputMode="numeric"
									autoComplete="off"
									className="pr-8"
									value={tokenBudget}
									onChange={(event) =>
										setTokenBudget(formatUsGroupedInteger(event.target.value))
									}
									placeholder={scanT(
										t,
										"scan.dialog.budgetUnlimited",
										"Unlimited",
									)}
								/>
								<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
									K
								</span>
							</div>
						</div>
						<div className="space-y-1">
							<Label htmlFor="run-pipeline-time-budget">
								{scanT(t, "scan.dialog.timeBudget", "Time budget (seconds)")}
							</Label>
							<Input
								id="run-pipeline-time-budget"
								type="number"
								min={1}
								max={30 * 24 * 60 * 60}
								step={1}
								value={timeBudgetSeconds}
								onChange={(event) => setTimeBudgetSeconds(event.target.value)}
								placeholder={scanT(
									t,
									"scan.dialog.budgetUnlimited",
									"Unlimited",
								)}
							/>
						</div>
					</div>
					<p className="text-xs text-muted-foreground">
						{scanT(
							t,
							"scan.dialog.budgetHint",
							"Leave empty for no limit. Token budget is in K (thousands). Exceeding either budget cancels the job.",
						)}
					</p>
				</div>

				<DialogFooter>
					<Button onClick={() => void submit()} disabled={!canRun}>
						{run.isLoading
							? scanT(t, "scan.dialog.starting", "Starting…")
							: scanT(t, "scan.dialog.startScan", "Start scan")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
