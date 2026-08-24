import type { GetServerSidePropsContext, InferGetServerSidePropsType } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import * as React from "react";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { Plus, Workflow } from "lucide-react";
import superjson from "superjson";
import { validateRequest } from "@vulseek/server/lib/auth";
import {
	CollectionSection,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	FilterChip,
	ResourceCard,
} from "@/components/dashboard/ui-system";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { appRouter } from "@/server/api/root";

const PIPELINE_FILTERS = [
	{ value: "archived", label: "Archived" },
] as const;

export const getServerSideProps = async (
	context: GetServerSidePropsContext,
) => {
	const { user, session } = await validateRequest(context.req);
	if (!user || !session) {
		return { redirect: { destination: "/login", permanent: false } };
	}
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			session,
			user,
			req: context.req,
			res: context.res,
			db: undefined,
		} as never,
		transformer: superjson,
	});
	await helpers.pipeline.list.prefetch();
	return {
		props: {
			trpcState: helpers.dehydrate(),
		},
	};
};

const statusBadge = (
	row: { archivedAt: string | null; hasDraft?: boolean },
) => {
	if (row.archivedAt) {
		return (
			<Badge variant="secondary" className="shrink-0">
				Archived
			</Badge>
		);
	}
	if (row.hasDraft) {
		return (
			<Badge variant="outline" className="shrink-0 border-amber-500/40 text-amber-600">
				Draft
			</Badge>
		);
	}
	return null;
};

const PipelinesPage = ({
	trpcState,
}: InferGetServerSidePropsType<typeof getServerSideProps>) => {
	void trpcState;
	const router = useRouter();
	const list = api.pipeline.list.useQuery(undefined, {
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
	const [activeFilters, setActiveFilters] = React.useState<string[]>([]);

	const rows = list.data ?? [];
	const filtered = rows.filter((row) => {
		if (activeFilters.length === 0) return true;
		return activeFilters.some((filter) =>
			filter === "archived" ? Boolean(row.archivedAt) : false,
		);
	});

	const toggleFilter = (value: string) => {
		setActiveFilters((previous) =>
			previous.includes(value)
				? previous.filter((item) => item !== value)
				: [...previous, value],
		);
	};

	return (
		<DashboardLayout hideBreadcrumb>
			<BreadcrumbSidebar list={[{ name: "Pipelines", href: "/dashboard/pipelines" }]} />
			<DashboardPage>
				<DashboardPageHeader
					icon={<Workflow />}
					title="Pipelines"
					description="Organization-wide scan pipelines"
					actions={
						<Button onClick={() => void router.push("/dashboard/pipelines/new")}>
							<Plus className="size-4" />
							New pipeline
						</Button>
					}
				/>
				<DashboardPageBody>
					<div
						className="mb-4 flex flex-wrap items-center gap-1.5"
						role="group"
						aria-label="Pipeline filters"
					>
						{PIPELINE_FILTERS.map((filter) => (
							<FilterChip
								key={filter.value}
								label={filter.label}
								selected={activeFilters.includes(filter.value)}
								onToggle={() => toggleFilter(filter.value)}
							/>
						))}
					</div>

					<CollectionSection
						title="All pipelines"
						description={
							filtered.length > 0
								? `${filtered.length} pipeline${filtered.length === 1 ? "" : "s"} in this organization`
								: rows.length === 0
									? "No pipelines yet"
									: "No pipelines match these filters"
						}
					>
						{filtered.length === 0 ? (
							<div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
								{rows.length === 0
									? "No pipelines yet — create your first one."
									: "No pipelines match these filters."}
							</div>
						) : (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
								{filtered.map((row) => (
									<ResourceCard
										key={row.pipelineId}
										href={`/dashboard/pipelines/${row.pipelineId}`}
										title={row.name}
										description={row.slug}
										metadata={statusBadge(row)}
										metadataPlacement="top-right"
										footer={
											<span className="text-xs text-muted-foreground">
												{row.currentVersionNumber
													? `v${row.currentVersionNumber} published`
													: "No published version"}
											</span>
										}
									/>
								))}
							</div>
						)}
					</CollectionSection>

					<p className="mt-6 text-xs text-muted-foreground">
						Pipelines are shared across all projects. Drafts are only visible to
						owners and admins; published versions can be run by every member.{" "}
						<Link
							href="/dashboard/pipelines/new"
							className="text-primary hover:underline"
						>
							Create
						</Link>{" "}
						a pipeline or duplicate an existing one to get started.
					</p>
				</DashboardPageBody>
			</DashboardPage>
		</DashboardLayout>
	);
};

export default PipelinesPage;
