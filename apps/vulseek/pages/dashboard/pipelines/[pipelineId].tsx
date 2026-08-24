import type {
	GetServerSidePropsContext,
	InferGetServerSidePropsType,
} from "next";
import { useRouter } from "next/router";
import * as React from "react";
import { createServerSideHelpers } from "@trpc/react-query/server";
import {
	Archive,
	Copy,
	FilePenLine,
	Redo2,
	Save,
	Undo2,
	Upload,
	Workflow,
} from "lucide-react";
import { toast } from "sonner";
import superjson from "superjson";
import { validateRequest } from "@vulseek/server/lib/auth";
import {
	DashboardPage,
	DashboardPageHeader,
} from "@/components/dashboard/ui-system";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PipelineWorkbench } from "@/components/dashboard/pipelines/workbench/pipeline-workbench";
import { PipelineProfilesView } from "@/components/dashboard/pipelines/pipeline-profiles-view";
import type { YamlEditorHandle } from "@/components/dashboard/pipelines/yaml-editor";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	initialEditorState,
	isDirty,
	pipelineEditorReducer,
	validDocument,
} from "@/lib/pipeline-editor/pipeline-editor-state";
import { api } from "@/utils/api";
import { appRouter } from "@/server/api/root";

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
	const { user, session } = await validateRequest(context.req);
	if (!user || !session) {
		return { redirect: { destination: "/login", permanent: false } };
	}
	const pipelineId = String(context.query.pipelineId ?? "");
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
	await helpers.pipeline.get.prefetch({ pipelineId }).catch(() => {});
	await helpers.pipeline.listVersions.prefetch({ pipelineId }).catch(() => {});
	return {
		props: { trpcState: helpers.dehydrate(), pipelineId },
	};
};

