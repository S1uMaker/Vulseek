import { Check, ChevronsUpDown, X } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

export type McpOption = {
	name: string;
	description?: string;
};

export type McpMultiSelectProps = {
	value?: string[];
	onChange: (mcp: string[]) => void;
	readOnly?: boolean;
	placeholder?: string;
};

const EMPTY_MCP: string[] = [];

const uniqueNames = (values: string[]) => {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const value of values) {
		const name = value.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
};

export const McpMultiSelect = ({
	value = EMPTY_MCP,
	onChange,
	readOnly = false,
	placeholder = "Search MCP servers…",
}: McpMultiSelectProps) => {
	const [open, setOpen] = React.useState(false);
	const catalog = api.pipeline.runtimeCatalog.useQuery();
	const selected = React.useMemo(() => uniqueNames(value), [value]);
	const options = React.useMemo(() => {
		const byName = new Map<string, McpOption>();
		for (const server of catalog.data?.mcp ?? []) {
			byName.set(server.name, server);
		}
		for (const name of selected) {
			if (!byName.has(name)) byName.set(name, { name });
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}, [catalog.data?.mcp, selected]);

	const toggle = (name: string) => {
		if (readOnly) return;
		onChange(
			selected.includes(name)
				? selected.filter((item) => item !== name)
				: [...selected, name],
		);
	};

	return (
		<div className="space-y-2">
			{selected.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{selected.map((name) => (
						<Badge
							key={name}
							variant="secondary"
							className="gap-1 pr-1 font-normal"
						>
							{name}
							{readOnly ? null : (
								<button
									type="button"
									aria-label={`Remove ${name}`}
									className="rounded-sm p-0.5 hover:bg-muted"
									onClick={() => toggle(name)}
								>
									<X className="h-3 w-3" />
								</button>
							)}
						</Badge>
					))}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					No MCP servers selected.
				</p>
			)}
			{readOnly ? null : (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						{/* biome-ignore lint/a11y/useSemanticElements: same combobox trigger as SkillMultiSelect */}
						<Button
							type="button"
							variant="outline"
							role="combobox"
							aria-expanded={open}
							className="h-8 w-full justify-between px-2 text-xs font-normal"
						>
							<span className="truncate text-muted-foreground">
								{selected.length > 0
									? `${selected.length} MCP server${selected.length === 1 ? "" : "s"} selected`
									: placeholder}
							</span>
							<ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
						</Button>
					</PopoverTrigger>
					<PopoverContent
						className="w-[var(--radix-popover-trigger-width)] p-0"
						align="start"
					>
						<Command>
							<CommandInput placeholder={placeholder} className="h-9" />
							<CommandList>
								<CommandEmpty>
									{catalog.isLoading
										? "Loading MCP servers…"
										: "No MCP servers found."}
								</CommandEmpty>
								<CommandGroup>
									{options.map((server) => {
										const checked = selected.includes(server.name);
										return (
											<CommandItem
												key={server.name}
												value={`${server.name} ${server.description ?? ""}`}
												onSelect={() => toggle(server.name)}
											>
												<Check
													className={cn(
														"mr-2 h-3.5 w-3.5",
														checked ? "opacity-100" : "opacity-0",
													)}
												/>
												<span className="flex min-w-0 flex-col">
													<span>{server.name}</span>
													{server.description ? (
														<span className="truncate text-xs text-muted-foreground">
															{server.description}
														</span>
													) : null}
												</span>
											</CommandItem>
										);
									})}
								</CommandGroup>
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
};
