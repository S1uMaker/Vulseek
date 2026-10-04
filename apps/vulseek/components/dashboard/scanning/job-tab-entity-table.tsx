import type { PipelineJobTab } from "@vulseek/server/services/scan/pipeline/document-v3";
import { Loader2, Search } from "lucide-react";
import { useRouter } from "next/router";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { api } from "@/utils/api";

export const JobTabEntityTable = ({
	scanJobId,
	tab,
	live,
}: {
	scanJobId: string;
	tab: PipelineJobTab;
	live: boolean;
}) => {
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(1);
	const [sortField, setSortField] = useState(tab.defaultSort?.field);
	const [sortDirection, setSortDirection] = useState<"asc" | "desc">(
		tab.defaultSort?.direction ?? "desc",
	);
	const [filters, setFilters] = useState<Record<string, string[]>>({});
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const router = useRouter();

	const list = api.scan.jobTabData.useQuery(
		{
			scanJobId,
			tabId: tab.id,
			page,
			pageSize: 20,
			query,
			sortField,
			sortDirection,
			filters,
		},
		{
			enabled: !!scanJobId,
			refetchInterval: live ? 20_000 : false,
		},
	);
	const isLedger = tab.dataSource === "ledger-primitives";
	const detail = api.scan.jobTabDetail.useQuery(
		{
			scanJobId,
			tabId: tab.id,
			itemId: selectedId ?? "",
		},
		{ enabled: !!selectedId && Boolean(tab.detail) && !isLedger },
	);

	const columns = tab.columns.length ? tab.columns : ["title"];
	const items = list.data?.items ?? [];
	const totalPages = Math.max(
		1,
		Math.ceil((list.data?.total ?? 0) / (list.data?.pageSize ?? 20)),
	);

	const filterOptions = list.data?.filterOptions ?? {};

	const selectedItem = items.find((item) => item.id === selectedId);
	const selectedTitle = useMemo(() => {
		const title = selectedItem?.values.title;
		if (isLedger && typeof title === "string" && title.length > 0) {
			return title;
		}
		const statement = selectedItem?.values.statement;
		if (typeof statement === "string" && statement.length > 0) {
			return statement;
		}
		const file = selectedItem?.values.file;
		const line = selectedItem?.values.line;
		if (typeof file === "string" && file.length > 0) {
			return line == null ? file : `${file}:${line}`;
		}
		return String(
			selectedItem?.values.title ??
				selectedItem?.values.name ??
				selectedId ??
				"",
		);
	}, [selectedId, selectedItem]);

	const openLedger = (functionId: string) => {
		const path = router.asPath.split("?")[0]?.replace(/\/$/, "") ?? "";
		void router.push(`${path}/ledger/${encodeURIComponent(functionId)}`);
	};

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-[220px] flex-1">
					<Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
					<Input
						className="pl-8"
						value={query}
						placeholder={
							tab.dataSource === "ledger-primitives"
								? "Search function, file, or primitive"
								: `Search ${tab.label.toLowerCase()}`
						}
						onChange={(event) => {
							setPage(1);
							setQuery(event.target.value);
						}}
					/>
				</div>
				{tab.filters.map((field) => (
					<select
						key={field}
						className="h-9 rounded-md border bg-background px-2 text-sm"
						value={(filters[field] ?? [])[0] ?? ""}
						onChange={(event) => {
							setPage(1);
							setFilters((current) => ({
								...current,
								[field]: event.target.value ? [event.target.value] : [],
							}));
						}}
					>
						<option value="">All {formatColumnLabel(field)}</option>
						{(filterOptions[field] ?? []).map((option) => (
							<option key={option} value={option}>
								{formatFilterOption(option)}
							</option>
						))}
					</select>
				))}
			</div>
			<div className="overflow-x-auto rounded-md border">
				<table className="min-w-full text-sm">
					<thead className="bg-muted/40 text-left">
						<tr>
							{columns.map((column) => (
								<th
									key={column}
									className="px-3 py-2 font-medium"
									aria-sort={
										sortField === column
											? sortDirection === "asc"
												? "ascending"
												: "descending"
											: undefined
									}
								>
									<button
										type="button"
										className="hover:underline"
										onClick={() => {
											if (sortField === column) {
												setSortDirection((current) =>
													current === "asc" ? "desc" : "asc",
												);
											} else {
												setSortField(column);
												setSortDirection("desc");
											}
											setPage(1);
										}}
									>
										{formatColumnLabel(column)}
										{sortField === column
											? sortDirection === "asc"
												? " ↑"
												: " ↓"
											: ""}
									</button>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{list.isLoading ? (
							<tr>
								<td className="px-3 py-8 text-center" colSpan={columns.length}>
									<Loader2 className="mx-auto size-5 animate-spin" />
								</td>
							</tr>
						) : items.length === 0 ? (
							<tr>
								<td
									className="px-3 py-8 text-center text-muted-foreground"
									colSpan={columns.length}
								>
									No rows
								</td>
							</tr>
						) : (
							items.map((item) => (
								<tr
									key={item.id}
									className="cursor-pointer border-t hover:bg-muted/40"
									onClick={() =>
										isLedger ? openLedger(item.id) : setSelectedId(item.id)
									}
								>
									{columns.map((column) => (
										<td
											key={column}
											className={
												isLedger && column === "id"
													? "whitespace-nowrap px-3 py-2 font-mono tabular-nums"
													: "max-w-xs truncate px-3 py-2"
											}
										>
											{formatCell(item.values[column])}
										</td>
									))}
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>
			<div className="flex items-center justify-between text-xs text-muted-foreground">
				<span>{list.data?.total ?? 0} items</span>
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={page <= 1}
						onClick={() => setPage((current) => Math.max(1, current - 1))}
					>
						Prev
					</Button>
					<span>
						{page} / {totalPages}
					</span>
					<Button
						size="sm"
						variant="outline"
						disabled={page >= totalPages}
						onClick={() => setPage((current) => current + 1)}
					>
						Next
					</Button>
				</div>
			</div>
			<Sheet
				open={Boolean(selectedId) && !isLedger}
				onOpenChange={(open) => !open && setSelectedId(null)}
			>
				<SheetContent className="overflow-y-auto sm:max-w-lg">
					<SheetHeader>
						<SheetTitle>{selectedTitle || "Detail"}</SheetTitle>
					</SheetHeader>
					<pre className="mt-4 whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 text-xs">
						{detail.isLoading
							? "Loading…"
							: JSON.stringify(
									detail.data?.fields ?? detail.data?.raw ?? {},
									null,
									2,
								)}
					</pre>
				</SheetContent>
			</Sheet>
		</div>
	);
};

const formatColumnLabel = (column: string) =>
	column === "id"
		? "ID"
		: column
				.replace(/([a-z])([A-Z])/g, "$1 $2")
				.replace(/^./, (char) => char.toUpperCase());

const formatFilterOption = (value: string) => value.replaceAll("_", " ");

const formatCell = (value: unknown) => {
	if (value == null || value === "") return "—";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};


