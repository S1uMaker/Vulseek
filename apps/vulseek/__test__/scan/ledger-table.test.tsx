import { fireEvent, render, screen } from "@testing-library/react";
import { LEDGER_PRIMITIVES_TAB } from "@vulseek/server/services/scan/pipeline/document-v3/pipeline-job-tabs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobTabEntityTable } from "@/components/dashboard/scanning/job-tab-entity-table";

const queries = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));

vi.mock("@/utils/api", () => ({
	api: {
		scan: {
			jobTabData: { useQuery: queries.list },
			jobTabDetail: { useQuery: queries.detail },
		},
	},
}));

describe("Ledger table integer IDs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		queries.list.mockReturnValue({
			isLoading: false,
			data: {
				items: [
					{
						id: "42",
						values: {
							id: 42,
							title: "File access sink",
							type: "sink",
							state: "investigating",
							statement: "Input reaches file access",
						},
					},
				],
				total: 1,
				pageSize: 20,
				filterOptions: { state: ["investigating"] },
			},
		});
		queries.detail.mockReturnValue({ isLoading: false });
	});

	it("shows a numeric ID first, sorts it in both directions and opens its detail", () => {
		render(
			<JobTabEntityTable
				scanJobId="job-1"
				tab={LEDGER_PRIMITIVES_TAB}
				live={false}
			/>,
		);
		expect(screen.getAllByRole("columnheader")[0]?.textContent).toBe("ID");
		expect(screen.getByRole("columnheader", { name: "Title" })).toBeTruthy();
		const idCell = screen.getByRole("cell", { name: "42" });
		expect(screen.getByRole("cell", { name: "File access sink" })).toBeTruthy();
		expect(idCell.className).toContain("tabular-nums");
		fireEvent.click(screen.getByRole("button", { name: "ID" }));
		expect(queries.list).toHaveBeenLastCalledWith(
			expect.objectContaining({ sortField: "id", sortDirection: "desc" }),
			expect.anything(),
		);
		expect(
			screen.getAllByRole("columnheader")[0]?.getAttribute("aria-sort"),
		).toBe("descending");
		fireEvent.click(screen.getByRole("button", { name: "ID ↓" }));
		expect(queries.list).toHaveBeenLastCalledWith(
			expect.objectContaining({ sortField: "id", sortDirection: "asc" }),
			expect.anything(),
		);
		expect(
			screen.getAllByRole("columnheader")[0]?.getAttribute("aria-sort"),
		).toBe("ascending");
		fireEvent.click(idCell);
		expect(queries.detail).toHaveBeenLastCalledWith(
			{ scanJobId: "job-1", tabId: "ledger", itemId: "42" },
			{ enabled: true },
		);
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy ID" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy Evidence" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy Links" })).toBeTruthy();
	});
});