const EditorPage = ({
	pipelineId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) => {
	const router = useRouter();

	// Warm the list route while the editor is open. Returning to the list then
	// reuses Next's route payload instead of waiting for a cold SSR navigation.
	React.useEffect(() => {
		void router.prefetch("/dashboard/pipelines");
	}, [router]);

	const pipeline = api.pipeline.get.useQuery({ pipelineId });
	const versions = api.pipeline.listVersions.useQuery({ pipelineId });
	const requestedProfileId =
		typeof router.query.profileId === "string"
			? router.query.profileId
			: undefined;
	const pipelineProfiles = api.pipeline.profilesList.useQuery(
		{ pipelineId },
		{
			enabled:
				router.query.view === "profiles" &&
				Boolean(requestedProfileId && requestedProfileId !== "new"),
		},
	);
	const saveDraft = api.pipeline.saveDraft.useMutation();
	const publish = api.pipeline.publish.useMutation();
	const copyVersionToDraft = api.pipeline.copyVersionToDraft.useMutation();
	const setCurrentVersion = api.pipeline.setCurrentVersion.useMutation();
	const archive = api.pipeline.archive.useMutation();

	const canManage = pipeline.data?.draftYaml !== undefined; // manager-only field presence
	const [selectedVersionId, setSelectedVersionId] = React.useState<string | null>(null);
	const [viewingVersion, setViewingVersion] = React.useState(false);

	const draftYaml = pipeline.data?.draftYaml ?? null;
	// No draft yet → seed the editor with the current published version's YAML
	// as a local starting point. Saving writes the draft; publishing still
	// produces a new immutable version.
	const currentVersionYaml = api.pipeline.getVersion.useQuery(
		{
			pipelineId,
			pipelineVersionId: pipeline.data?.currentVersion
				? (pipeline.data.currentPublishedVersionId ?? "")
				: "__none__",
		},
		{
			enabled: Boolean(
				pipeline.data &&
					!pipeline.data.draftYaml &&
					pipeline.data.currentVersion,
			),
		},
	).data?.yaml;
	const initialYaml = draftYaml ?? currentVersionYaml ?? "";

	// Selecting a version loads its YAML into the read-only Published View.
	const selectedVersionYaml = api.pipeline.getVersion.useQuery(
		{
			pipelineId,
			pipelineVersionId: selectedVersionId ?? "__none__",
		},
		{ enabled: Boolean(selectedVersionId && viewingVersion) },
	).data?.yaml;

	const [state, dispatch] = React.useReducer(
		pipelineEditorReducer,
		{ yaml: initialYaml, revision: pipeline.data?.draftRevision ?? 0 },
		({ yaml, revision }) => initialEditorState(yaml, revision),
	);

	// The Raw YAML editor lives inside the workbench; keep its handle here so
	// Save can flush the parse debounce before persisting.
	const yamlEditorRef = React.useRef<YamlEditorHandle | null>(null);
	const onYamlReady = React.useCallback(
		(handle: YamlEditorHandle | null) => {
			yamlEditorRef.current = handle;
		},
		[],
	);

	// When the server draft arrives (or changes): adopt it wholesale when the
	// local buffer has no unsaved edits (e.g. after copy-version-to-draft);
	// otherwise only refresh the saved-YAML baseline so the dirty state
	// compares against the server draft.
	const stateRef = React.useRef(state);
	stateRef.current = state;
	React.useEffect(() => {
		const serverYaml = draftYaml ?? currentVersionYaml;
		if (!serverYaml) return;
		// A published YAML used as the initial draft still shares the pipeline's
		// optimistic-lock counter. Resetting this to zero makes every first save
		// of a pipeline without an existing draft conflict with the server.
		const revision = pipeline.data?.draftRevision ?? 0;
		const untouched = stateRef.current.rawYamlBuffer === stateRef.current.savedYaml;
		if (untouched || !draftYaml) {
			// Adopt wholesale: fresh draft, or the current version as the
			// starting point when no draft exists yet.
			dispatch({ type: "reset", yaml: serverYaml, draftRevision: revision });
		} else {
			dispatch({ type: "setSavedYaml", yaml: serverYaml, draftRevision: revision });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draftYaml, currentVersionYaml, pipeline.data?.draftRevision]);

	const document = validDocument(state);
	const dirty = isDirty(state);
	const canPublish =
		state.status.kind === "valid" &&
		!state.status.stale &&
		!state.diagnostics.some((d) => d.severity === "error");

	const handleSave = async () => {
		if (!canManage) return;
		// Flush the YAML editor's parse debounce so the saved buffer matches
		// what the user actually sees.
		const editorText = yamlEditorRef.current?.getValue();
		const yamlToSave = editorText !== undefined ? editorText : state.rawYamlBuffer;
		if (editorText !== undefined && editorText !== state.rawYamlBuffer) {
			dispatch({ type: "setBuffer", yaml: editorText });
		}
		try {
			await saveDraft.mutateAsync({
				pipelineId,
				expectedRevision: state.draftRevision,
				yaml: yamlToSave,
			});
			// Save the baseline from the *requested* YAML (post-flush), not the
			// pre-flush reducer buffer, so a just-flushed CodeMirror buffer
			// cannot leave the dirty state stuck.
			dispatch({
				type: "setSavedYaml",
				yaml: yamlToSave,
				draftRevision: state.draftRevision + 1,
			});
			toast.success("Draft saved");
		} catch (error) {
			const cause = (error as { cause?: { draftRevision?: number } }).cause;
			if (cause?.draftRevision != null) {
				toast.error(
					`Draft changed on the server (revision ${cause.draftRevision}). Reload to see the latest, or copy your local YAML before retrying.`,
				);
			} else {
				toast.error(error instanceof Error ? error.message : "Unable to save draft");
			}
		}
	};

	const handlePublish = async () => {
		if (!canManage || !canPublish) return;
		try {
			const result = await publish.mutateAsync({
				pipelineId,
				expectedRevision: state.draftRevision,
				yaml: state.rawYamlBuffer,
			});
			dispatch({
				type: "setSavedYaml",
				yaml: state.rawYamlBuffer,
				draftRevision: state.draftRevision + 1,
			});
			toast.success(`Published as v${result.versionNumber}`);
			// Publish returns the immutable version that was created or reused.
			// Select it before switching to the read-only view; otherwise the
			// workbench has no version YAML and renders an empty state.
			setSelectedVersionId(result.pipelineVersionId);
			setViewingVersion(true);
			await pipeline.refetch();
			await versions.refetch();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Publish failed");
		}
	};

	const handleCopyVersion = async (versionId: string) => {
		if (!canManage) return;
		try {
			await copyVersionToDraft.mutateAsync({ pipelineId, pipelineVersionId: versionId });
			toast.success("Version copied to draft");
			setViewingVersion(false);
			await pipeline.refetch();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Copy failed");
		}
	};

	const isManagerViewRef = React.useRef(false);
	isManagerViewRef.current = canManage && !viewingVersion;

	// Ctrl/Cmd+S saves the draft; Ctrl/Cmd+Z / Shift undo/redo.
	React.useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			const modifier = event.metaKey || event.ctrlKey;
			if (!modifier) return;
			const key = event.key.toLowerCase();
			if (key === "s") {
				event.preventDefault();
				if (dirty && canManage) void handleSave();
				return;
			}
			if (!isManagerViewRef.current) return;
			if (key === "z" && !event.shiftKey) {
				event.preventDefault();
				dispatch({ type: "undo" });
				return;
			}
			if (key === "z" && event.shiftKey) {
				event.preventDefault();
				dispatch({ type: "redo" });
				return;
			}
			if (key === "y") {
				event.preventDefault();
				dispatch({ type: "redo" });
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dirty, canManage, state.rawYamlBuffer, state.draftRevision]);

	// Dirty-leave guard.
	React.useEffect(() => {
		const handler = (event: BeforeUnloadEvent) => {
			if (dirty) {
				event.preventDefault();
				event.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);

	if (pipeline.isLoading || !pipeline.data) {
		return (
			<DashboardLayout hideBreadcrumb collapseSidebarBelow={1100}>
				<BreadcrumbSidebar
					list={[{ name: "Pipelines", href: "/dashboard/pipelines" }]}
				/>
				<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
					Loading pipeline…
				</div>
			</DashboardLayout>
		);
	}

	const data = pipeline.data;
	const isManagerView = canManage && !viewingVersion;
	const selectedVersion = versions.data?.find(
		(version) => version.pipelineVersionId === selectedVersionId,
	);
	// Version view: the read-only workbench renders the *version's* YAML
	// (see PipelineWorkbench.readOnlyYaml), never the draft buffer.
	const versionLabel = selectedVersion
		? `v${selectedVersion.versionNumber}`
		: data.currentVersion
			? `v${data.currentVersion.versionNumber}`
			: null;
	const workbenchView =
		router.query.view === "visual" ||
		router.query.view === "raw" ||
		router.query.view === "profiles"
			? router.query.view
			: "definition";
	const profileId = requestedProfileId;
	const selectedProfileName =
		profileId === "new"
			? "New profile"
			: pipelineProfiles.data?.find(
					(item) => item.pipelineProfileId === profileId,
				)?.name ??
				(profileId ? `Profile ${profileId.slice(0, 6)}` : undefined);
	const pipelineHref = `/dashboard/pipelines/${encodeURIComponent(pipelineId)}`;
	const updateWorkbenchView = (view: typeof workbenchView) => {
		const query = { ...router.query };
		if (view === "definition") delete query.view;
		else query.view = view;
		if (view !== "profiles") delete query.profileId;
		void router.replace({ pathname: router.pathname, query }, undefined, {
			shallow: true,
		});
	};
	const updateProfileId = (nextProfileId?: string) => {
		const query: Record<string, string | string[] | undefined> = {
			...router.query,
			view: "profiles",
		};
		if (nextProfileId) query.profileId = nextProfileId;
		else delete query.profileId;
		void router.replace({ pathname: router.pathname, query }, undefined, {
			shallow: true,
		});
	};

	return (
		<DashboardLayout hideBreadcrumb fullHeight collapseSidebarBelow={1100}>
			<BreadcrumbSidebar
				list={
					profileId
						? [
								{ name: "Pipelines", href: "/dashboard/pipelines" },
								{ name: data.name, href: pipelineHref },
								{ name: "Profiles", href: `${pipelineHref}?view=profiles` },
								{ name: selectedProfileName || "Profile" },
							]
						: [
								{ name: "Pipelines", href: "/dashboard/pipelines" },
								{ name: data.name },
							]
				}
			/>
			<DashboardPage
				className="h-auto min-h-0 flex-1"
				contentClassName="overflow-hidden"
			>
				<DashboardPageHeader
					icon={<Workflow />}
					title={data.name}
					description={`${data.slug}${data.currentVersion ? ` · v${data.currentVersion.versionNumber} current` : " · no published version"}`}
					status={
						<>
							{data.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
							{isManagerView ? (
								<Badge
									variant="outline"
									className={
										dirty
											? "border-amber-500/40 text-amber-600"
											: "border-emerald-500/40 text-emerald-600"
										}
								>
									{dirty ? "Draft (unsaved)" : "Draft"}
								</Badge>
							) : (
								<Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
									Published{selectedVersion ? ` v${selectedVersion.versionNumber}` : ""}
								</Badge>
							)}
						</>
					}
					actions={
						<div className="flex items-center gap-2">
						{isManagerView ? (
							<>
								<Select
									value={selectedVersionId ?? ""}
									onValueChange={(value) => {
										setSelectedVersionId(value || null);
										if (value) {
											setViewingVersion(true);
										}
									}}
								>
									<SelectTrigger className="h-8 w-40">
										<SelectValue placeholder="View a version…" />
									</SelectTrigger>
									<SelectContent>
										{versions.data?.map((version) => (
											<SelectItem
												key={version.pipelineVersionId}
												value={version.pipelineVersionId}
											>
												v{version.versionNumber}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{selectedVersion ? (
									<>
										<Button
											variant="outline"
											size="sm"
											onClick={() => void handleCopyVersion(selectedVersion.pipelineVersionId)}
										>
											<Copy className="size-3.5" />
											Copy to draft
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												void setCurrentVersion
													.mutateAsync({
														pipelineId,
														pipelineVersionId: selectedVersion.pipelineVersionId,
													})
													.then(() => {
														toast.success(`v${selectedVersion.versionNumber} is now current`);
														void pipeline.refetch();
													})
													.catch((error: unknown) =>
														toast.error(
															error instanceof Error ? error.message : "Switch failed",
														),
													);
											}}
										>
											<Upload className="size-3.5" />
											Set current
										</Button>
									</>
								) : null}
								<Button
									variant="ghost"
									size="icon"
									className="size-8 text-muted-foreground"
									onClick={() => dispatch({ type: "undo" })}
									aria-label="Undo"
								>
									<Undo2 className="size-4" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									className="size-8 text-muted-foreground"
									onClick={() => dispatch({ type: "redo" })}
									aria-label="Redo"
								>
									<Redo2 className="size-4" />
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => void handleSave()}
									disabled={!dirty || saveDraft.isLoading}
								>
									<Save className="size-3.5" />
									{dirty ? "Save draft" : "Saved"}
								</Button>
								<Button
									size="sm"
									onClick={() => void handlePublish()}
									disabled={!canPublish || publish.isLoading}
								>
									Publish
								</Button>
								{!data.archivedAt ? (
									<Button
										variant="ghost"
										size="icon"
										className="size-8 text-muted-foreground hover:text-red-600"
										onClick={() => {
											if (
												window.confirm(
													"Archive this pipeline? Runs keep their frozen snapshots.",
												)
											) {
												void archive
													.mutateAsync({ pipelineId })
													.then(() => toast.success("Pipeline archived"))
													.then(() => void router.push("/dashboard/pipelines"));
											}
										}}
										aria-label="Archive pipeline"
									>
										<Archive className="size-4" />
									</Button>
								) : null}
							</>
						) : (
							<>
								{selectedVersion ? (
									<Button
										variant="outline"
										size="sm"
										onClick={() => void handleCopyVersion(selectedVersion.pipelineVersionId)}
									>
										<Copy className="size-3.5" />
										Copy to draft
									</Button>
								) : null}
								{data.currentVersion ? (
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											// Phase 6 wires the Run dialog here.
											toast.info("Run dialog lands with the profile integration phase");
										}}
									>
										Run
									</Button>
								) : null}
								{canManage && (
									<Button
										variant="outline"
										size="sm"
										onClick={() => setViewingVersion(false)}
									>
										<FilePenLine className="size-3.5" />
										{data.draftYaml !== null ? "Edit draft" : "Edit pipeline"}
									</Button>
								)}
							</>
						)}
						</div>
					}
				/>

				{/* Workbench: Definition | Visual | Raw YAML */}
				<PipelineWorkbench
					state={state}
					dispatch={dispatch}
					readOnly={!isManagerView}
					readOnlyYaml={!isManagerView ? (selectedVersionYaml ?? undefined) : undefined}
					versionLabel={versionLabel}
					draftState={{
						dirty,
						draftRevision: state.draftRevision,
						publishedVersion: data.currentVersion
							? String(data.currentVersion.versionNumber)
							: null,
					}}
					onYamlReady={onYamlReady}
					initialView={workbenchView}
					onViewChange={updateWorkbenchView}
					profilesContent={
						<PipelineProfilesView
							pipelineId={pipelineId}
							pipelineVersionId={data.currentPublishedVersionId}
							profileId={profileId}
							onProfileChange={updateProfileId}
						/>
					}
				/>
			</DashboardPage>
		</DashboardLayout>
	);
};

export default EditorPage;
