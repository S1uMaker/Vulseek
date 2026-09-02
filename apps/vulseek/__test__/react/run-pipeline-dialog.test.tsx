import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunPipelineDialog } from "@/components/dashboard/pipelines/run-pipeline-dialog";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	mutateAsync: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/router", () => ({
	useRouter: () => ({
		push: mocks.push,
		asPath: "/dashboard/project/p/environment/e/profiles/application/app-1",
		query: {},
		pathname:
			"/dashboard/project/[projectId]/environment/[environmentId]/profiles/application/[applicationId]",
		replace: vi.fn(),
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
	},
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

beforeEach(() => {
	mocks.push.mockReset();
	mocks.mutateAsync.mockReset();
	mocks.toast.success.mockReset();
	mocks.toast.error.mockReset();
});

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
	render(
		<RunPipelineDialog
			target={{ type: "application", applicationId: "app-1" }}
			defaultPipelineId="pipe-1"
		/>,
	);
	await user.click(screen.getByRole("button", { name: /Run Pipeline/i }));
	const dialog = screen.getByRole("dialog");
	await waitFor(() =>
		expect(
			within(dialog).getByRole("button", { name: "Start scan" }),
		).toBeEnabled(),
	);
	return dialog;
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
