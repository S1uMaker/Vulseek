"use client";

import { FileIcon, FolderPlus, Loader2, PlusIcon, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type DirectoryCacheEntry,
	LazyFileTree,
	ROOT_DIRECTORY_KEY,
} from "@/components/dashboard/scanning/lazy-file-tree";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

type Props = {
	skillId: string | null;
	skillName?: string;
	onOpenChange: (open: boolean) => void;
};

export const SkillFilesDialog = ({ skillId, skillName, onOpenChange }: Props) => {
	const utils = api.useUtils();
	const open = Boolean(skillId);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [expandedDirectories, setExpandedDirectories] = useState<
		Record<string, boolean>
	>({});
	const [directoryCache, setDirectoryCache] = useState<
		Record<string, DirectoryCacheEntry>
	>({});
	const [draft, setDraft] = useState("");
	const [newPath, setNewPath] = useState("");
	const [creatingDirectory, setCreatingDirectory] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const rootDirectoryQuery = api.skills.listDirectory.useQuery(
		{ skillId: skillId || "" },
		{ enabled: open },
	);
	const selectedFileQuery = api.skills.readFile.useQuery(
		{ skillId: skillId || "", filePath: selectedFilePath || "" },
		{ enabled: open && Boolean(selectedFilePath) },
	);
	const writeMutation = api.skills.writeFile.useMutation();
	const createMutation = api.skills.createFile.useMutation();
	const deleteMutation = api.skills.deleteFile.useMutation();

	useEffect(() => {
		setSelectedFilePath(null);
		setExpandedDirectories({});
		setDirectoryCache({});
		setDraft("");
		setNewPath("");
		setCreatingDirectory(false);
		setConfirmDelete(false);
	}, [skillId]);

	useEffect(() => {
		if (!open) return;
		if (rootDirectoryQuery.isLoading) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: {
					items: current[ROOT_DIRECTORY_KEY]?.items || [],
					status: "loading",
				},
			}));
			return;
		}
		if (rootDirectoryQuery.isError) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: { items: [], status: "error" },
			}));
			return;
		}
		setDirectoryCache((current) => ({
			...current,
			[ROOT_DIRECTORY_KEY]: {
				items: rootDirectoryQuery.data || [],
				status: "loaded",
			},
		}));
	}, [
		open,
		rootDirectoryQuery.data,
		rootDirectoryQuery.isError,
		rootDirectoryQuery.isLoading,
	]);

	useEffect(() => {
		if (selectedFileQuery.data && !selectedFileQuery.data.binary) {
			setDraft(selectedFileQuery.data.content ?? "");
		}
	}, [selectedFileQuery.data]);

	const dirty = useMemo(() => {
		if (!selectedFileQuery.data || selectedFileQuery.data.binary) return false;
		return draft !== (selectedFileQuery.data.content ?? "");
	}, [draft, selectedFileQuery.data]);

	const refreshDirectory = async (directoryPath?: string) => {
		if (!skillId) return;
		const key = directoryPath || ROOT_DIRECTORY_KEY;
		const items = await utils.skills.listDirectory.fetch({
			skillId,
			directoryPath,
		});
		setDirectoryCache((current) => ({
			...current,
			[key]: { items, status: "loaded" },
		}));
	};

	const handleSelectFile = (filePath: string) => {
		setSelectedFilePath(filePath);
		setConfirmDelete(false);
	};

	const handleToggleDirectory = async (directoryPath: string) => {
		const nextExpanded = !expandedDirectories[directoryPath];
		setExpandedDirectories((current) => ({
			...current,
			[directoryPath]: nextExpanded,
		}));
		if (!nextExpanded || !skillId) return;
		const existing = directoryCache[directoryPath];
		if (existing?.status === "loading" || existing?.status === "loaded") {
			return;
		}
		setDirectoryCache((current) => ({
			...current,
			[directoryPath]: {
				items: current[directoryPath]?.items || [],
				status: "loading",
			},
		}));
		try {
			const items = await utils.skills.listDirectory.fetch({
				skillId,
				directoryPath,
			});
			setDirectoryCache((current) => ({
				...current,
				[directoryPath]: { items, status: "loaded" },
			}));
		} catch {
			setDirectoryCache((current) => ({
				...current,
				[directoryPath]: { items: [], status: "error" },
			}));
		}
	};

	const parentDirectory = (filePath: string) => {
		const index = filePath.lastIndexOf("/");
		return index === -1 ? undefined : filePath.slice(0, index);
	};

	const handleCreate = async () => {
		if (!skillId || !newPath.trim()) return;
		try {
			const created = await createMutation.mutateAsync({
				skillId,
				filePath: newPath.trim(),
				content: creatingDirectory ? undefined : "",
				directory: creatingDirectory,
			});
			setNewPath("");
			await refreshDirectory(parentDirectory(created.relativePath));
			await refreshDirectory();
			if (!created.directory) {
				setSelectedFilePath(created.relativePath);
			}
			toast.success(creatingDirectory ? "Folder created" : "File created");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to create path",
			);
		}
	};

	const handleSave = async () => {
		if (!skillId || !selectedFilePath) return;
		try {
			await writeMutation.mutateAsync({
				skillId,
				filePath: selectedFilePath,
				content: draft,
			});
			await utils.skills.readFile.invalidate({
				skillId,
				filePath: selectedFilePath,
			});
			toast.success("File saved");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to save file");
		}
	};

	const handleDelete = async () => {
		if (!skillId || !selectedFilePath) return;
		try {
			const parent = parentDirectory(selectedFilePath);
			await deleteMutation.mutateAsync({
				skillId,
				filePath: selectedFilePath,
			});
			setSelectedFilePath(null);
			setDraft("");
			setConfirmDelete(false);
			await refreshDirectory(parent);
			await refreshDirectory();
			toast.success("Deleted");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to delete file",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[85vh] w-[95vw] max-w-6xl flex-col p-0 sm:max-w-6xl">
				<DialogHeader className="border-b px-6 py-4 pr-12">
					<DialogTitle>{skillName || "Skill files"}</DialogTitle>
					<DialogDescription>
						Browse and edit files in this skill directory.
					</DialogDescription>
				</DialogHeader>
				<div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
					<div className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
						<div className="space-y-2 border-b p-3">
							<div className="flex gap-2">
								<Input
									value={newPath}
									onChange={(event) => setNewPath(event.target.value)}
									placeholder={
										creatingDirectory ? "references" : "notes.md"
									}
								/>
								<Button
									type="button"
									size="icon"
									variant={creatingDirectory ? "secondary" : "outline"}
									onClick={() => setCreatingDirectory((value) => !value)}
									title={creatingDirectory ? "New folder" : "New file"}
								>
									{creatingDirectory ? (
										<FolderPlus className="size-4" />
									) : (
										<PlusIcon className="size-4" />
									)}
								</Button>
								<Button
									type="button"
									onClick={() => void handleCreate()}
									disabled={!newPath.trim() || createMutation.isLoading}
									isLoading={createMutation.isLoading}
								>
									Add
								</Button>
							</div>
						</div>
						<div className="min-h-0 flex-1">
							<LazyFileTree
								rootItems={directoryCache[ROOT_DIRECTORY_KEY]?.items || []}
								rootStatus={
									directoryCache[ROOT_DIRECTORY_KEY]?.status ||
									(rootDirectoryQuery.isLoading ? "loading" : "idle")
								}
								expandedDirectories={expandedDirectories}
								selectedFilePath={selectedFilePath}
								directoryCache={directoryCache}
								onToggleDirectory={handleToggleDirectory}
								onSelectFile={handleSelectFile}
							/>
						</div>
					</div>
					<div className="flex min-h-0 min-w-0 flex-col">
						<div className="flex items-center gap-2 border-b px-4 py-3">
							<FileIcon className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate font-mono text-sm">
								{selectedFilePath || "No file selected"}
							</span>
							<Button
								type="button"
								size="sm"
								onClick={() => void handleSave()}
								disabled={
									!selectedFilePath ||
									!dirty ||
									Boolean(selectedFileQuery.data?.binary) ||
									writeMutation.isLoading
								}
								isLoading={writeMutation.isLoading}
							>
								<Save className="mr-1 size-4" />
								Save
							</Button>
							{confirmDelete ? (
								<>
									<Button
										type="button"
										size="sm"
										variant="destructive"
										onClick={() => void handleDelete()}
										disabled={deleteMutation.isLoading}
										isLoading={deleteMutation.isLoading}
									>
										Confirm delete
									</Button>
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => setConfirmDelete(false)}
									>
										Cancel
									</Button>
								</>
							) : (
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="hover:bg-red-500/10"
									disabled={!selectedFilePath || deleteMutation.isLoading}
									onClick={() => setConfirmDelete(true)}
								>
									<Trash2 className="size-4 text-primary" />
								</Button>
							)}
						</div>
						<div className="min-h-0 flex-1 overflow-auto p-4">
							{!selectedFilePath ? (
								<div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
									<FileIcon className="size-6" />
									Select a file to edit
								</div>
							) : selectedFileQuery.isLoading ? (
								<div className="flex min-h-[280px] items-center justify-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									Loading file...
								</div>
							) : selectedFileQuery.data?.binary ? (
								<div className="flex min-h-[280px] items-center justify-center text-muted-foreground">
									Binary file ({selectedFileQuery.data.size} bytes)
								</div>
							) : (
								<Textarea
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									className="h-full min-h-[50vh] font-mono text-sm"
								/>
							)}
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
