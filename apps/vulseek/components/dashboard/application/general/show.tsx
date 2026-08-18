import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Ban, GitBranch, Shield, Telescope, Terminal } from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { toast } from "sonner";
import { ShowBuildChooseForm } from "@/components/dashboard/application/build/show";
import { ShowProviderForm } from "@/components/dashboard/application/general/generic/show";
import { CheckoutImageAction } from "@/components/dashboard/scanning/checkout-image-action";
import { RunPipelineDialog } from "@/components/dashboard/pipelines/run-pipeline-dialog";
import { scanT } from "@/components/dashboard/scanning/scan-i18n";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { DockerTerminalModal } from "../../settings/web-server/docker-terminal-modal";

interface Props {
	applicationId: string;
}

const SCAN_BUTTON_CLASS_NAME =
	"flex items-center gap-1.5 border border-black bg-black text-white hover:bg-black/90 focus-visible:ring-2 focus-visible:ring-offset-2 dark:border-white dark:bg-white dark:text-black dark:hover:bg-white/90";

export const ShowGeneralApplication = ({ applicationId }: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const { data, refetch } = api.application.one.useQuery(
		{
			applicationId,
		},
		{ enabled: !!applicationId },
	);
	const { refetch: refetchScanJobs } = api.scan.listByApplication.useQuery(
		{
			applicationId,
		},
		{
			enabled: !!applicationId,
		},
	);
	const { mutateAsync: update } = api.application.update.useMutation();
	const { mutateAsync: stop, isLoading: isStopping } =
		api.application.stop.useMutation();
	return (
		<>
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">
						{scanT(t, "scan.actions.title", "Actions")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-row gap-4 flex-wrap">
					<CheckoutImageAction
						target={{ applicationId }}
						onCheckoutComplete={async () => {
							await refetch();
							await refetchScanJobs();
						}}
					/>
					<RunPipelineDialog
						target={{ type: "application", applicationId }}
						defaultPipelineId={data?.defaultPipelineId ?? null}
					/>
				</CardContent>
			</Card>
			<ShowProviderForm applicationId={applicationId} />
			<ShowBuildChooseForm applicationId={applicationId} />
		</>
	);
};
