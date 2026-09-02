import {
	type AgentTaskRuntime,
	docker,
	findAgentTaskRuntimeByTaskId,
	findRunningAgentTaskRuntimesByScanJobId,
	listRunningScanJobsByOrganizationId,
	driverStdoutTailReader,
} from "@vulseek/server";

const SAMPLE_INTERVAL_MS = 1300;
const RECONCILE_INTERVAL_MS = 5000;
const DISPOSE_GRACE_MS = 10_000;
const CONTAINER_CACHE_TTL_MS = 1000;

export type ScanStatsContainer = {
	containerId: string;
	containerName: string;
	taskId?: string;
	status: "running";
};

type DockerMetrics = {
	cpu: { percent: number; capacityPercent: number };
	memory: { usedBytes: number; limitBytes: number; percent: number };
	block: { readBytes: number; writeBytes: number };
	network: { rxBytes: number; txBytes: number };
};

type TokenSnapshot = {
	timestampMs: number;
	totalTokens: number;
	cachedReadTokens: number;
	tasks: Array<{
		taskId: string;
		label: string;
		totalTokens: number;
		cachedReadTokens: number;
	}>;
};

export type ScanMonitoringSample = DockerMetrics & {
	time: string;
	runningContainerCount: number;
	containers: ScanStatsContainer[];
	tokenSnapshot: TokenSnapshot;
	activeJobCount: number;
};

type TaskSnapshot = {
	taskId: string;
	taskKind: AgentTaskRuntime["taskKind"];
	container: ScanStatsContainer | null;
	metrics: DockerMetrics;
	totalTokens: number;
	cachedReadTokens: number;
};

type Listener<T> = (snapshot: T) => void;

type Subscription = {
	release: () => void;
};

const emptyMetrics = (): DockerMetrics => ({
	cpu: { percent: 0, capacityPercent: 100 },
	memory: { usedBytes: 0, limitBytes: 0, percent: 0 },
	block: { readBytes: 0, writeBytes: 0 },
	network: { rxBytes: 0, txBytes: 0 },
});

const emptyTokenSnapshot = (): TokenSnapshot => ({
	timestampMs: Date.now(),
	totalTokens: 0,
	cachedReadTokens: 0,
	tasks: [],
});

const emptySample = (activeJobCount = 0): ScanMonitoringSample => ({
	...emptyMetrics(),
	time: new Date().toISOString(),
	runningContainerCount: 0,
	containers: [],
	tokenSnapshot: emptyTokenSnapshot(),
	activeJobCount,
});

const addMetrics = (target: DockerMetrics, source: DockerMetrics) => {
	target.cpu.percent += source.cpu.percent;
	target.memory.usedBytes += source.memory.usedBytes;
	target.memory.limitBytes += source.memory.limitBytes;
	target.block.readBytes += source.block.readBytes;
	target.block.writeBytes += source.block.writeBytes;
	target.network.rxBytes += source.network.rxBytes;
	target.network.txBytes += source.network.txBytes;
};

const finalizeMetrics = (metrics: DockerMetrics) => {
	metrics.memory.percent =
		metrics.memory.limitBytes > 0
			? (metrics.memory.usedBytes / metrics.memory.limitBytes) * 100
			: 0;
	return metrics;
};

