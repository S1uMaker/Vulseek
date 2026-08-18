import { Database } from "lucide-react";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { CreateDatasetDialog } from "@/components/dashboard/datasets/create-dataset-dialog";
import {
	CollectionView,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	ResourceCard,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import type { ListQueryConfig } from "@/lib/ui-system/list-query";
import { api } from "@/utils/api";

const DATASETS_LIST_CONFIG: ListQueryConfig = {
	prefix: "datasets",
	sortOptions: [
		{ value: "name", label: "Name" },
		{ value: "updatedAt", label: "Updated" },
	],
	filterKeys: [],
	defaultSortKey: "updatedAt",
	defaultSortDirection: "desc",
	defaultPageSize: 12,
	pageSizes: [12, 24, 48],
};

const DatasetsPage = () => {
	const router = useRouter();
	const { data: auth } = api.user.get.useQuery();
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, DATASETS_LIST_CONFIG);

	const list = api.dataset.list.useQuery(
		{
			page: state.page,
			pageSize: state.pageSize,
			search: deferredQuery || undefined,
			sortKey: (state.sortKey || "updatedAt") as "name" | "updatedAt",
			sortDirection: state.sortDirection,
		},
		{ keepPreviousData: true },
	);

	const canCreate = auth?.role === "owner" || auth?.role === "admin";

	return (
		<>
			<BreadcrumbSidebar
				list={[{ name: "Datasets", href: "/dashboard/datasets" }]}
			/>
			<DashboardPage>
				<DashboardPageHeader
					icon={<Database />}
					title="Datasets"
					description="Evaluate scan pipelines against reproducible sample collections."
					actions={canCreate ? <CreateDatasetDialog /> : undefined}
				/>
				<DashboardPageBody>
					<CollectionView
						state={state}
						onStateChange={setState}
						data={{
							items: list.data?.items ?? [],
							total: list.data?.total ?? 0,
						}}
						isLoading={list.isLoading && !list.data}
						isRefreshing={list.isFetching && Boolean(list.data)}
						getRowId={(dataset) => dataset.datasetId}
						getRowLabel={(dataset) => dataset.name}
						searchValue={searchInput}
						onSearchValueChange={setSearchInput}
						searchPlaceholder="Filter datasets..."
						emptyTitle="No datasets yet"
						emptyDescription="Create a dataset to prepare reproducible sample collections."
						renderCard={(dataset) => (
							<ResourceCard
								key={dataset.datasetId}
								href={`/dashboard/datasets/${dataset.datasetId}`}
								title={dataset.name}
								description={dataset.description || "No description"}
								icon={<Database />}
								footer={
									<div className="flex w-full items-center justify-end text-xs text-muted-foreground">
										<span className="text-foreground/80">
											{dataset.evaluationCount}{" "}
											{dataset.evaluationCount === 1
												? "evaluation"
												: "evaluations"}
										</span>
									</div>
								}
							/>
						)}
					/>
				</DashboardPageBody>
			</DashboardPage>
		</>
	);
};

DatasetsPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
export default DatasetsPage;
