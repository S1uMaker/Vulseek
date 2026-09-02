"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { CopyIcon, PenBoxIcon, PlusIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
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

const Schema = z
	.object({
		name: z.string().min(1, { message: "Name is required" }),
		provider: z.enum(["codex", "claude_code", "grok_build"]),
		authMode: z.enum(["api_key", "host_home"]),
		homePath: z.string(),
		baseUrl: z.string().url({ message: "Please enter a valid URL" }),
		apiKey: z.string(),
		model: z.string().min(1, { message: "Model is required" }),
		thinkingLevel: z.string().min(1, { message: "Thinking level is required" }),
		thinkingLevelEnabled: z.boolean(),
		envs: z.string(),
		isEnabled: z.boolean(),
	})
	.superRefine((value, ctx) => {
		if (value.authMode === "host_home" && !value.homePath.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["homePath"],
				message: "Home path is required",
			});
		}
	});

type Schema = z.infer<typeof Schema>;

const emptyProfileValues = (): Schema => ({
	name: "",
	provider: "codex",
	authMode: "api_key",
	homePath: "",
	baseUrl: "https://api.openai.com/v1",
	apiKey: "",
	model: "gpt-5.4",
	thinkingLevel: "medium",
	thinkingLevelEnabled: true,
	envs: "",
	isEnabled: true,
});

const valuesFromProfile = (
	source: Partial<Schema> & { name: string },
	name: string,
): Schema => ({
	name,
	provider: source.provider ?? "codex",
	authMode: source.authMode ?? "api_key",
	homePath: source.homePath ?? "",
	baseUrl: source.baseUrl ?? "https://api.openai.com/v1",
	apiKey: source.apiKey ?? "",
	model: source.model ?? "gpt-5.4",
	thinkingLevel: source.thinkingLevel ?? "medium",
	thinkingLevelEnabled: source.thinkingLevelEnabled ?? true,
	envs: source.envs ?? "",
	isEnabled: source.isEnabled ?? true,
});

const applyProviderDefaults = (
	form: ReturnType<typeof useForm<Schema>>,
	provider: Schema["provider"],
) => {
	if (provider === "claude_code") {
		form.setValue("baseUrl", "https://api.anthropic.com");
		form.setValue("model", "claude-sonnet-4-5");
		return;
	}
	if (provider === "grok_build") {
		form.setValue("baseUrl", "https://api.x.ai/v1");
		form.setValue("model", "grok-4.6");
		form.setValue("thinkingLevel", "high");
		return;
	}
	form.setValue("baseUrl", "https://api.openai.com/v1");
	form.setValue("model", "gpt-5.4");
};

const renderEnvHighlight = (value: string) => {
	const lines = value.length > 0 ? value.split("\n") : [""];

	return lines.map((line, index) => {
		const separatorIndex = line.indexOf("=");
		const hasSeparator = separatorIndex >= 0;
		const key = hasSeparator ? line.slice(0, separatorIndex) : line;
		const envValue = hasSeparator ? line.slice(separatorIndex + 1) : "";

		return (
			<Fragment key={`${index}-${line}`}>
				<span className="font-semibold text-blue-700 dark:text-blue-300">
					{key || " "}
				</span>
				{hasSeparator ? (
					<span className="font-semibold text-foreground">=</span>
				) : null}
				{hasSeparator ? (
					<span className="font-semibold text-rose-700 dark:text-rose-300">
						{envValue || " "}
					</span>
				) : null}
				{index < lines.length - 1 ? "\n" : null}
			</Fragment>
		);
	});
};

interface Props {
	agentProfileId?: string;
	duplicateProfile?: Partial<Schema> & { name: string };
}