const parseDockerStats = (raw: any): DockerMetrics => {
	const cpuDelta =
		Number(raw.cpu_stats?.cpu_usage?.total_usage || 0) -
		Number(raw.precpu_stats?.cpu_usage?.total_usage || 0);
	const systemDelta =
		Number(raw.cpu_stats?.system_cpu_usage || 0) -
		Number(raw.precpu_stats?.system_cpu_usage || 0);
	const onlineCpus = Number(raw.cpu_stats?.online_cpus || 1) || 1;
	const cpuPercent =
		systemDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;
	const memoryUsed = Number(raw.memory_stats?.usage || 0);
	const memoryLimit = Number(raw.memory_stats?.limit || 0);
	const block = { readBytes: 0, writeBytes: 0 };
	for (const item of raw.blkio_stats?.io_service_bytes_recursive || []) {
		if (String(item.op).toLowerCase() === "read")
			block.readBytes += Number(item.value || 0);
		if (String(item.op).toLowerCase() === "write")
			block.writeBytes += Number(item.value || 0);
	}
	let rxBytes = 0;
	let txBytes = 0;
	for (const network of Object.values(raw.networks || {}) as any[]) {
		rxBytes += Number(network.rx_bytes || 0);
		txBytes += Number(network.tx_bytes || 0);
	}
	return finalizeMetrics({
		cpu: { percent: cpuPercent, capacityPercent: onlineCpus * 100 },
		memory: {
			usedBytes: memoryUsed,
			limitBytes: memoryLimit,
			percent: memoryLimit > 0 ? (memoryUsed / memoryLimit) * 100 : 0,
		},
		block,
		network: { rxBytes, txBytes },
	});
};

class ContainerStatsCache {
	private readonly entries = new Map<
		string,
		{ expiresAt: number; promise: Promise<DockerMetrics> }
	>();

	get(containerName: string): Promise<DockerMetrics> {
		const existing = this.entries.get(containerName);
		if (existing && existing.expiresAt > Date.now()) return existing.promise;
		const promise = docker
			.getContainer(containerName)
			.stats({ stream: false })
			.then(parseDockerStats)
			.catch(() => emptyMetrics());
		this.entries.set(containerName, {
			expiresAt: Date.now() + CONTAINER_CACHE_TTL_MS,
			promise,
		});
		return promise;
	}

	clear() {
		this.entries.clear();
	}
}

class TaskSampler {
	private readonly listeners = new Set<Listener<TaskSnapshot>>();
	private timer?: NodeJS.Timeout;
	private disposeTimer?: NodeJS.Timeout;
	private sampling = false;
	private snapshot: TaskSnapshot | null = null;

	constructor(
		private readonly runtime: AgentTaskRuntime,
		private readonly containerStats: ContainerStatsCache,
		private readonly onDisposed: () => void,
	) {}

	subscribe(listener: Listener<TaskSnapshot>): Subscription {
		if (this.disposeTimer) clearTimeout(this.disposeTimer);
		this.disposeTimer = undefined;
		this.listeners.add(listener);
		if (this.snapshot) listener(this.snapshot);
		if (!this.timer) {
			void this.sample();
			this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
		}
		return { release: () => this.release(listener) };
	}

	private release(listener: Listener<TaskSnapshot>) {
		this.listeners.delete(listener);
		if (this.listeners.size > 0 || this.disposeTimer) return;
		this.disposeTimer = setTimeout(() => {
			if (this.listeners.size === 0) this.stop();
		}, DISPOSE_GRACE_MS);
	}

	private stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.snapshot = null;
		this.onDisposed();
	}

	private async sample() {
		if (this.sampling) return;
		this.sampling = true;
		try {
			const protocol = await driverStdoutTailReader.read(
				this.runtime.stdoutPath,
			);
			const occupancy =
				protocol.latestUsage &&
				typeof protocol.latestUsage === "object" &&
				typeof (protocol.latestUsage as { used?: unknown }).used === "number"
					? (protocol.latestUsage as { used: number }).used
					: 0;
			const container = this.runtime.containerName
				? {
						containerId: this.runtime.containerName,
						containerName: this.runtime.containerName,
						taskId: this.runtime.taskId,
						status: "running" as const,
					}
				: null;
			const metrics = container
				? await this.containerStats.get(container.containerName)
				: emptyMetrics();
			this.snapshot = {
				taskId: this.runtime.taskId,
				taskKind: this.runtime.taskKind,
				container,
				metrics,
				totalTokens: occupancy,
				cachedReadTokens: 0,
			};
			for (const listener of this.listeners) listener(this.snapshot);
		} finally {
			this.sampling = false;
		}
	}
}

