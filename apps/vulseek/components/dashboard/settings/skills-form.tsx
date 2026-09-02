"use client";

import { BookOpen, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { HandleSkill } from "./handle-skill";
import { SkillFilesDialog } from "./skill-files-dialog";

export const SkillsForm = () => {
	const { data: skills, refetch, isLoading } = api.skills.list.useQuery();
	const { mutateAsync, isLoading: isRemoving } = api.skills.delete.useMutation();
	const [openSkillId, setOpenSkillId] = useState<string | null>(null);
	const openSkill = skills?.find((skill) => skill.skillId === openSkillId);

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row gap-2 justify-between">
						<div>
							<CardTitle className="text-xl flex flex-row gap-2">
								<BookOpen className="size-6 text-muted-foreground self-center" />
								Skills
							</CardTitle>
							<CardDescription>
								Manage agent skill directories. Click a skill to browse and edit
								its files.
							</CardDescription>
						</div>
						{skills && skills.length > 0 && <HandleSkill />}
					</CardHeader>
					<CardContent className="space-y-2 py-8 border-t">
						{isLoading ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : skills?.length === 0 ? (
							<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center">
								<BookOpen className="size-8 self-center text-muted-foreground" />
								<span className="text-base text-muted-foreground text-center">
									You don't have any skills
								</span>
								<HandleSkill />
							</div>
						) : (
							<div className="flex flex-col gap-4 rounded-lg min-h-[25vh]">
								{skills?.map((skill) => (
									<div
										key={skill.skillId}
										className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
									>
										<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full gap-4">
											<button
												type="button"
												className="min-w-0 flex-1 text-left"
												onClick={() => setOpenSkillId(skill.skillId)}
											>
												<span className="text-sm font-medium">{skill.name}</span>
												<CardDescription className="break-all">
													{skill.slug}
													{" · "}
													agents/skills/{skill.directoryPath}
												</CardDescription>
												{skill.description ? (
													<CardDescription className="mt-1 line-clamp-2">
														{skill.description}
													</CardDescription>
												) : null}
											</button>
											<div className="flex justify-between items-center shrink-0">
												<HandleSkill skillId={skill.skillId} />
												<DialogAction
													title="Delete Skill"
													description="This deletes the catalog item and the skill directory on disk."
													type="destructive"
													onClick={async () => {
														await mutateAsync({ skillId: skill.skillId })
															.then(() => {
																toast.success("Skill deleted successfully");
																if (openSkillId === skill.skillId) {
																	setOpenSkillId(null);
																}
																refetch();
															})
															.catch(() => {
																toast.error("Error deleting skill");
															});
													}}
												>
													<Button
														variant="ghost"
														size="icon"
														className="group hover:bg-red-500/10"
														isLoading={isRemoving}
													>
														<Trash2 className="size-4 text-primary group-hover:text-red-500" />
													</Button>
												</DialogAction>
											</div>
										</div>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</div>
			</Card>
			<SkillFilesDialog
				skillId={openSkillId}
				skillName={openSkill?.name}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) setOpenSkillId(null);
				}}
			/>
		</div>
	);
};
