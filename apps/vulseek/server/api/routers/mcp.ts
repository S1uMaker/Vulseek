import { TRPCError } from "@trpc/server";
import {
	apiCreateMcpServer,
	apiUpdateMcpServer,
} from "@vulseek/server/db/schema/mcp";
import {
	createMcpServer,
	deleteMcpServer,
	getMcpServerById,
	listMcpServers,
	updateMcpServer,
} from "@vulseek/server/services/mcp";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";

export const mcpRouter = createTRPCRouter({
	list: protectedProcedure.query(async ({ ctx }) => {
		return await listMcpServers(ctx.session.activeOrganizationId);
	}),

	get: protectedProcedure
		.input(z.object({ mcpServerId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const server = await getMcpServerById(input.mcpServerId);
			if (server.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this MCP server",
				});
			}
			return server;
		}),

	create: adminProcedure
		.input(apiCreateMcpServer)
		.mutation(async ({ ctx, input }) => {
			return await createMcpServer(ctx.session.activeOrganizationId, input);
		}),

	update: protectedProcedure
		.input(apiUpdateMcpServer)
		.mutation(async ({ ctx, input }) => {
			const { mcpServerId, ...values } = input;
			return await updateMcpServer(
				ctx.session.activeOrganizationId,
				mcpServerId,
				values,
			);
		}),

	delete: protectedProcedure
		.input(z.object({ mcpServerId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			return await deleteMcpServer(
				ctx.session.activeOrganizationId,
				input.mcpServerId,
			);
		}),
});
