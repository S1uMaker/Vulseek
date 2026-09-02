import { createServerSideHelpers } from "@trpc/react-query/server";
import { validateRequest } from "@vulseek/server/lib/auth";
import {
	Activity,
	ArrowRight,
	Bot,
	Boxes,
	Folder,
	ShieldCheck,
	Zap,
} from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import Link from "next/link";
import {
	type ComponentType,
	type ReactElement,
	useEffect,
	useRef,
} from "react";
import superjson from "superjson";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipPortal,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	buildHomeHeatmapDays,
	groupHomeHeatmapWeeks,
	type HomeHeatmapDay,
} from "@/lib/scan/home-heatmap";
import { cn } from "@/lib/utils";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const numberFormatter = new Intl.NumberFormat("en-US");

const formatNumber = (value: number | null | undefined) =>
	numberFormatter.format(value || 0);

const formatTokensInMillions = (value: number | null | undefined) => {
	const tokens = value || 0;
	if (tokens === 0) {
		return "0M";
	}
	return `${new Intl.NumberFormat("en-US", {
		maximumFractionDigits: tokens >= 10_000_000 ? 1 : 2,
		minimumFractionDigits: 0,
	}).format(tokens / 1_000_000)}M`;
};

const heatmapLevelClass: Record<HomeHeatmapDay["level"], string> = {
	0: "bg-muted/45",
	1: "bg-emerald-950/45",
	2: "bg-emerald-800/65",
	3: "bg-emerald-600",
	4: "bg-emerald-300",
};

const heatmapWeekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const StatCard = (props: {
	title: string;
	value: string;
	description: string;
	icon: ComponentType<{ className?: string }>;
}) => {
	const Icon = props.icon;
	return (
		<Card className="overflow-hidden border-border/60 bg-card/80">
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<CardDescription>{props.title}</CardDescription>
				<Icon className="h-4 w-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				<div className="text-3xl font-semibold tracking-tight">
					{props.value}
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					{props.description}
				</p>
			</CardContent>
		</Card>
	);
};

const hasHeatmapActivity = (day: HomeHeatmapDay) =>
	day.totalTokens > 0 ||
	day.scanJobCount > 0 ||
	day.taskCount > 0 ||
	day.candidateCount > 0 ||
	day.securityIssueCount > 0;

const HeatmapCell = ({ day }: { day: HomeHeatmapDay }) => {
	const hasActivity = hasHeatmapActivity(day);
	const cellClassName = cn(
		"h-4 w-4 rounded-[4px] ring-1 ring-background transition-transform",
		hasActivity && "hover:scale-125 focus-visible:scale-125",
		heatmapLevelClass[day.level],
	);

	if (!hasActivity) {
		return (
			<span aria-label={`${day.date}: no activity`} className={cellClassName} />
		);
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={`${day.date}: ${formatNumber(day.totalTokens)} tokens`}
					className={cellClassName}
				/>
			</TooltipTrigger>
			<TooltipPortal>
				<TooltipContent side="top" sideOffset={8} className="w-56 space-y-2">
					<div>
						<div className="font-medium">{day.date}</div>
						<div className="text-xs text-muted-foreground">
							Daily full scan activity
						</div>
					</div>
					<div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
						<span className="text-muted-foreground">Tokens</span>
						<span className="text-right font-medium">
							{formatNumber(day.totalTokens)}
						</span>
						<span className="text-muted-foreground">Scan jobs</span>
						<span className="text-right font-medium">
							{formatNumber(day.scanJobCount)}
						</span>
						<span className="text-muted-foreground">Tasks</span>
						<span className="text-right font-medium">
							{formatNumber(day.taskCount)}
						</span>
						<span className="text-muted-foreground">Candidates</span>
						<span className="text-right font-medium">
							{formatNumber(day.candidateCount)}
						</span>
						<span className="text-muted-foreground">Security issues</span>
						<span className="text-right font-medium">
							{formatNumber(day.securityIssueCount)}
						</span>
					</div>
				</TooltipContent>
			</TooltipPortal>
		</Tooltip>
	);
};