class JobSampler {
	private readonly listeners = new Set<Listener<ScanMonitoringSample>>();
	private readonly taskSubscriptions = new Map<string, Subscription>();
	private readonly taskSnapshots = new Map<string, TaskSnapshot>();
	private reconcileTimer?: NodeJS.Timeout;
	private publishTimer?: NodeJS.Timeout;
	private disposeTimer?: NodeJS.Timeout;
	private snapshot: ScanMonitoringSample | null = null;

	constructor(
		private readonly scanJobId: string,
		private readonly taskSamplers: Map<string, TaskSampler>,
		private readonly containerStats: ContainerStatsCache,
		private readonly onDisposed: () => void,
	) {}

	subscribe(listener: Listener<ScanMonitoringSample>): Subscription {
		if (this.disposeTimer) clearTimeout(this.disposeTimer);
		this.disposeTimer = undefined;
		this.listeners.add(listener);
		if (this.snapshot) listener(this.snapshot);
		if (!this.reconcileTimer) {
			void this.reconcile();
			this.reconcileTimer = setInterval(
				() => void this.reconcile(),
				RECONCILE_INTERVAL_MS,
			);
			this.publishTimer = setInterval(() => this.publish(), SAMPLE_INTERVAL_MS);
		}
		return { release: () => this.release(listener) };
	}

	private release(listener: Listener<ScanMonitoringSample>) {
		this.listeners.delete(listener);
		if (this.listeners.size > 0 || this.disposeTimer) return;
		this.disposeTimer = setTimeout(() => {
			if (this.listeners.size === 0) this.stop();
		}, DISPOSE_GRACE_MS);
	}

	private stop() {
		if (this.reconcileTimer) clearInterval(this.reconcileTimer);
		this.reconcileTimer = undefined;
		if (this.publishTimer) clearInterval(this.publishTimer);
		this.publishTimer = undefined;
		for (const subscription of this.taskSubscriptions.values())
			subscription.release();
		this.taskSubscriptions.clear();
		this.taskSnapshots.clear();
		this.snapshot = null;
		this.onDisposed();
	}

	private async reconcile() {
		const runtimes = await findRunningAgentTaskRuntimesByScanJobId(
			this.scanJobId,
		);
		const activeIds = new Set(runtimes.map((runtime) => runtime.taskId));
		for (const runtime of runtimes) {
			if (this.taskSubscriptions.has(runtime.taskId)) continue;
			const sampler =
				this.taskSamplers.get(runtime.taskId) ||
				new TaskSampler(runtime, this.containerStats, () => {
					if (this.taskSamplers.get(runtime.taskId) === sampler) {
						this.taskSamplers.delete(runtime.taskId);
					}
				});
			this.taskSamplers.set(runtime.taskId, sampler);
			const subscription = sampler.subscribe((snapshot) => {
				this.taskSnapshots.set(snapshot.taskId, snapshot);
			});
			this.taskSubscriptions.set(runtime.taskId, subscription);
		}
		for (const [taskId, subscription] of this.taskSubscriptions) {
			if (activeIds.has(taskId)) continue;
			subscription.release();
			this.taskSubscriptions.delete(taskId);
			this.taskSnapshots.delete(taskId);
		}
	}

	private publish() {
		const tasks = [...this.taskSnapshots.values()];
		const metrics = emptyMetrics();
		const containersByName = new Map<string, ScanStatsContainer>();
		for (const task of tasks) {
			if (task.container)
				containersByName.set(task.container.containerName, task.container);
			addMetrics(metrics, task.metrics);
		}
		const containers = [...containersByName.values()];
		const tokenTasks = tasks.map((task) => ({
			taskId: task.taskId,
			label: `${task.taskKind.replace(/_/g, " ")} ${task.taskId.slice(0, 8)}`,
			totalTokens: task.totalTokens,
			cachedReadTokens: task.cachedReadTokens,
		}));
		this.snapshot = {
			...finalizeMetrics(metrics),
			time: new Date().toISOString(),
			runningContainerCount: new Set(
				containers.map((container) => container.containerName),
			).size,
			containers,
			tokenSnapshot: {
				timestampMs: Date.now(),
				totalTokens: tokenTasks.reduce(
					(sum, task) => sum + task.totalTokens,
					0,
				),
				cachedReadTokens: tokenTasks.reduce(
					(sum, task) => sum + task.cachedReadTokens,
					0,
				),
				tasks: tokenTasks,
			},
			activeJobCount: 1,
		};
		for (const listener of this.listeners) listener(this.snapshot);
	}
}

