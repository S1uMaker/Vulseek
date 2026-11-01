import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunPipelineDialog } from "@/components/dashboard/pipelines/run-pipeline-dialog";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	mutateAsync: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
	projectAll: vi.fn(),
}));

vi.mock("next/router", () => ({
	useRouter: () => ({
		push: mocks.push,
		asPath: "/dashboard/project/p/environment/e/profiles/application/app-1",
		query: {},
		pathname:
			"/dashboard/project/[projectId]/environment/[environmentId]/profiles/application/[applicationId]",
		replace: vi.fn(),
		events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
	}),
}));

vi.mock("next-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { defaultValue?: string }) =>
			options?.defaultValue ?? key,
	}),
}));

vi.mock("@/utils/api", () => ({
	api: {
		pipeline: {
			publishedOptions: {
				useQuery: () => ({
					data: [
						{
							pipelineId: "pipe-1",
							name: "orch-hunt",
							currentVersionId: "ver-1",
							currentVersionNumber: 32,
						},
					],
				}),
			},
			listVersions: {
				useQuery: () => ({
					data: [
						{
							pipelineVersionId: "ver-1",
							versionNumber: 32,
						},
					],
				}),
			},
			profilesList: {
				useQuery: () => ({
					data: [
						{
							pipelineProfileId: "profile-1",
							name: "default",
						},
					],
					isLoading: false,
				}),
			},
			run: {
				useMutation: () => ({
					mutateAsync: mocks.mutateAsync,
					isLoading: false,
				}),
			},
		},
		scan: {
			checkoutToolsStatus: {
				useQuery: () => ({ data: null, isLoading: false }),
			},
			checkoutImageStatus: {
				useQuery: () => ({ data: null, isLoading: false }),
			},
		},
		project: {
			all: { useQuery: mocks.projectAll },
		},
	},
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

beforeAll(() => {
	// Radix Select drives pointer-capture APIs that jsdom does not implement.
	Element.prototype.scrollIntoView = vi.fn();
	window.HTMLElement.prototype.hasPointerCapture = vi.fn();
	window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
	mocks.push.mockReset();
	mocks.mutateAsync.mockReset();
	mocks.toast.success.mockReset();
	mocks.toast.error.mockReset();
	mocks.projectAll.mockReset();
	mocks.projectAll.mockReturnValue({
		data: [],
		isSuccess: true,
		isLoading: false,
	});
});

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
	render(
		<RunPipelineDialog
			target={{ type: "application", applicationId: "app-1" }}
			defaultPipelineId="pipe-1"
		/>,
	);
	await user.click(screen.getByRole("button", { name: /Run pipeline/i }));
	const dialog = screen.getByRole("dialog");
	await waitFor(() =>
		expect(
			within(dialog).getByRole("button", { name: "Start scan" }),
		).toBeEnabled(),
	);
	return dialog;
};

const chooseSelectOption = async (
	user: ReturnType<typeof userEvent.setup>,
	container: HTMLElement,
	placeholder: RegExp,
	optionLabel: string,
) => {
	await user.click(
		within(container).getByRole("combobox", { name: placeholder }),
	);
	await user.click(await screen.findByRole("option", { name: optionLabel }));
};

describe("RunPipelineDialog budgets", () => {
	it("shows optional token and time budget fields defaulting to unlimited", async () => {
		const user = userEvent.setup();
		const dialog = await openDialog(user);

		expect(
			within(dialog).getByLabelText("Token usage budget (K)"),
		).toHaveAttribute("placeholder", "Unlimited");
		expect(
			within(dialog).getByLabelText("Time budget (seconds)"),
		).toHaveAttribute("placeholder", "Unlimited");
		expect(
			within(dialog).getByText(
				"Leave empty for no limit. Token budget is in K (thousands). Exceeding either budget cancels the job.",
			),
		).toBeInTheDocument();
	});

	it("omits budgets when they are left empty", async () => {
		const user = userEvent.setup();
		mocks.mutateAsync.mockResolvedValue({ scanJobId: "job-1" });
		const dialog = await openDialog(user);

		await user.click(
			within(dialog).getByRole("button", { name: "Start scan" }),
		);

		await waitFor(() =>
			expect(mocks.mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					pipelineId: "pipe-1",
					tokenBudget: undefined,
					timeBudgetSeconds: undefined,
				}),
			),
		);
	});

	it("submits token and time budgets when set", async () => {
		const user = userEvent.setup();
		mocks.mutateAsync.mockResolvedValue({ scanJobId: "job-1" });
		const dialog = await openDialog(user);

		await user.type(
			within(dialog).getByLabelText("Token usage budget (K)"),
			"500",
		);
		await user.type(
			within(dialog).getByLabelText("Time budget (seconds)"),
			"3600",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Start scan" }),
		);

		await waitFor(() =>
			expect(mocks.mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					tokenBudget: 500_000,
					timeBudgetSeconds: 3600,
				}),
			),
		);
	});

	it("groups the token budget input with en-US commas", async () => {
		const user = userEvent.setup();
		mocks.mutateAsync.mockResolvedValue({ scanJobId: "job-1" });
		const dialog = await openDialog(user);
		const tokenInput = within(dialog).getByLabelText("Token usage budget (K)");

		await user.type(tokenInput, "1000");
		expect(tokenInput).toHaveValue("1,000");

		await user.click(
			within(dialog).getByRole("button", { name: "Start scan" }),
		);
		await waitFor(() =>
			expect(mocks.mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					tokenBudget: 1_000_000,
				}),
			),
		);
	});

	it("rejects a non-positive token budget without starting the scan", async () => {
		const user = userEvent.setup();
		const dialog = await openDialog(user);

		await user.type(
			within(dialog).getByLabelText("Token usage budget (K)"),
			"0",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Start scan" }),
		);

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Token budget must be a positive integer in K",
			),
		);
		expect(mocks.mutateAsync).not.toHaveBeenCalled();
	});
});

