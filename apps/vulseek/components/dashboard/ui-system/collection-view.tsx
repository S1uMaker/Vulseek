import {
	type ColumnDef,
	type ColumnSort,
	flexRender,
	getCoreRowModel,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	ChevronLeft,
	ChevronRight,
	Filter,
	Search,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { ListQueryState } from "@/lib/ui-system/list-query";
import {
	DEFAULT_PAGE_SIZES,
	paginationRange,
	rangeLabel,
	totalPages,
} from "@/lib/ui-system/pagination-contract";
import { cn } from "@/lib/utils";
import { FilterChip } from "./entity-status";
import { EmptyState, ErrorState, LoadingState } from "./page-states";
import { RowList } from "./row-list";

/**
 * CollectionView — the single list surface for every growing collection.
 *
 * The page owns the URL state (via useCollectionQuery) and the data fetch;
 * CollectionView renders the toolbar, filters, table or grid, pagination
 * and empty/loading/error states from that state. Rows expose one primary
 * navigation anchor and one actions menu; no nested interactive cards.
 *
 * Structure:
 *   CollectionView (root)
 *     toolbar      — search left (immediate echo), filters/sort/actions right;
 *                    on mobile the search and a Filters button stay on top,
 *                    chips move into a Sheet
 *     bulk bar     — replaces the toolbar in place when rows are selected
 *     table/grid   — desktop table, <640px cards via `mobileRender`
 *     pagination   — x–y of total, page size, prev/next, numbered pages
 *     states       — .Empty / .Loading / .Error built in
 */

export type CollectionFilter = {
	key: string;
	label: string;
	options: readonly { value: string; label: string }[];
};

export type CollectionViewProps<T> = {
	state: ListQueryState;
	onStateChange: (
		updater: (previous: ListQueryState) => ListQueryState,
	) => void;
	/** Table columns; unused in row/card modes. */
	columns?: ColumnDef<T, unknown>[];
	/** Page size choices for the pagination select. */
	pageSizes?: readonly number[];
	data?: { items: T[]; total: number };
	isLoading?: boolean;
	/** Background refetch in flight (polling) — dims the table, keeps rows. */
	isRefreshing?: boolean;
	isError?: boolean;
	onRetry?: () => void;
	getRowId: (item: T) => string;
	/** Accessible row name used in checkbox labels. */
	getRowLabel?: (item: T) => string;
	/** Immediate-echo search value (the hook's pending input). */
	searchValue?: string;
	onSearchValueChange?: (value: string) => void;
	/** Extra toolbar controls (e.g. sort select, view toggle). */
	toolbarChildren?: React.ReactNode;
	/** Filters rendered as chips (desktop) / Sheet (mobile). */
	filters?: readonly CollectionFilter[];
	/** Bulk action bar content; shown when rows are selected. */
	bulkActions?: React.ReactNode;
	selectedIds?: ReadonlySet<string>;
	onToggleRow?: (id: string) => void;
	/**
	 * Header select-all toggle. `allSelected` reflects whether the page was
	 * fully selected before the click, so the caller can branch on it:
	 * true -> clear the page, false -> select every page id.
	 */
	onTogglePage?: (pageIds: string[], allSelected: boolean) => void;
	onClearSelection?: () => void;
	/**
	 * Rows where this returns false get a disabled checkbox and are excluded
	 * from the header select-all, e.g. items that cannot take the bulk action.
	 */
	getRowSelectable?: (item: T) => boolean;
	searchPlaceholder?: string;
	emptyTitle?: string;
	emptyDescription?: React.ReactNode;
	/** Card renderer for <640px screens; the table is hidden on mobile then. */
	mobileRender?: (item: T) => React.ReactNode;
	/**
	 * Card grid mode: when provided, items render as a responsive card grid
	 * instead of the table. Same toolbar/filters/pagination controller.
	 */
	renderCard?: (item: T) => React.ReactNode;
	/** Override the default card grid columns/gap (projects want larger 2-col cards). */
	cardGridClassName?: string;
	/** Additional class names for desktop table cells. */
	tableCellClassName?: string;
	/**
	 * Full-width single-column rows. Use this for growing operational lists
	 * where every item should occupy one horizontal row.
	 */
	renderRow?: (item: T) => React.ReactNode;
	/** Optional column labels for full-width row lists. */
	rowHeader?: React.ReactNode;
	onRowClick?: (item: T) => void;
	className?: string;
};

const INTERACTIVE_SELECTOR =
	"a,button,input,select,textarea,label,[role='button']";

const CollectionView = <T,>({
	state,
	onStateChange,
	columns = [],
	pageSizes = DEFAULT_PAGE_SIZES,
	data,
	isLoading = false,
	isRefreshing = false,
	isError = false,
	onRetry,
	getRowId,
	getRowLabel,
	searchValue,
	onSearchValueChange,
	toolbarChildren,
	filters,
	bulkActions,
	selectedIds,
	onToggleRow,
	onTogglePage,
	onClearSelection,
	getRowSelectable,
	searchPlaceholder = "Search…",
	emptyTitle = "Nothing here yet",
	emptyDescription,
	mobileRender,
	renderCard,
	cardGridClassName,
	tableCellClassName,
	renderRow,
	rowHeader,
	onRowClick,
	className,
}: CollectionViewProps<T>) => {
	const items = data?.items ?? [];
	const total = data?.total ?? 0;
	const pageCount = totalPages(total, state.pageSize);
	let ellipsisIndex = 0;
	const selectedCount = selectedIds?.size ?? 0;
	const showBulkBar = selectedCount > 0 && bulkActions;
	// Select-all only covers rows that can actually be selected.
	const selectableItems = getRowSelectable
		? items.filter((item) => getRowSelectable(item))
		: items;
	const selectablePageIds = selectableItems.map((item) => getRowId(item));
	const selectedOnPage = selectablePageIds.filter((id) =>
		selectedIds?.has(id),
	).length;
	const pageSelected =
		selectablePageIds.length > 0 && selectedOnPage === selectablePageIds.length;
	const pageIndeterminate = selectedOnPage > 0 && !pageSelected;

	const selectionColumn: ColumnDef<T, unknown> | undefined = onToggleRow
		? {
				id: "__select__",
				enableSorting: false,
				size: 40,
				header: onTogglePage
					? () => (
							<Checkbox
								aria-label={
									pageSelected
										? "Clear all selected rows"
										: "Select all rows on this page"
								}
								checked={
									pageSelected
										? true
										: pageIndeterminate
											? "indeterminate"
											: false
								}
								disabled={selectablePageIds.length === 0}
								onCheckedChange={() =>
									onTogglePage(selectablePageIds, pageSelected)
								}
							/>
						)
					: undefined,
				cell: ({ row }) => (
					<Checkbox
						aria-label={`Select ${getRowLabel?.(row.original) ?? row.id}`}
						checked={selectedIds?.has(row.id) ?? false}
						disabled={
							getRowSelectable ? !getRowSelectable(row.original) : false
						}
						onCheckedChange={() => onToggleRow(row.id)}
					/>
				),
			}
		: undefined;
	const resolvedColumns = selectionColumn
		? [selectionColumn, ...columns]
		: columns;

	const sorting: SortingState = state.sortKey
		? [{ id: state.sortKey, desc: state.sortDirection === "desc" }]
		: [];
	const table = useReactTable({
		data: items,
		columns: resolvedColumns,
		getRowId: (row) => getRowId(row),
		state: {
			sorting,
			pagination: { pageIndex: state.page - 1, pageSize: state.pageSize },
		},
		manualSorting: true,
		manualPagination: true,
		pageCount,
		onSortingChange: (updater) => {
			const next: SortingState =
				typeof updater === "function" ? updater(sorting) : updater;
			const sort = next[0] as ColumnSort | undefined;
			if (!sort) return;
			onStateChange((previous) => ({
				...previous,
				sortKey: sort.id,
				sortDirection: sort.desc ? "desc" : "asc",
				page: 1,
			}));
		},
		getCoreRowModel: getCoreRowModel(),
	});

	return (
		<div className={cn("flex min-w-0 flex-col gap-6", className)}>
			{showBulkBar ? (
				<div
					className="flex h-10 items-center justify-between gap-2 rounded-lg border bg-primary/5 px-3"
					aria-live="polite"
				>
					<span className="truncate text-sm font-medium">
						{selectedCount} selected
					</span>
					<div className="flex shrink-0 items-center gap-1.5">
						{bulkActions}
						{onClearSelection && (
							<Button variant="ghost" size="xs" onClick={onClearSelection}>
								Clear
							</Button>
						)}
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					{onSearchValueChange && (
						<div className="relative w-full sm:max-w-sm">
							<Search
								aria-hidden
								className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								value={searchValue}
								onChange={(event) => onSearchValueChange(event.target.value)}
								placeholder={searchPlaceholder}
								className="h-10 pl-9 pr-3"
								aria-label={searchPlaceholder}
							/>
						</div>
					)}
					<div className="flex items-center gap-4">
						{filters && filters.length > 0 && (
							<MobileFilters
								filters={filters}
								state={state}
								onStateChange={onStateChange}
							/>
						)}
						{toolbarChildren}
					</div>
				</div>
			)}

			{filters && filters.length > 0 && (
				<div className="hidden flex-wrap items-center gap-1.5 sm:flex">
					{filters.map((filter) => (
						<React.Fragment key={filter.key}>
							{filter.options.map((option) => {
								const values = state.filters[filter.key] ?? [];
								const selected = values.includes(option.value);
								return (
									<FilterChip
										key={option.value}
										label={option.label}
										selected={selected}
										onToggle={() => {
											const nextValues = selected
												? values.filter((value) => value !== option.value)
												: [...values, option.value];
											onStateChange((previous) => ({
												...previous,
												filters: {
													...previous.filters,
													[filter.key]: nextValues,
												},
												page: 1,
											}));
										}}
									/>
								);
							})}
						</React.Fragment>
					))}
				</div>
			)}

			{isError ? (
				<ErrorState onRetry={onRetry} />
			) : isLoading ? (
				<LoadingState rows={Math.min(state.pageSize, 8)} />
			) : items.length === 0 ? (
				<EmptyState
					title={emptyTitle}
					description={emptyDescription}
					icon={Search}
				/>
			) : renderRow ? (
				<div className="flex min-w-0 flex-col gap-2">
					{rowHeader}
					<RowList
						className={cn(isRefreshing && "opacity-60 transition-opacity")}
					>
						{items.map((item) => (
							<React.Fragment key={getRowId(item)}>
								{renderRow(item)}
							</React.Fragment>
						))}
					</RowList>
				</div>
			) : renderCard ? (
				<div
					className={cn(
						"grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5",
						cardGridClassName,
					)}
				>
					{items.map((item) => (
						<React.Fragment key={getRowId(item)}>
							{renderCard(item)}
						</React.Fragment>
					))}
				</div>
			) : (
				<>
					<div
						className={cn(
							"min-w-0 max-w-full overflow-hidden rounded-xl border",
							mobileRender ? "hidden md:block" : "block",
							isRefreshing && "opacity-60 transition-opacity",
						)}
					>
						<Table>
							<TableHeader>
								{table.getHeaderGroups().map((headerGroup) => (
									<TableRow
										key={headerGroup.id}
										className="hover:bg-transparent"
									>
										{headerGroup.headers.map((header) => {
											const sortable = header.column.getCanSort();
											const sorted = header.column.getIsSorted();
											const onClick = header.column.getToggleSortingHandler();
											return (
												<TableHead
													key={header.id}
													aria-sort={
														sorted === "asc"
															? "ascending"
															: sorted === "desc"
																? "descending"
																: undefined
													}
												>
													{header.isPlaceholder ? null : (
														<div className="flex items-center gap-1.5">
															{flexRender(
																header.column.columnDef.header,
																header.getContext(),
															)}
															{sortable && (
																<Button
																	variant="ghost"
																	size="xs"
																	className="size-7 rounded-md px-0"
																	onClick={onClick}
																	aria-label={`Sort by ${header.column.id}`}
																>
																	{sorted === "asc" ? (
																		<ArrowUp className="size-3.5" />
																	) : sorted === "desc" ? (
																		<ArrowDown className="size-3.5" />
																	) : (
																		<ArrowUpDown className="size-3.5 text-muted-foreground" />
																	)}
																</Button>
															)}
														</div>
													)}
												</TableHead>
											);
										})}
									</TableRow>
								))}
							</TableHeader>
							<TableBody>
								{table.getRowModel().rows.map((row) => (
									<TableRow
										key={row.id}
										className={cn(
											onRowClick && "cursor-pointer",
											selectedIds?.has(row.id) &&
												"bg-primary/5 hover:bg-primary/10",
										)}
										onClick={
											onRowClick
												? (event) => {
														// Rows may embed one primary anchor and a selection
														// checkbox; don't double-fire on those.
														if (
															(event.target as HTMLElement).closest(
																INTERACTIVE_SELECTOR,
															)
														) {
															return;
														}
														onRowClick(row.original);
													}
												: undefined
										}
									>
									{row.getVisibleCells().map((cell) => (
										<TableCell key={cell.id} className={tableCellClassName}>
											{flexRender(
													cell.column.columnDef.cell,
													cell.getContext(),
												)}
											</TableCell>
										))}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>

					{mobileRender && (
						<div className="flex flex-col gap-4 md:hidden">
							{items.map((item) => (
								<React.Fragment key={getRowId(item)}>
									{mobileRender(item)}
								</React.Fragment>
							))}
						</div>
					)}
				</>
			)}

			{!isLoading && !isError && total > 0 && (
				<div className="-mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
					<span className="text-xs text-muted-foreground">
						{rangeLabel(state.page, state.pageSize, total)}
					</span>
					<div className="flex items-center justify-between gap-2 sm:justify-end">
						<Select
							value={String(state.pageSize)}
							onValueChange={(value) =>
								onStateChange((previous) => ({
									...previous,
									pageSize: Number(value),
									page: 1,
								}))
							}
						>
							<SelectTrigger className="h-8 w-[72px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{pageSizes.map((size) => (
									<SelectItem key={size} value={String(size)}>
										{size}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							variant="outline"
							size="icon"
							className="size-8"
							disabled={state.page <= 1}
							onClick={() =>
								onStateChange((previous) => ({
									...previous,
									page: previous.page - 1,
								}))
							}
							aria-label="Previous page"
						>
							<ChevronLeft className="size-4" />
						</Button>
						{paginationRange(state.page, pageCount).map((page) =>
							page === -1 ? (
								<span
									key={`ellipsis-${ellipsisIndex++}`}
									aria-hidden
									className="px-1 text-xs text-muted-foreground"
								>
									…
								</span>
							) : (
								<Button
									key={page}
									variant={page === state.page ? "default" : "outline"}
									size="icon"
									className="size-8"
									aria-label={`Page ${page}`}
									aria-current={page === state.page ? "page" : undefined}
									onClick={() =>
										onStateChange((previous) => ({ ...previous, page }))
									}
								>
									{page}
								</Button>
							),
						)}
						<Button
							variant="outline"
							size="icon"
							className="size-8"
							disabled={state.page >= pageCount}
							onClick={() =>
								onStateChange((previous) => ({
									...previous,
									page: previous.page + 1,
								}))
							}
							aria-label="Next page"
						>
							<ChevronRight className="size-4" />
						</Button>
					</div>
				</div>
			)}
		</div>
	);
};

const MobileFilters = <T,>({
	filters,
	state,
	onStateChange,
}: {
	filters: readonly CollectionFilter[];
	state: ListQueryState;
	onStateChange: CollectionViewProps<T>["onStateChange"];
}) => {
	const [open, setOpen] = React.useState(false);
	return (
		<>
			<Button
				variant="outline"
				size="sm"
				className="h-9 sm:hidden"
				onClick={() => setOpen(true)}
			>
				<Filter className="size-4" />
				Filters
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent className="w-full overflow-y-auto sm:max-w-sm">
					<SheetHeader>
						<SheetTitle>Filters</SheetTitle>
					</SheetHeader>
					<div className="flex flex-col gap-4 px-5 py-4">
						{filters.map((filter) => (
							<div key={filter.key}>
								<h4 className="mb-2 text-sm font-medium">{filter.label}</h4>
								<div className="flex flex-wrap gap-1.5">
									{filter.options.map((option) => {
										const values = state.filters[filter.key] ?? [];
										const selected = values.includes(option.value);
										return (
											<FilterChip
												key={option.value}
												label={option.label}
												selected={selected}
												onToggle={() => {
													const nextValues = selected
														? values.filter((value) => value !== option.value)
														: [...values, option.value];
													onStateChange((previous) => ({
														...previous,
														filters: {
															...previous.filters,
															[filter.key]: nextValues,
														},
														page: 1,
													}));
												}}
											/>
										);
									})}
								</div>
							</div>
						))}
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
};

export { CollectionView };
