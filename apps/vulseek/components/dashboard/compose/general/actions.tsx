import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Ban, GitBranch, Shield, Telescope, Terminal } from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { toast } from "sonner";
import { CheckoutImageAction } from "@/components/dashboard/scanning/checkout-image-action";
import { RunPipelineDialog } from "@/components/dashboard/pipelines/run-pipeline-dialog";
import { scanT } from "@/components/dashboard/scanning/scan-i18n";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { DockerTerminalModal } from "../../settings/web-server/docker-terminal-modal";

interface Props {
	composeId: string;
}

const SCAN_BUTTON_CLASS_NAME =
	"flex items-center gap-1.5 border border-black bg-black text-white hover:bg-black/90 focus-visible:ring-2 focus-visible:ring-offset-2 dark:border-white dark:bg-white dark:text-black dark:hover:bg-white/90";

export const ComposeActions = ({ composeId }: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const { data, refetch } = api.compose.one.useQuery(
		{
			composeId,
		},
		{ enabled: !!composeId },
	);
	const { refetch: refetchScanJobs } = api.scan.listByCompose.useQuery(
		{
			composeId,
		},
		{
			enabled: !!composeId,
		},
	);
	const { mutateAsync: update } = api.compose.update.useMutation();
	const { mutateAsync: stop, isLoading: isStopping } =
		api.compose.stop.useMutation();
	return (
		<>
			<div className="flex flex-row gap-4 w-full flex-wrap ">
				<CheckoutImageAction
					target={{ composeId }}
					onCheckoutComplete={async () => {
						await refetch();
						await refetchScanJobs();
					}}
				/>
				<RunPipelineDialog
					target={{ type: "compose", composeId }}
				/>
				<DockerTerminalModal
					appName={data?.appName || ""}
					serverId={data?.serverId || ""}
					appType={data?.composeType || "docker-compose"}
				>
					<Button
						variant="outline"
						className="flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						<Terminal className="size-4 mr-1" />
						{scanT(t, "scan.actions.openTerminal", "Open Terminal")}
					</Button>
				</DockerTerminalModal>
			</div>
		</>
	);
};