describe("RunPipelineDialog target picker", () => {
	it("keeps Start scan disabled until a project and application are picked", async () => {
		const user = userEvent.setup();
		mocks.projectAll.mockReturnValue({
			data: [
				{
					projectId: "p1",
					name: "Demo project",
					environments: [
						{
							environmentId: "e1",
							applications: [
								{
									applicationId: "app-1",
									name: "review-api",
									appName: "review-api",
								},
							],
						},
					],
				},
			],
			isSuccess: true,
			isLoading: false,
		});
		render(<RunPipelineDialog defaultPipelineId="pipe-1" />);
		await user.click(screen.getByRole("button", { name: /Run pipeline/i }));
		const dialog = screen.getByRole("dialog");

		expect(within(dialog).getByText("Project")).toBeInTheDocument();
		expect(within(dialog).getByText("Application")).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Start scan" }),
		).toBeDisabled();
	});

	it("runs against the picked application and opens its job detail page", async () => {
		const user = userEvent.setup();
		mocks.mutateAsync.mockResolvedValue({ scanJobId: "job-9" });
		mocks.projectAll.mockReturnValue({
			data: [
				{
					projectId: "p1",
					name: "Demo project",
					environments: [
						{
							environmentId: "e1",
							applications: [
								{
									applicationId: "app-1",
									name: "review-api",
									appName: "review-api",
								},
							],
						},
					],
				},
			],
			isSuccess: true,
			isLoading: false,
		});
		render(<RunPipelineDialog defaultPipelineId="pipe-1" />);
		await user.click(screen.getByRole("button", { name: /Run pipeline/i }));
		const dialog = screen.getByRole("dialog");

		await chooseSelectOption(user, dialog, /Project/i, "Demo project");
		await chooseSelectOption(user, dialog, /Application/i, "review-api");
		await waitFor(() =>
			expect(
				within(dialog).getByRole("button", { name: "Start scan" }),
			).toBeEnabled(),
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Start scan" }),
		);

		await waitFor(() =>
			expect(mocks.mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					target: { type: "application", applicationId: "app-1" },
					pipelineId: "pipe-1",
				}),
			),
		);
		await waitFor(() =>
			expect(mocks.push).toHaveBeenCalledWith(
				"/dashboard/project/p1/environment/e1/services/application/app-1/jobs/job-9",
			),
		);
	});
});
