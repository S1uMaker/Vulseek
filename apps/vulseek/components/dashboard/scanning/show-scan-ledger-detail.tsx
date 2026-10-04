import { Loader2, Search } from "lucide-react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import {
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
} from "@/components/dashboard/ui-system";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { parseTabParam } from "@/lib/ui-system/tab-query";
import { api } from "@/utils/api";

type LedgerPrimitiveView = {
	id?: string;
	type?: string;
	title?: string;
	statement?: string;
	state?: string;
	verdict?: string;
	locations?: unknown;
	context?: unknown;
	assessment?: unknown;
	evidence?: unknown;
	gaps?: unknown;
	links?: unknown;
};

const DETAIL_TABS = ["overview", "primitives"] as const;
type LedgerDetailTab = (typeof DETAIL_TABS)[number];

const primitiveSearchText = (primitive: LedgerPrimitiveView) =>
	[
		primitive.id,
		primitive.type,
		primitive.title,
		primitive.statement,
		primitive.state,
		primitive.verdict,
		JSON.stringify(primitive.locations ?? ""),
		JSON.stringify(primitive.context ?? ""),
		JSON.stringify(primitive.assessment ?? ""),
		JSON.stringify(primitive.evidence ?? ""),
		JSON.stringify(primitive.gaps ?? ""),
		JSON.stringify(primitive.links ?? ""),
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();

const asPrimitives = (value: unknown): LedgerPrimitiveView[] => {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is LedgerPrimitiveView =>
			Boolean(item) && typeof item === "object",
	);
};

const queryValue = (value: string | string[] | undefined) =>
	typeof value === "string" ? value : "";

const textValue = (value: unknown) =>
	typeof value === "string" && value.length > 0 ? value : "";

const FieldCard = ({
	label,
	value,
	copy,
}: {
	label: string;
	value: string;
	copy?: boolean;
}) => (
	<div className="rounded-lg border p-3">
		<div className="text-sm text-muted-foreground">{label}</div>
		<div className="mt-1 flex items-start gap-2 break-all font-medium">
			<span className="min-w-0 flex-1">{value || "—"}</span>
			{copy && value ? (
				<CopyValueButton value={value} label={label} className="size-6 shrink-0" />
			) : null}
		</div>
	</div>
);

const JsonBlock = ({ label, value }: { label: string; value: unknown }) => {
	if (value == null) return null;
	if (Array.isArray(value) && value.length === 0) return null;
	if (
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === 0
	) {
		return null;
	}
	return (
		<div className="mt-3">
			<div className="text-xs font-medium text-muted-foreground">{label}</div>
			<pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs">
				{JSON.stringify(value, null, 2)}
			</pre>
		</div>
	);
};