export const HandleAgentProfile = ({
	agentProfileId,
	duplicateProfile,
}: Props) => {
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const envTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const envHighlightRef = useRef<HTMLPreElement | null>(null);
	const isDuplicate = Boolean(duplicateProfile);
	const { data, refetch } = api.ai.agentProfileOne.useQuery(
		{
			agentProfileId: agentProfileId || "",
		},
		{
			enabled: !!agentProfileId,
		},
	);

	const { mutateAsync, isLoading } = agentProfileId
		? api.ai.updateAgentProfile.useMutation()
		: api.ai.createAgentProfile.useMutation();

	const form = useForm<Schema>({
		resolver: zodResolver(Schema),
		defaultValues: duplicateProfile
			? valuesFromProfile(duplicateProfile, `${duplicateProfile.name} Copy`)
			: emptyProfileValues(),
	});

	const provider = useWatch({
		control: form.control,
		name: "provider",
	});
	const authMode = useWatch({
		control: form.control,
		name: "authMode",
	});
	const envsValue = useWatch({
		control: form.control,
		name: "envs",
	});
	const thinkingLevelEnabled = useWatch({
		control: form.control,
		name: "thinkingLevelEnabled",
	});
	const envHighlight = useMemo(
		() => renderEnvHighlight(envsValue || ""),
		[envsValue],
	);
	const showEnvPlaceholder = !envsValue;

	useEffect(() => {
		if (duplicateProfile) {
			form.reset(
				valuesFromProfile(duplicateProfile, `${duplicateProfile.name} Copy`),
			);
			return;
		}
		if (!data) return;
		form.reset(valuesFromProfile(data, data.name ?? ""));
	}, [data, duplicateProfile, form]);

	useEffect(() => {
		const textarea = envTextareaRef.current;
		const highlight = envHighlightRef.current;
		if (!textarea || !highlight) return;

		const syncScroll = () => {
			highlight.scrollTop = textarea.scrollTop;
			highlight.scrollLeft = textarea.scrollLeft;
		};

		syncScroll();
		textarea.addEventListener("scroll", syncScroll);
		return () => textarea.removeEventListener("scroll", syncScroll);
	}, [open]);

	const onSubmit = async (values: Schema) => {
		try {
			await mutateAsync({
				...values,
				homePath: values.authMode === "host_home" ? values.homePath.trim() : "",
				agentProfileId: agentProfileId || "",
			});
			await utils.ai.getAgentProfiles.invalidate();
			toast.success("Agent profile saved successfully");
			refetch();
			setOpen(false);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Unknown error");
			toast.error("Failed to save agent profile", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{isDuplicate ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-emerald-500/10"
						aria-label="Duplicate agent profile"
					>
						<CopyIcon className="size-3.5 text-primary group-hover:text-emerald-500" />
					</Button>
				) : agentProfileId ? (
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
						Add Agent Profile
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{isDuplicate
							? "Duplicate Agent Profile"
							: agentProfileId
								? "Edit Agent Profile"
								: "Add Agent Profile"}
					</DialogTitle>
					<DialogDescription>
						Configure a reusable agent runtime profile
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					{error && <AlertBlock type="error">{error}</AlertBlock>}
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Codex Default" {...field} />
									</FormControl>
									<FormDescription>
										A reusable profile name shown in project settings
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="provider"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Agent</FormLabel>
									<Select
										onValueChange={(value) => {
											const next = value as Schema["provider"];
											field.onChange(next);
											if (!agentProfileId) {
												applyProviderDefaults(form, next);
											}
										}}
										value={field.value}
									>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select an agent" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="codex">Codex</SelectItem>
											<SelectItem value="claude_code">Claude Code</SelectItem>
											<SelectItem value="grok_build">Grok Build</SelectItem>
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="authMode"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{provider === "claude_code"
											? "Claude Auth"
											: provider === "grok_build"
												? "Grok Auth"
												: "Codex Auth"}
									</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select auth mode" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="api_key">API Key</SelectItem>
											<SelectItem value="host_home">Host Home</SelectItem>
										</SelectContent>
									</Select>
									<FormDescription>
										Host Home bind-mounts the provider home path below into each
										task container.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						{authMode === "host_home" ? (
							<FormField
								control={form.control}
								name="homePath"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											{provider === "claude_code"
												? "Claude Home Path"
												: provider === "grok_build"
													? "Grok Home Path"
													: "Codex Home Path"}
										</FormLabel>
										<FormControl>
											<Input
												placeholder={
													provider === "claude_code"
														? "/home/user"
														: provider === "grok_build"
															? "/home/user/.grok"
															: "/home/user/.codex"
												}
												{...field}
											/>
										</FormControl>
										<FormDescription>
											{provider === "claude_code"
												? "Absolute host user home path containing settings.json."
												: provider === "grok_build"
													? "Absolute Grok home path containing config.toml and auth.json."
													: "Absolute Codex home path containing auth.json."}
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						) : null}

						{authMode === "api_key" ? (
							<FormField
								control={form.control}
								name="baseUrl"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Base URL</FormLabel>
										<FormControl>
											<Input
												placeholder={
													provider === "grok_build"
														? "https://api.x.ai/v1"
														: provider === "claude_code"
															? "https://api.anthropic.com"
															: "https://api.openai.com/v1"
												}
												{...field}
											/>
										</FormControl>
										<FormDescription>
											Used when Vulseek prepares the agent runtime config
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						) : null}

						{authMode === "api_key" ? (
							<FormField
								control={form.control}
								name="apiKey"
								render={({ field }) => (
									<FormItem>
										<FormLabel>API Key</FormLabel>
										<FormControl>
											<Input
												type="password"
												placeholder={
													provider === "grok_build" ? "xai-..." : "sk-..."
												}
												autoComplete="one-time-code"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						) : (
							<AlertBlock type="info">
								Vulseek will copy this provider home into each task container
								instead of writing an API key.
							</AlertBlock>
						)}

						<FormField
							control={form.control}
							name="model"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Model</FormLabel>
									<FormControl>
										<Input
											placeholder={
												provider === "grok_build" ? "grok-4.6" : "gpt-5.4"
											}
											{...field}
										/>
									</FormControl>
									<FormDescription>
										The model name used by the selected agent runtime
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="thinkingLevelEnabled"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
									<div className="space-y-0.5">
										<FormLabel>Send Thinking Level</FormLabel>
										<FormDescription>
											Pass this value to the agent runtime when the selected
											agent supports it
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

						<FormField
							control={form.control}
							name="thinkingLevel"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Thinking Level</FormLabel>
									<FormControl>
										<Input
											placeholder="medium"
											disabled={!thinkingLevelEnabled}
											{...field}
										/>
									</FormControl>
									<FormDescription>
										Examples: low, medium, high. Saved with the profile even
										when disabled.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="envs"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Environment Variables</FormLabel>
									<FormControl>
										<div className="relative">
											<pre
												ref={envHighlightRef}
												aria-hidden="true"
												className="pointer-events-none min-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-input bg-input px-3 py-2 font-mono text-xs leading-5"
											>
												{showEnvPlaceholder ? (
													<span className="text-muted-foreground">
														{"FOO=bar\nHTTP_PROXY=http://host:port"}
													</span>
												) : (
													envHighlight
												)}
											</pre>
											<Textarea
												placeholder={"FOO=bar\nHTTP_PROXY=http://host:port"}
												className="absolute inset-0 min-h-[120px] resize-y overflow-auto border-transparent bg-transparent font-mono text-xs leading-5 text-transparent caret-foreground selection:bg-primary/30 focus-visible:ring-2 focus-visible:ring-border"
												{...field}
												ref={(element) => {
													field.ref(element);
													envTextareaRef.current = element;
												}}
												spellCheck={false}
											/>
										</div>
									</FormControl>
									<FormDescription>
										One <code>KEY=VALUE</code> per line. These env vars are
										injected into the agent runtime container.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="isEnabled"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
									<div className="space-y-0.5">
										<FormLabel>Enabled</FormLabel>
										<FormDescription>
											Disabled profiles stay saved but cannot be selected
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

						<div className="flex justify-end">
							<Button isLoading={isLoading} type="submit">
								Save
							</Button>
						</div>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
