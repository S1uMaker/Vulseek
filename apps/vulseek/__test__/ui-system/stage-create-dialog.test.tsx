import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StageCreateDialog } from "@/components/dashboard/pipelines/stage-create-dialog";

describe("StageCreateDialog", () => {
	it("creates a stage from an embedded canvas trigger", () => {
		const onCreate = vi.fn();
		render(
			<StageCreateDialog
				existingIds={["stage-1"]}
				defaultGroup="research"
				onCreate={onCreate}
				trigger={<button type="button">Add canvas stage</button>}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add canvas stage" }));
		const textboxes = screen.getAllByRole("textbox");
		fireEvent.change(textboxes[0]!, { target: { value: "new-stage" } });
		fireEvent.change(textboxes[1]!, { target: { value: "New research stage" } });
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "verification" } });
		fireEvent.change(textboxes[2]!, { target: { value: "review" } });
		fireEvent.click(screen.getByRole("button", { name: "Create stage" }));

		expect(onCreate).toHaveBeenCalledWith(
			"new-stage",
			expect.objectContaining({
				name: "New research stage",
				role: "verification",
				group: "review",
			}),
		);
	});

	it("blocks a duplicate stage slug", () => {
		const onCreate = vi.fn();
		render(
			<StageCreateDialog
				existingIds={["stage-1"]}
				onCreate={onCreate}
				trigger={<button type="button">Add canvas stage</button>}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add canvas stage" }));
		fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "stage-1" } });

		expect(screen.getByRole("alert")).toHaveTextContent("already exists");
		expect(screen.getByRole("button", { name: "Create stage" })).toBeDisabled();
		expect(onCreate).not.toHaveBeenCalled();
	});
});
