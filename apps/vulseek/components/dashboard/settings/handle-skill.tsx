"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

const Schema = z.object({
	name: z.string().min(1, { message: "Name is required" }),
	slug: z
		.string()
		.min(1, { message: "Slug is required" })
		.regex(/^[a-z][a-z0-9-]{0,63}$/, {
			message: "Slug must be lowercase letters, digits, and hyphens",
		}),
	description: z.string(),
	directoryPath: z
		.string()
		.min(1, { message: "Directory path is required" })
		.regex(/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/, {
			message: "Directory path must be relative to agents/skills",
		}),
});

type Schema = z.infer<typeof Schema>;

const slugFromName = (name: string) =>
	name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);

const emptyValues = (): Schema => ({
	name: "",
	slug: "",
	description: "",
	directoryPath: "",
});

interface Props {
	skillId?: string;
}

export const HandleSkill = ({ skillId }: Props) => {
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [slugTouched, setSlugTouched] = useState(Boolean(skillId));
	const [pathTouched, setPathTouched] = useState(Boolean(skillId));
	const { data } = api.skills.get.useQuery(
		{ skillId: skillId || "" },
		{ enabled: Boolean(skillId) && open },
	);
	const createMutation = api.skills.create.useMutation();
	const updateMutation = api.skills.update.useMutation();
	const isLoading = skillId ? updateMutation.isLoading : createMutation.isLoading;

	const form = useForm<Schema>({
		resolver: zodResolver(Schema),
		defaultValues: emptyValues(),
	});

	useEffect(() => {
		if (!open) return;
		if (skillId && data) {
			form.reset({
				name: data.name,
				slug: data.slug,
				description: data.description ?? "",
				directoryPath: data.directoryPath,
			});
			setSlugTouched(true);
			setPathTouched(true);
			return;
		}
		if (!skillId) {
			form.reset(emptyValues());
			setSlugTouched(false);
			setPathTouched(false);
		}
	}, [open, data, form, skillId]);

	const onSubmit = async (values: Schema) => {
		try {
			setError(null);
			const payload = {
				name: values.name.trim(),
				slug: values.slug.trim(),
				description: values.description.trim() || null,
				directoryPath: values.directoryPath.trim(),
			};
			if (skillId) {
				await updateMutation.mutateAsync({ ...payload, skillId });
			} else {
				await createMutation.mutateAsync(payload);
			}
			await utils.skills.list.invalidate();
			toast.success("Skill saved successfully");
			setOpen(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			setError(message);
			toast.error("Failed to save skill", { description: message });
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{skillId ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10"
					>
						<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button className="cursor-pointer space-x-3">
						<PlusIcon className="h-4 w-4" />
						Add Skill
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{skillId ? "Edit Skill" : "Add Skill"}</DialogTitle>
					<DialogDescription>
						Catalog a skill directory. Files live under agents/skills.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					{error && <AlertBlock type="error">{error}</AlertBlock>}
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="space-y-4 max-h-[70vh] overflow-y-auto px-1 py-0.5"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input
											placeholder="Orchestrator"
											{...field}
											onChange={(event) => {
												field.onChange(event);
												if (!slugTouched) {
													const slug = slugFromName(event.target.value);
													form.setValue("slug", slug, { shouldValidate: true });
													if (!pathTouched) {
														form.setValue("directoryPath", slug, {
															shouldValidate: true,
														});
													}
												}
											}}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="slug"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Slug</FormLabel>
									<FormControl>
										<Input
											placeholder="orchestrator"
											{...field}
											onChange={(event) => {
												setSlugTouched(true);
												field.onChange(event);
												if (!pathTouched) {
													form.setValue(
														"directoryPath",
														slugFromName(event.target.value) ||
															event.target.value,
														{ shouldValidate: true },
													);
												}
											}}
										/>
									</FormControl>
									<FormDescription>
										Used by pipeline YAML <code>skills:</code> lists
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="directoryPath"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Directory path</FormLabel>
									<FormControl>
										<Input
											placeholder="orchestrator"
											{...field}
											onChange={(event) => {
												setPathTouched(true);
												field.onChange(event);
											}}
										/>
									</FormControl>
									<FormDescription>
										Relative to <code>agents/skills</code>
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Description</FormLabel>
									<FormControl>
										<Textarea
											placeholder="Dispatch and collect hunter work"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<Button type="submit" isLoading={isLoading} className="w-full">
							Save
						</Button>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