class OrganizationSampler {
	private readonly listeners = new Set<Listener<ScanMonitoringSample>>();
	private readonly jobSubscriptions = new Map<string, Subscription>();
	private readonly jobSnapshots = new Map<string, ScanMonitoringSample>();
	private readonly jobSamplers = new Map<string, JobSampler>();
	private readonly taskSamplers: Map<string, TaskSampler>;
	private readonly containerStats: ContainerStatsCache;
	private reconcileTimer?: NodeJS.Timeout;
	private publishTimer?: NodeJS.Timeout;
	private disposeTimer?: NodeJS.Timeout;
	private snapshot: ScanMonitoringSample | null = null;

	constructor(
		private readonly organizationId: string,
		taskSamplers: Map<string, TaskSampler>,
		containerStats: ContainerStatsCache,
		private readonly onDisposed: () => void,
	) {
		this.taskSamplers = taskSamplers;
		this.containerStats = containerStats;
	}

	subscribe(listener: Listener<ScanMonitoringSample>): Subscription {
		if (this.disposeTimer) clearTimeout(this.disposeTimer);
		this.disposeTimer = undefined;
		this.listeners.add(listener);
		if (this.snapshot) listener(this.snapshot);
		if (!this.reconcileTimer) {
			void this.reconcile();
			this.reconcileTimer = setInterval(
				() => void this.reconcile(),
				RECONCILE_INTERVAL_MS,
			);
			this.publishTimer = setInterval(() => this.publish(), SAMPLE_INTERVAL_MS);
		}
		return { release: () => this.release(listener) };
	}

	private release(listener: Listener<ScanMonitoringSample>) {
		this.listeners.delete(listener);
		if (this.listeners.size > 0 || this.disposeTimer) return;
		this.disposeTimer = setTimeout(() => {
			if (this.listeners.size === 0) this.stop();
		}, DISPOSE_GRACE_MS);
	}

	private stop() {
		if (this.reconcileTimer) clearInterval(this.reconcileTimer);
		this.reconcileTimer = undefined;
		if (this.publishTimer) clearInterval(this.publishTimer);
		this.publishTimer = undefined;
		for (const subscription of this.jobSubscriptions.values())
			subscription.release();
		this.jobSubscriptions.clear();
		this.jobSnapshots.clear();
		this.snapshot = null;
		this.onDisposed();
	}

	private async reconcile() {
		const jobs = await listRunningScanJobsByOrganizationId(this.organizationId);
		const activeIds = new Set(jobs.map((job) => job.scanJobId));
		for (const job of jobs) {
			if (this.jobSubscriptions.has(job.scanJobId)) continue;
			const sampler =
				this.jobSamplers.get(job.scanJobId) ||
				new JobSampler(
					job.scanJobId,
					this.taskSamplers,
					this.containerStats,
					() => this.jobSamplers.delete(job.scanJobId),
				);
			this.jobSamplers.set(job.scanJobId, sampler);
			const subscription = sampler.subscribe((snapshot) => {
				this.jobSnapshots.set(job.scanJobId, snapshot);
			});
			this.jobSubscriptions.set(job.scanJobId, subscription);
		}
		for (const [jobId, subscription] of this.jobSubscriptions) {
			if (activeIds.has(jobId)) continue;
			subscription.release();
			this.jobSubscriptions.delete(jobId);
			this.jobSnapshots.delete(jobId);
		}
	}