const DashboardHome = () => {
	const { data: summary, isLoading: isSummaryLoading } =
		api.scan.homeSummary.useQuery();
	const { data: activity } = api.scan.homeActivity.useQuery({ days: 365 });
	const { data: workload } = api.scan.homeWorkload.useQuery(undefined, {
		refetchInterval: 5000,
	});
	const runningJobCount = workload?.jobCount ?? 0;
	const runningTaskCount = workload?.taskCount ?? 0;
	const runningContainerCount = workload?.containerCount ?? 0;
	const heatmapDays = buildHomeHeatmapDays({
		days: activity?.days || [],
		dayCount: 365,
	});
	const heatmapWeeks = groupHomeHeatmapWeeks(heatmapDays);
	const hasActivity = heatmapDays.some(
		(day) =>
			day.totalTokens > 0 ||
			day.scanJobCount > 0 ||
			day.taskCount > 0 ||
			day.candidateCount > 0 ||
			day.securityIssueCount > 0,
	);
	const heatmapScrollRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const container = heatmapScrollRef.current;
		if (!container || !hasActivity) return;
		container.scrollLeft = container.scrollWidth;
	}, [hasActivity, heatmapWeeks.length]);

	return (
		<TooltipProvider delayDuration={0} skipDelayDuration={0}>
			<div className="mx-auto flex w-full max-w-7xl flex-col gap-5 pb-10">
				<div className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
					<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
						<div className="min-w-0">
							<div className="mb-2 flex flex-wrap items-center gap-2">
								<h1 className="text-2xl font-semibold tracking-tight">
									Scan Overview
								</h1>
								<Badge
									variant="outline"
									className="gap-1.5 rounded-full text-xs font-normal"
								>
									<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
									Live
								</Badge>
							</div>
							<p className="text-sm text-muted-foreground">
								Organization scan activity, running jobs, and triage results.
							</p>
						</div>
						<Link
							href="/dashboard/projects"
							className="inline-flex w-fit items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
						>
							Open projects
							<ArrowRight className="h-4 w-4" />
						</Link>
					</div>
				</div>

				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
					<StatCard
						title="Projects"
						value={isSummaryLoading ? "-" : formatNumber(summary?.projectCount)}
						description="Projects in the active organization"
						icon={Folder}
					/>
					<StatCard
						title="Subjects"
						value={isSummaryLoading ? "-" : formatNumber(summary?.subjectCount)}
						description="Applications and compose targets"
						icon={Boxes}
					/>
					<StatCard
						title="Tokens"
						value={
							isSummaryLoading
								? "-"
								: formatTokensInMillions(summary?.totalTokens)
						}
						description="Total scan token pressure in millions"
						icon={Zap}
					/>
					<StatCard
						title="Security Issues"
						value={
							isSummaryLoading ? "-" : formatNumber(summary?.securityIssueCount)
						}
						description="Triage results marked as security issues"
						icon={ShieldCheck}
					/>
				</div>

				<div className="grid gap-4 lg:grid-cols-[0.9fr_1.4fr]">
					<Card className="border-border/60 bg-card/80">
						<CardHeader>
							<CardTitle>Live workload</CardTitle>
							<CardDescription>
								Lightweight snapshot of running scan activity.
							</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
							<div className="rounded-xl border bg-background/70 p-4">
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<Activity className="h-4 w-4" />
									Running jobs
								</div>
								<div className="mt-2 text-2xl font-semibold">
									{formatNumber(runningJobCount)}
								</div>
							</div>
							<div className="rounded-xl border bg-background/70 p-4">
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<Bot className="h-4 w-4" />
									Running tasks
								</div>
								<div className="mt-2 text-2xl font-semibold">
									{formatNumber(runningTaskCount)}
								</div>
							</div>
							<div className="rounded-xl border bg-background/70 p-4">
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<Boxes className="h-4 w-4" />
									Containers
								</div>
								<div className="mt-2 text-2xl font-semibold">
									{formatNumber(runningContainerCount)}
								</div>
							</div>
						</CardContent>
					</Card>

					<Card className="border-border/60 bg-card/80">
						<CardHeader>
							<CardTitle>Running jobs</CardTitle>
							<CardDescription>
								Active scan jobs with target, token, and task context.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{workload?.jobs.length ? (
								<div className="space-y-3">
									{workload.jobs.map((job) => (
										<Link
											key={job.scanJobId}
											href={job.href}
											className={cn(
												"flex flex-col gap-3 rounded-xl border p-4 transition-colors md:flex-row md:items-center md:justify-between",
												job.status === "running"
													? "border-emerald-500/35 bg-emerald-500/5 shadow-[0_0_28px_rgba(16,185,129,0.08)] hover:bg-emerald-500/10"
													: "bg-background/70 hover:bg-muted/60",
											)}
										>
											<div>
												<div className="flex flex-wrap items-center gap-2">
													<span className="font-medium">{job.title}</span>
													<Badge
														variant="secondary"
														className={cn(
															"capitalize",
															job.status === "running" &&
																"gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
														)}
													>
														{job.status === "running" ? (
															<span className="relative flex h-2 w-2">
																<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
																<span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
															</span>
														) : null}
														{job.status}
													</Badge>
												</div>
												<p className="mt-1 text-sm text-muted-foreground">
													{[job.targetKind, job.target, job.pipelineProfileName]
														.filter(Boolean)
														.join(" · ")}
												</p>
											</div>
											<div className="grid grid-cols-3 gap-3 text-right text-sm">
												<div>
													<div className="font-medium">
														{formatNumber(job.totalTokens)}
													</div>
													<div className="text-xs text-muted-foreground">
														tokens
													</div>
												</div>
												<div>
													<div className="font-medium">
														{formatNumber(job.runningTaskCount)}
													</div>
													<div className="text-xs text-muted-foreground">
														tasks
													</div>
												</div>
												<div>
													<div className="font-medium">
														{formatNumber(job.runningContainerCount)}
													</div>
													<div className="text-xs text-muted-foreground">
														containers
													</div>
												</div>
											</div>
										</Link>
									))}
								</div>
							) : (
								<div className="rounded-xl border border-dashed bg-background/60 p-8 text-center text-sm text-muted-foreground">
									No scan jobs are currently running.
								</div>
							)}
						</CardContent>
					</Card>
				</div>

				<Card className="overflow-hidden border-border/60 bg-card/80">
					<CardHeader>
						<CardTitle>Activity rhythm</CardTitle>
						<CardDescription>
							Daily scan cadence with token intensity. Hover a square for task,
							candidate, and triage counts.
						</CardDescription>
					</CardHeader>
					<CardContent>
						{hasActivity ? (
							<div ref={heatmapScrollRef} className="overflow-x-auto pb-2">
								<div className="flex min-w-max items-start gap-2">
									<div className="grid grid-rows-7 gap-1.5 pt-px text-[10px] uppercase leading-4 text-muted-foreground">
										{heatmapWeekdayLabels.map((label) => (
											<div key={label} className="h-4">
												{label}
											</div>
										))}
									</div>
									<div className="flex gap-1">
										{heatmapWeeks.map((week) => (
											<div
												key={week[0]?.date || "week"}
												className="grid grid-rows-7 gap-1.5"
											>
												{week.map((day) => (
													<HeatmapCell key={day.date} day={day} />
												))}
											</div>
										))}
									</div>
								</div>
							</div>
						) : (
							<div className="rounded-xl border border-dashed bg-background/60 p-8 text-center text-sm text-muted-foreground">
								No scan activity in the selected period yet.
							</div>
						)}
						<div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground">
							<span>Less</span>
							{([0, 1, 2, 3, 4] as const).map((level) => (
								<span
									key={level}
									className={cn(
										"h-4 w-4 rounded-[4px] ring-1 ring-background",
										heatmapLevelClass[level],
									)}
								/>
							))}
							<span>More</span>
						</div>
					</CardContent>
				</Card>
			</div>
		</TooltipProvider>
	);
};

export default DashboardHome;

DashboardHome.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { req, res } = ctx;
	const { user, session } = await validateRequest(req);
	if (!user) {
		return {
			redirect: {
				permanent: true,
				destination: "/",
			},
		};
	}

	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});

	await Promise.all([
		helpers.scan.homeSummary.prefetch(),
		helpers.scan.homeActivity.prefetch({ days: 365 }),
		helpers.user.get.prefetch(),
		helpers.settings.isCloud.prefetch(),
	]);

	return {
		props: {
			trpcState: helpers.dehydrate(),
		},
	};
}
