"use client";

import { BlocksIcon, Loader2, Trash2 } from "lucide-react";
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
import { HandleMcpServer } from "./handle-mcp-server";

const TRANSPORT_LABEL: Record<string, string> = {
	http: "HTTP",
	sse: "SSE",
	stdio: "Stdio",
};

export const McpServersForm = () => {
	const { data: servers, refetch, isLoading } = api.mcp.list.useQuery();
	const { mutateAsync, isLoading: isRemoving } = api.mcp.delete.useMutation();

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row gap-2 justify-between">
						<div>
							<CardTitle className="text-xl flex flex-row gap-2">
								<BlocksIcon className="size-6 text-muted-foreground self-center" />
								MCP Servers
							</CardTitle>
							<CardDescription>
								Manage MCP servers attached to scan stages by slug
							</CardDescription>
						</div>
						{servers && servers.length > 0 && <HandleMcpServer />}
					</CardHeader>
					<CardContent className="space-y-2 py-8 border-t">
						{isLoading ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : servers?.length === 0 ? (
							<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center">
								<BlocksIcon className="size-8 self-center text-muted-foreground" />
								<span className="text-base text-muted-foreground text-center">
									You don't have any MCP servers
								</span>
								<HandleMcpServer />
							</div>
						) : (
							<div className="flex flex-col gap-4 rounded-lg min-h-[25vh]">
								{servers?.map((server) => (
									<div
										key={server.mcpServerId}
										className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
									>
										<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full gap-4">
											<div className="min-w-0">
												<span className="text-sm font-medium">
													{server.name}
												</span>
												<CardDescription className="break-all">
													{server.slug}
													{" · "}
													{TRANSPORT_LABEL[server.transport] ??
														server.transport}
													{" · "}
													{server.transport === "stdio"
														? server.command || "stdio"
														: server.url || "no url"}
													{" · "}
													{server.isEnabled ? "enabled" : "disabled"}
												</CardDescription>
											</div>
											<div className="flex justify-between items-center shrink-0">
												<HandleMcpServer mcpServerId={server.mcpServerId} />
												<DialogAction
													title="Delete MCP Server"
													description="Are you sure you want to delete this MCP server? Stages that still reference its slug will fail at launch."
													type="destructive"
													onClick={async () => {
														await mutateAsync({
															mcpServerId: server.mcpServerId,
														})
															.then(() => {
																toast.success(
																	"MCP server deleted successfully",
																);
																refetch();
															})
															.catch(() => {
																toast.error("Error deleting MCP server");
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
		</div>
	);
};
