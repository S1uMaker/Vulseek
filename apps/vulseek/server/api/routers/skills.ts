import { TRPCError } from "@trpc/server";
import {
	apiCreateSkill,
	apiCreateSkillFile,
	apiSkillDirectory,
	apiSkillFilePath,
	apiSkillId,
	apiUpdateSkill,
	apiWriteSkillFile,
} from "@vulseek/server/db/schema/skills";
import {
	createSkill,
	createSkillFile,
	deleteSkill,
	deleteSkillFile,
	getSkillById,
	listSkillDirectory,
	listSkills,
	readSkillFile,
	updateSkill,
	writeSkillFile,
} from "@vulseek/server/services/skills";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";

const assertOrg = (skillOrganizationId: string, organizationId: string) => {
	if (skillOrganizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this skill",
		});
	}
};

export const skillsRouter = createTRPCRouter({
	list: protectedProcedure.query(async ({ ctx }) => {
		return await listSkills(ctx.session.activeOrganizationId);
	}),

	get: protectedProcedure.input(apiSkillId).query(async ({ ctx, input }) => {
		const skill = await getSkillById(input.skillId);
		assertOrg(skill.organizationId, ctx.session.activeOrganizationId);
		return skill;
	}),

	create: adminProcedure.input(apiCreateSkill).mutation(async ({ ctx, input }) => {
		return await createSkill(ctx.session.activeOrganizationId, input);
	}),

	update: protectedProcedure
		.input(apiUpdateSkill)
		.mutation(async ({ ctx, input }) => {
			const { skillId, ...values } = input;
			return await updateSkill(
				ctx.session.activeOrganizationId,
				skillId,
				values,
			);
		}),

	delete: protectedProcedure
		.input(apiSkillId)
		.mutation(async ({ ctx, input }) => {
			return await deleteSkill(ctx.session.activeOrganizationId, input.skillId);
		}),

	listDirectory: protectedProcedure
		.input(apiSkillDirectory)
		.query(async ({ ctx, input }) => {
			return await listSkillDirectory({
				organizationId: ctx.session.activeOrganizationId,
				skillId: input.skillId,
				directoryPath: input.directoryPath,
			});
		}),

	readFile: protectedProcedure
		.input(apiSkillFilePath)
		.query(async ({ ctx, input }) => {
			return await readSkillFile({
				organizationId: ctx.session.activeOrganizationId,
				skillId: input.skillId,
				filePath: input.filePath,
			});
		}),

	writeFile: protectedProcedure
		.input(apiWriteSkillFile)
		.mutation(async ({ ctx, input }) => {
			return await writeSkillFile({
				organizationId: ctx.session.activeOrganizationId,
				skillId: input.skillId,
				filePath: input.filePath,
				content: input.content,
			});
		}),

	createFile: protectedProcedure
		.input(apiCreateSkillFile)
		.mutation(async ({ ctx, input }) => {
			return await createSkillFile({
				organizationId: ctx.session.activeOrganizationId,
				skillId: input.skillId,
				filePath: input.filePath,
				content: input.content,
				directory: input.directory,
			});
		}),

	deleteFile: protectedProcedure
		.input(apiSkillFilePath)
		.mutation(async ({ ctx, input }) => {
			return await deleteSkillFile({
				organizationId: ctx.session.activeOrganizationId,
				skillId: input.skillId,
				filePath: input.filePath,
			});
		}),
});
