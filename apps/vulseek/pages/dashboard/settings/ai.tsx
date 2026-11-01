import { createServerSideHelpers } from "@trpc/react-query/server";
import { validateRequest } from "@vulseek/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { AgentProfilesForm } from "@/components/dashboard/settings/agent-profiles-form";
import { AiForm } from "@/components/dashboard/settings/ai-form";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { appRouter } from "@/server/api/root";
import { getLocale, serverSideTranslations } from "@/utils/i18n";

const Page = () => {
	return (
		<div className="flex flex-col gap-4 w-full">
			<div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
				<p className="font-medium text-foreground">
					How Agent Profiles, Runtime profiles, and Pipelines fit together
				</p>
				<p className="mt-1">
					An Agent Profile (below) defines how an agent authenticates and runs
					inside a scan sandbox container — provider, credentials, model, and
					thinking level. Each pipeline's Runtime profiles (configured in the
					Profiles view of that pipeline) assign an Agent Profile and
					concurrency to every stage. Starting a scan freezes those choices into
					the job.
				</p>
			</div>
			<AgentProfilesForm />
			<AiForm />
		</div>
	);
};

export default Page;

Page.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	const { req, res } = ctx;
	const { user, session } = await validateRequest(req);
	const locale = getLocale(req.cookies);

	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});

	await helpers.settings.isCloud.prefetch();

	await helpers.user.get.prefetch();

	if (!user || user.role === "member") {
		return {
			redirect: {
				permanent: true,
				destination: "/",
			},
		};
	}
	return {
		props: {
			trpcState: helpers.dehydrate(),
			...(await serverSideTranslations(locale, ["settings"])),
		},
	};
}
