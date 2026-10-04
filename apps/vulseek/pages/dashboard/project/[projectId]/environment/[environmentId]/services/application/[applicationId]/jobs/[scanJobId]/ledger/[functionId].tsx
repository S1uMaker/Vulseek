import { validateRequest } from "@vulseek/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowScanLedgerDetail } from "@/components/dashboard/scanning/show-scan-ledger-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { getLocale, serverSideTranslations } from "@/utils/i18n";

const Page = () => <ShowScanLedgerDetail />;

export default Page;

Page.getLayout = function getLayout(page: ReactElement) {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(context: GetServerSidePropsContext) {
	const session = await validateRequest(context.req);
	if (!session.user) {
		return { redirect: { destination: "/", permanent: false } };
	}
	const { projectId, environmentId, applicationId, scanJobId, functionId } =
		context.params || {};
	if (
		typeof projectId !== "string" ||
		typeof environmentId !== "string" ||
		typeof applicationId !== "string" ||
		typeof scanJobId !== "string" ||
		typeof functionId !== "string"
	) {
		return { notFound: true };
	}
	return {
		props: {
			...(await serverSideTranslations(getLocale(context.req.cookies), [
				"common",
				"scan",
			])),
		},
	};
}
