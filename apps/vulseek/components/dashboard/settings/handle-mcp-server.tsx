"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { PenBoxIcon, PlusIcon, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

const nameValueSchema = z.object({
	name: z.string(),
	value: z.string(),
});

const Schema = z
	.object({
		name: z.string().min(1, { message: "Name is required" }),
		slug: z
			.string()
			.min(1, { message: "Slug is required" })
			.regex(/^[a-z][a-z0-9-]{0,63}$/, {
				message: "Slug must be lowercase letters, digits, and hyphens",
			}),
		description: z.string(),
		transport: z.enum(["stdio", "http", "sse"]),
		url: z.string(),
		headers: z.array(nameValueSchema),
		command: z.string(),
		argsText: z.string(),
		env: z.array(nameValueSchema),
		isEnabled: z.boolean(),
	})
	.superRefine((value, ctx) => {
		if (value.transport === "stdio") {
			if (!value.command.trim()) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["command"],
					message: "Command is required",
				});
			}
			return;
		}
		if (!value.url.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["url"],
				message: "URL is required",
			});
		}
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
	transport: "http",
	url: "",
	headers: [],
	command: "",
	argsText: "",
	env: [],
	isEnabled: true,
});

const valuesFromServer = (source: {
	name: string;
	slug: string;
	description?: string | null;
	transport: Schema["transport"];
	url?: string | null;
	headers?: Array<{ name: string; value: string }>;
	command?: string | null;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	isEnabled?: boolean;
}): Schema => ({
	name: source.name,
	slug: source.slug,
	description: source.description ?? "",
	transport: source.transport,
	url: source.url ?? "",
	headers: source.headers ?? [],
	command: source.command ?? "",
	argsText: (source.args ?? []).join("\n"),
	env: source.env ?? [],
	isEnabled: source.isEnabled ?? true,
});

const toApiInput = (values: Schema) => ({
	name: values.name.trim(),
	slug: values.slug.trim(),
	description: values.description.trim() || null,
	transport: values.transport,
	url: values.url.trim() || null,
	headers: values.headers.filter((item) => item.name.trim()),
	command: values.command.trim() || null,
	args: values.argsText
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean),
	env: values.env.filter((item) => item.name.trim()),
	isEnabled: values.isEnabled,
});

interface Props {
	mcpServerId?: string;
}

export const HandleMcpServer = ({ mcpServerId }: Props) => {
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [slugTouched, setSlugTouched] = useState(Boolean(mcpServerId));
	const { data } = api.mcp.get.useQuery(
		{ mcpServerId: mcpServerId || "" },
		{ enabled: Boolean(mcpServerId) && open },
	);
	const createMutation = api.mcp.create.useMutation();
	const updateMutation = api.mcp.update.useMutation();
	const isLoading = mcpServerId
		? updateMutation.isLoading
		: createMutation.isLoading;

	const form = useForm<Schema>({
		resolver: zodResolver(Schema),
		defaultValues: emptyValues(),
	});
	const transport = useWatch({ control: form.control, name: "transport" });
	const headers = useFieldArray({ control: form.control, name: "headers" });
	const env = useFieldArray({ control: form.control, name: "env" });

	useEffect(() => {
		if (!open) return;
		if (mcpServerId && data) {
			form.reset(valuesFromServer(data));
			setSlugTouched(true);
			return;
		}
		if (!mcpServerId) {
			form.reset(emptyValues());
			setSlugTouched(false);
		}
	}, [open, data, form, mcpServerId]);

	const onSubmit = async (values: Schema) => {
		try {
			const payload = toApiInput(values);
			if (mcpServerId) {
				await updateMutation.mutateAsync({
					...payload,
					mcpServerId,
				});
			} else {
				await createMutation.mutateAsync(payload);
			}
			await utils.mcp.list.invalidate();
			toast.success("MCP server saved successfully");
			setOpen(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			setError(message);
			toast.error("Failed to save MCP server", { description: message });
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{mcpServerId ? (
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
						Add MCP Server
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{mcpServerId ? "Edit MCP Server" : "Add MCP Server"}
					</DialogTitle>
					<DialogDescription>
						Configure an MCP server that stages can attach by slug
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
											placeholder="Security Context"
											{...field}
											onChange={(event) => {
												field.onChange(event);
												if (!slugTouched) {
													form.setValue(
														"slug",
														slugFromName(event.target.value),
														{ shouldValidate: true },
													);
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
											placeholder="securitycontext"
											{...field}
											onChange={(event) => {
												setSlugTouched(true);
												field.onChange(event);
											}}
										/>
									</FormControl>
									<FormDescription>
										Used in stage YAML as runtime.mcp
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
											placeholder="Optional notes"
											className="min-h-16"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="transport"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Transport</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select a transport" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="http">HTTP</SelectItem>
											<SelectItem value="sse">SSE (Claude only)</SelectItem>
											<SelectItem value="stdio">Stdio</SelectItem>
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						{transport === "stdio" ? (
							<>
								<FormField
									control={form.control}
									name="command"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Command</FormLabel>
											<FormControl>
												<Input placeholder="npx" {...field} />
											</FormControl>
											<FormDescription>
												Runs inside the scan sandbox
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="argsText"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Arguments</FormLabel>
											<FormControl>
												<Textarea
													placeholder={"-y\n@example/mcp-server"}
													className="min-h-20 font-mono text-xs"
													{...field}
												/>
											</FormControl>
											<FormDescription>One argument per line</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="space-y-2">
									<div className="flex items-center justify-between">
										<FormLabel>Environment</FormLabel>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => env.append({ name: "", value: "" })}
										>
											Add
										</Button>
									</div>
									{env.fields.map((item, index) => (
										<div key={item.id} className="flex gap-2">
											<Input
												placeholder="NAME"
												{...form.register(`env.${index}.name`)}
											/>
											<Input
												placeholder="value"
												{...form.register(`env.${index}.value`)}
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												onClick={() => env.remove(index)}
											>
												<Trash2 className="size-4" />
											</Button>
										</div>
									))}
								</div>
							</>
						) : (
							<>
								<FormField
									control={form.control}
									name="url"
									render={({ field }) => (
										<FormItem>
											<FormLabel>URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://securitycontext.dev/mcp"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="space-y-2">
									<div className="flex items-center justify-between">
										<FormLabel>Headers</FormLabel>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => headers.append({ name: "", value: "" })}
										>
											Add
										</Button>
									</div>
									{headers.fields.map((item, index) => (
										<div key={item.id} className="flex gap-2">
											<Input
												placeholder="Authorization"
												{...form.register(`headers.${index}.name`)}
											/>
											<Input
												placeholder="Bearer …"
												{...form.register(`headers.${index}.value`)}
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												onClick={() => headers.remove(index)}
											>
												<Trash2 className="size-4" />
											</Button>
										</div>
									))}
								</div>
							</>
						)}
						<FormField
							control={form.control}
							name="isEnabled"
							render={({ field }) => (
								<FormItem className="flex items-center justify-between rounded-lg border p-3">
									<div>
										<FormLabel>Enabled</FormLabel>
										<FormDescription>
											Disabled servers are skipped at session start
										</FormDescription>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>
						<Button type="submit" className="w-full" isLoading={isLoading}>
							Save
						</Button>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
