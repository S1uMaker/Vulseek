import http from "node:http";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	IS_CLOUD,
	initCancelDeployments,
	initCronJobs,
	initializeNetwork,
	initSchedules,
	initVolumeBackupsCronJobs,
	recoverPendingFullScanQueues,
	sendVulseekRestartNotifications,
	setupDirectories,
	syncContainerEnvironmentSettingToProcess,
} from "@vulseek/server";
import { config } from "dotenv";
import next from "next";
import { migration } from "@/server/db/migration";
import { exitOnStartupError } from "./startup-error";
import { initAutoDeltaScanPolling } from "./utils/auto-delta-scan";
import { setupDockerContainerLogsWebSocketServer } from "./wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "./wss/docker-container-terminal";
import { setupDockerStatsMonitoringSocketServer } from "./wss/docker-stats";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";
import { setupScanStatsMonitoringSocketServer } from "./wss/scan-stats";
import { setupTerminalWebSocketServer } from "./wss/terminal";

config({ path: ".env" });
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, turbopack: process.env.TURBOPACK === "1" });
const handle = app.getRequestHandler();
void app.prepare().then(async () => {
	try {
		const server = http.createServer((req, res) => {
			handle(req, res);
		});

		// WEBSOCKET
		setupDrawerLogsWebSocketServer(server);
		setupDeploymentLogsWebSocketServer(server);
		setupDockerContainerLogsWebSocketServer(server);
		setupDockerContainerTerminalWebSocketServer(server);
		setupTerminalWebSocketServer(server);
		if (!IS_CLOUD) {
			setupDockerStatsMonitoringSocketServer(server);
			setupScanStatsMonitoringSocketServer(server);
		}

		if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
			setupDirectories();
			createDefaultMiddlewares();
			await initializeNetwork();
			createDefaultTraefikConfig();
			createDefaultServerTraefikConfig();
			await migration();
			await syncContainerEnvironmentSettingToProcess();
			await initCronJobs();
			await initSchedules();
			await initCancelDeployments();
			await initVolumeBackupsCronJobs();
			await sendVulseekRestartNotifications();
		}

		if (IS_CLOUD && process.env.NODE_ENV === "production") {
			await migration();
			await syncContainerEnvironmentSettingToProcess();
		}

		if (process.env.NODE_ENV !== "production") {
			await migration();
			await syncContainerEnvironmentSettingToProcess();
		}

		// Organization system pipelines: seed built-ins only when an org has
		// no matching pipeline. Existing rows stay on the published DB version.
		try {
			const { seedAllOrganizationsBuiltinPipelines, backfillProfileDefaultPipelines } =
				await import("@vulseek/server/services/pipeline-system");
			await seedAllOrganizationsBuiltinPipelines();
			await backfillProfileDefaultPipelines();
		} catch (error) {
			console.log(
				"[pipeline-system]",
				JSON.stringify({
					event: "seed.failed",
					errorMessage: error instanceof Error ? error.message : String(error),
				}),
			);
		}

		server.listen(PORT, HOST);
		console.log(`Server Started on: http://${HOST}:${PORT}`);
		if (!IS_CLOUD) {
			console.log("Starting Deployment Worker");
			const { deploymentWorker } = await import("./queues/deployments-queue");
			void deploymentWorker.run();
			console.log("Recovering Full Scan Queues");
			await recoverPendingFullScanQueues();
			console.log("Starting Scans Worker");
			const { scansWorker } = await import("./queues/scans-queue");
			void scansWorker.run();
			console.log("Starting Dataset Evaluations Worker");
			const { datasetEvaluationsWorker, recoverPendingDatasetEvaluations } = await import(
				"./queues/dataset-evaluations-queue"
			);
			await recoverPendingDatasetEvaluations();
			void datasetEvaluationsWorker.run();
			console.log("Starting Auto Delta Scan Polling");
			await initAutoDeltaScanPolling();
		}
	} catch (e) {
		exitOnStartupError(e);
	}
});