	private publish() {
		const jobs = [...this.jobSnapshots.values()];
		const metrics = emptyMetrics();
		const containersByName = new Map<string, ScanStatsContainer>();
		const tasksById = new Map<string, TokenSnapshot["tasks"][number]>();
		for (const job of jobs) {
			for (const container of job.containers) {
				containersByName.set(container.containerName, container);
			}
			for (const task of job.tokenSnapshot.tasks)
				tasksById.set(task.taskId, task);
		}
		const containers = [...containersByName.values()];
		const tasks = [...tasksById.values()];
		for (const job of jobs) addMetrics(metrics, job);
		this.snapshot = {
			...finalizeMetrics(metrics),
			time: new Date().toISOString(),
			runningContainerCount: new Set(
				containers.map((container) => container.containerName),
			).size,
			containers,
			tokenSnapshot: {
				timestampMs: Date.now(),
				totalTokens: tasks.reduce((sum, task) => sum + task.totalTokens, 0),
				cachedReadTokens: tasks.reduce(
					(sum, task) => sum + task.cachedReadTokens,
					0,
				),
				tasks,
			},
			activeJobCount: jobs.length,
		};
		for (const listener of this.listeners) listener(this.snapshot);
	}
}

export class MonitoringHub {
	private readonly taskSamplers = new Map<string, TaskSampler>();
	private readonly jobSamplers = new Map<string, JobSampler>();
	private readonly organizationSamplers = new Map<
		string,
		OrganizationSampler
	>();
	private readonly containerStats = new ContainerStatsCache();

	async acquireTask(
		taskId: string,
		listener: Listener<ScanMonitoringSample>,
	): Promise<Subscription> {
		const existing = this.taskSamplers.get(taskId);
		let sampler = existing;
		if (!sampler) {
			sampler = await findAgentTaskRuntimeByTaskId(taskId).then((runtime) => {
				if (!runtime) throw new Error("Task runtime not found");
				const created = new TaskSampler(runtime, this.containerStats, () => {
					if (this.taskSamplers.get(taskId) === created) {
						this.taskSamplers.delete(taskId);
					}
				});
				this.taskSamplers.set(taskId, created);
				return created;
			});
		}
		if (!sampler) throw new Error("Task sampler was not created");
		return sampler.subscribe((snapshot) =>
			listener(this.taskSnapshotToSample(snapshot)),
		);
	}

	acquireJob(
		scanJobId: string,
		listener: Listener<ScanMonitoringSample>,
	): Subscription {
		const sampler =
			this.jobSamplers.get(scanJobId) ||
			new JobSampler(scanJobId, this.taskSamplers, this.containerStats, () =>
				this.jobSamplers.delete(scanJobId),
			);
		this.jobSamplers.set(scanJobId, sampler);
		return sampler.subscribe(listener);
	}

	acquireOrganization(
		organizationId: string,
		listener: Listener<ScanMonitoringSample>,
	): Subscription {
		const sampler =
			this.organizationSamplers.get(organizationId) ||
			new OrganizationSampler(
				organizationId,
				this.taskSamplers,
				this.containerStats,
				() => this.organizationSamplers.delete(organizationId),
			);
		this.organizationSamplers.set(organizationId, sampler);
		return sampler.subscribe(listener);
	}

	private taskSnapshotToSample(snapshot: TaskSnapshot): ScanMonitoringSample {
		return {
			...snapshot.metrics,
			time: new Date().toISOString(),
			runningContainerCount: snapshot.container ? 1 : 0,
			containers: snapshot.container ? [snapshot.container] : [],
			tokenSnapshot: {
				timestampMs: Date.now(),
				totalTokens: snapshot.totalTokens,
				cachedReadTokens: snapshot.cachedReadTokens,
				tasks: [
					{
						taskId: snapshot.taskId,
						label: `${snapshot.taskKind.replace(/_/g, " ")} ${snapshot.taskId.slice(0, 8)}`,
						totalTokens: snapshot.totalTokens,
						cachedReadTokens: snapshot.cachedReadTokens,
					},
				],
			},
			activeJobCount: 1,
		};
	}
}

export const monitoringHub = new MonitoringHub();
