import type { ReactElement } from "react";
import { ShowScanLedgerDetail } from "@/components/dashboard/scanning/show-scan-ledger-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const Page = () => <ShowScanLedgerDetail />;

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