export const ShowScanLedgerDetail = () => {
	const router = useRouter();
	const scanJobId = queryValue(router.query.scanJobId);
	const functionId = queryValue(router.query.functionId);
	const projectId = queryValue(router.query.projectId);
	const environmentId = queryValue(router.query.environmentId);
	const [primitiveQuery, setPrimitiveQuery] = useState("");
	const [activeTab, setActiveTab] = useState<LedgerDetailTab>("overview");
	const requestedTab = parseTabParam(
		router.query,
		DETAIL_TABS,
		"overview",
	) as LedgerDetailTab;
	useEffect(() => {
		if (requestedTab !== activeTab) setActiveTab(requestedTab);
	}, [activeTab, requestedTab]);
	useEffect(() => {
		setPrimitiveQuery("");
	}, [functionId]);
	const detail = api.scan.jobTabDetail.useQuery(
		{
			scanJobId,
			tabId: "ledger",
			itemId: functionId,
		},
		{ enabled: router.isReady && Boolean(scanJobId) && Boolean(functionId) },
	);
	const fields =
		detail.data?.fields && typeof detail.data.fields === "object"
			? (detail.data.fields as Record<string, unknown>)
			: {};
	const raw =
		detail.data?.raw && typeof detail.data.raw === "object"
			? (detail.data.raw as Record<string, unknown>)
			: {};
	const primitives = asPrimitives(fields.primitives ?? raw.primitives);
	const visiblePrimitives = useMemo(() => {
		const query = primitiveQuery.trim().toLowerCase();
		if (!query) return primitives;
		return primitives.filter((primitive) =>
			primitiveSearchText(primitive).includes(query),
		);
	}, [primitiveQuery, primitives]);
	const functionName =
		textValue(fields.functionName) || textValue(fields.title) || "Ledger";
	const file = textValue(fields.file) || textValue(raw.file);
	const line = fields.line ?? raw.line;
	const endLine = raw.endLine;
	const state = textValue(fields.state) || textValue(raw.state);
	const revision = fields.revision ?? raw.revision;
	const location = file
		? `${file}${line == null ? "" : `:${String(line)}`}${
				endLine == null || endLine === line ? "" : `-${String(endLine)}`
			}`
		: "";
	const jobPath =
		router.asPath.split("?")[0]?.replace(/\/ledger\/[^/]+$/, "") ?? "";
	const backHref = `${jobPath}?tab=ledger`;

	return (
		<div className="pb-10">
			<BreadcrumbSidebar
				list={[
					{ name: "Projects", href: "/dashboard/projects" },
					...(projectId && environmentId
						? [
								{
									name: environmentId,
									href: `/dashboard/project/${projectId}/environment/${environmentId}`,
								},
							]
						: []),
					{ name: `Job ${scanJobId.slice(0, 6)}`, href: backHref },
					{ name: functionName },
				]}
			/>
			<Head>
				<title>{`${functionName} | Ledger`}</title>
			</Head>
			<DashboardPage>
				<DashboardPageHeader
					title={functionName}
					description={
						<div className="flex min-w-0 items-center gap-2 break-all">
							<span>{functionId}</span>
							<CopyValueButton
								value={functionId}
								label="Function ID"
								className="size-7 shrink-0"
							/>
							{state ? <Badge variant="outline">{state}</Badge> : null}
						</div>
					}
					actions={
						<Button variant="outline" size="sm" asChild>
							<Link href={backHref}>Back to ledger</Link>
						</Button>
					}
				/>
				<DashboardPageTabs
					fallback="overview"
					tabs={[
						{ value: "overview", label: "Overview" },
						{
							value: "primitives",
							label: `Primitives${primitives.length ? ` (${primitives.length})` : ""}`,
						},
					]}
				/>
				<DashboardPageBody>
					<DashboardPageTabContent>
						{detail.isLoading ? (
							<div className="flex items-center gap-2 text-muted-foreground">
								<Loader2 className="size-4 animate-spin" />
								Loading ledger…
							</div>
						) : detail.error ? (
							<p className="text-sm text-destructive">{detail.error.message}</p>
						) : (
							<Tabs
								value={activeTab}
								onValueChange={(value) =>
									setActiveTab(value as LedgerDetailTab)
								}
								className="w-full"
							>
								<TabsContent value="overview" className="mt-0 pt-0">
									<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">General</div>
										<div className="grid gap-3 md:grid-cols-2">
											<FieldCard label="State" value={state} />
											<FieldCard label="Location" value={location} copy />
											<FieldCard
												label="Primitives"
												value={String(primitives.length)}
											/>
											<FieldCard
												label="Revision"
												value={revision == null ? "" : String(revision)}
											/>
											<FieldCard label="Repo" value={textValue(fields.repoId) || textValue(raw.repoId)} copy />
											<FieldCard
												label="Snapshot"
												value={
													textValue(fields.snapshotId) ||
													textValue(raw.snapshotId)
												}
												copy
											/>
											<FieldCard
												label="Source job"
												value={textValue(raw.sourceJobId)}
												copy
											/>
											<FieldCard
												label="Created by"
												value={
													textValue(fields.createdBy) || textValue(raw.createdBy)
												}
											/>
											<FieldCard
												label="Updated by"
												value={
													textValue(fields.updatedBy) || textValue(raw.updatedBy)
												}
											/>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Created
												</div>
												<div className="mt-1 font-medium">
													{textValue(fields.createdAt) ||
													textValue(raw.createdAt) ? (
														<DateTooltip
															date={
																textValue(fields.createdAt) ||
																textValue(raw.createdAt)
															}
														/>
													) : (
														"—"
													)}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Updated
												</div>
												<div className="mt-1 font-medium">
													{textValue(fields.updatedAt) ||
													textValue(raw.updatedAt) ? (
														<DateTooltip
															date={
																textValue(fields.updatedAt) ||
																textValue(raw.updatedAt)
															}
														/>
													) : (
														"—"
													)}
												</div>
											</div>
										</div>
									</section>
								</TabsContent>
								<TabsContent value="primitives" className="mt-0 pt-0">
									{primitives.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No primitives
										</p>
									) : (
										<div className="space-y-3">
											<div className="relative max-w-md">
												<Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
												<Input
													className="pl-8"
													value={primitiveQuery}
													placeholder="Search type, title, statement, or evidence"
													onChange={(event) =>
														setPrimitiveQuery(event.target.value)
													}
												/>
											</div>
											{visiblePrimitives.length === 0 ? (
												<p className="text-sm text-muted-foreground">
													No primitives match “{primitiveQuery.trim()}”
												</p>
											) : null}
											<ul className="space-y-3">
											{visiblePrimitives.map((primitive, index) => (
												<li
													key={primitive.id ?? index}
													className="rounded-lg border p-4"
												>
													<div className="flex flex-wrap items-center gap-2">
														<Badge variant="secondary">
															{primitive.type ?? "primitive"}
														</Badge>
														{primitive.verdict ? (
															<Badge variant="outline">
																{primitive.verdict}
															</Badge>
														) : null}
														{primitive.state ? (
															<span className="text-xs text-muted-foreground">
																{primitive.state}
															</span>
														) : null}
														{primitive.id ? (
															<span className="font-mono text-xs text-muted-foreground">
																{primitive.id}
															</span>
														) : null}
													</div>
													<div className="mt-2 text-sm font-medium">
														{primitive.title || primitive.id || "Untitled"}
													</div>
													{primitive.statement ? (
														<p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
															{primitive.statement}
														</p>
													) : null}
													<JsonBlock
														label="Locations"
														value={primitive.locations}
													/>
													<JsonBlock label="Context" value={primitive.context} />
													<JsonBlock
														label="Assessment"
														value={primitive.assessment}
													/>
													<JsonBlock
														label="Evidence"
														value={primitive.evidence}
													/>
													<JsonBlock label="Gaps" value={primitive.gaps} />
													<JsonBlock label="Links" value={primitive.links} />
												</li>
											))}
											</ul>
										</div>
									)}
								</TabsContent>
							</Tabs>
						)}
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</div>
	);
};
