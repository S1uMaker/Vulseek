import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parsePipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import { PipelineWorkbench } from "@/components/dashboard/pipelines/workbench/pipeline-workbench";
import {
	initialEditorState,
	pipelineEditorReducer,
	type PipelineEditorState,
} from "@/lib/pipeline-editor/pipeline-editor-state";

const router = vi.hoisted(() => ({
	query: {},
	replace: vi.fn(),
}));

vi.mock("next/router", () => ({
	useRouter: () => router,
}));

vi.mock("@/components/dashboard/pipelines/canvas-editor", () => ({
	CanvasEditor: () => <div>canvas</div>,
}));

const VALID_YAML = `version: 3
name: Test pipeline
supportedTargets:
  - project
root: discovery
limits:
  maxTasks: 100
  maxDurationSeconds: 3600
schemas:
  finding:
    type: object
    properties:
      summary:
        type: string
        description: Existing summary
      details:
        type: object
        description: Existing details
        properties:
          source:
            type: string
        items:
          type: string
        x-custom: preserve-me
  module:
    type: object
    properties:
      name:
        type: string
  intake:
    type: object
    properties:
      modulePath:
        $pathOf: "#/schemas/module"
        description: Module artifact path
        x-keep: preserve-path
      note:
        type: string
stages:
  discovery:
    name: Discovery
    role: scan
    group: core
    concurrency: 1
    runtime:
      prompt: Discover.
  review:
    name: Review
    role: verification
    group: core
    concurrency: 1
    runtime:
      prompt: Review.
edges:
  - id: discover-to-review
    name: Hand off
    from: discovery
    to: review
    mode: map
    fork: false
    artifacts: []
groups:
  - id: core
    name: Core
    leader: discovery
    members:
      - discovery
      - review
`;

const VALID_VERSION_YAML = VALID_YAML.replace("name: Test pipeline", "name: Published pipeline");

const parseOk = (yaml: string) => {
	const { document } = parsePipelineDocumentV3(yaml);
	if (!document) throw new Error("fixture must parse");
	return document;
};

const Harness = ({
	initial,
	readOnly = false,
	readOnlyYaml,
	versionLabel,
	initialView,
}: {
	initial: PipelineEditorState;
	readOnly?: boolean;
	readOnlyYaml?: string;
	versionLabel?: string | null;
	initialView?: "definition" | "visual" | "raw" | "profiles";
}) => {
	const [state, dispatch] = React.useReducer(pipelineEditorReducer, initial);
	return (
		<>
			<PipelineWorkbench
				state={state}
				dispatch={dispatch}
				readOnly={readOnly}
				readOnlyYaml={readOnlyYaml}
				versionLabel={versionLabel}
				initialView={initialView}
				draftState={{ dirty: false, draftRevision: 0, publishedVersion: "1" }}
			/>
			<pre data-testid="raw-yaml">{state.rawYamlBuffer}</pre>
		</>
	);
};

describe("PipelineWorkbench — three views", () => {
	it("renders Definition | Visual | Raw YAML tabs and the Definition rail", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		expect(screen.getByRole("tab", { name: "Definition" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Visual" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Raw YAML" })).toBeInTheDocument();
		// Default view is Definition: the rail is visible with counts.
		expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Stages 2" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edges 1" })).toBeInTheDocument();
		// Schemas carries a warning badge (unused schema), so the accessible
		// name includes the badge count.
		expect(screen.getByRole("button", { name: /Schemas/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Groups 1" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Layout" })).toBeInTheDocument();
	});

	it("isolates the Visual canvas so React Flow cannot cover page chrome", () => {
		render(
			<Harness
				initial={initialEditorState(VALID_YAML)}
				initialView="visual"
			/>,
		);
		const canvas = screen.getByTestId("pipeline-visual-canvas");
		expect(canvas).toHaveClass("overflow-hidden", "isolate");
		expect(canvas.parentElement).toHaveClass("overflow-hidden");
		expect(screen.queryByText("Pipeline schemas")).not.toBeInTheDocument();
		expect(screen.queryByText("Schemas")).not.toBeInTheDocument();
	});

	it("navigates from the rail to the entity list and editor", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		expect(screen.getByPlaceholderText("Search stages…")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		// Stage editor opens with the display name field.
		expect(screen.getByDisplayValue("Discovery")).toBeInTheDocument();
	});

	it("shows a schema's Used by list and navigates to the referencing stage", () => {
		const yaml = VALID_YAML.replace(
			"    runtime:\n      prompt: Discover.",
			"    runtime:\n      prompt: Discover.\n    inputSchema:\n      $ref: \"#/schemas/finding\"",
		);
		render(<Harness initial={initialEditorState(yaml)} />);
		fireEvent.click(screen.getByRole("button", { name: /Schemas/ }));
		fireEvent.click(screen.getByRole("button", { name: /finding/ }));
		expect(screen.getByText("Used by")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "stage: discovery" }));
		expect(screen.getByDisplayValue("Discovery")).toBeInTheDocument();
	});

	it("jumps from a stage input schema $ref to the schema editor", () => {
		const yaml = VALID_YAML.replace(
			"    runtime:\n      prompt: Discover.",
			"    runtime:\n      prompt: Discover.\n    inputSchema:\n      $ref: \"#/schemas/finding\"",
		);
		render(<Harness initial={initialEditorState(yaml)} />);
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		fireEvent.click(screen.getByRole("button", { name: "I/O" }));
		fireEvent.click(screen.getByRole("button", { name: "#/schemas/finding" }));
		expect(screen.getByText("Used by")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "finding" })).toBeInTheDocument();
	});

	it("edits and clears a top-level property description without losing advanced schema keys", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: /Schemas/ }));
		fireEvent.click(screen.getByRole("button", { name: /finding/ }));

		const summaryInput = screen.getByDisplayValue("summary");
		const summaryCard = summaryInput.parentElement;
		if (!summaryCard) throw new Error("summary property card was not rendered");
		const summaryTextboxes = within(summaryCard).getAllByRole("textbox");
		const summaryDescription = summaryTextboxes[1];
		if (!summaryDescription) throw new Error("summary description field was not rendered");
		fireEvent.change(summaryDescription, { target: { value: "Updated summary" } });
		expect(screen.getByTestId("raw-yaml")).toHaveTextContent("description: Updated summary");

		fireEvent.change(summaryDescription, { target: { value: "   " } });
		expect(screen.getByTestId("raw-yaml")).not.toHaveTextContent("description: Updated summary");
		expect(screen.getByTestId("raw-yaml")).toHaveTextContent("x-custom: preserve-me");
		expect(screen.getByTestId("raw-yaml")).toHaveTextContent("source:");
	});

	it("shows $pathOf properties as type path and navigates to the referenced schema", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: /Schemas/ }));
		fireEvent.click(screen.getByRole("button", { name: /intake/ }));

		const typeSelect = screen.getByLabelText("Type for modulePath") as HTMLSelectElement;
		expect(typeSelect.value).toBe("path");
		expect(screen.getByLabelText("Path schema")).toHaveValue("module");

		const modulePathInput = screen.getByDisplayValue("modulePath");
		const modulePathCard = modulePathInput.parentElement;
		if (!modulePathCard) throw new Error("modulePath property card was not rendered");
		const schemaLink = within(modulePathCard).getByRole("button", { name: "#/schemas/module" });
		expect(schemaLink).toBeInTheDocument();
		fireEvent.click(schemaLink);
		expect(screen.getByRole("heading", { name: "module" })).toBeInTheDocument();
		expect(screen.getByDisplayValue("name")).toBeInTheDocument();
	});

	it("edits a $pathOf target and does not smash path properties into type string", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: /Schemas/ }));
		fireEvent.click(screen.getByRole("button", { name: /intake/ }));

		fireEvent.change(screen.getByLabelText("Path schema"), { target: { value: "finding" } });
		expect(screen.getByTestId("raw-yaml")).toHaveTextContent("$pathOf");
		expect(screen.getByTestId("raw-yaml")).toHaveTextContent("#/schemas/finding");
		expect(screen.getByTestId("raw-yaml")).toHaveTextContent("x-keep: preserve-path");
		expect(screen.getByLabelText("Type for modulePath")).toHaveValue("path");
	});

	it("removes $pathOf when the property type changes away from path", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: /Schemas/ }));
		fireEvent.click(screen.getByRole("button", { name: /intake/ }));

		fireEvent.change(screen.getByLabelText("Type for modulePath"), {
			target: { value: "string" },
		});
		expect(screen.getByLabelText("Type for modulePath")).toHaveValue("string");
		expect(screen.queryByLabelText("Path schema")).not.toBeInTheDocument();
		expect(screen.getByTestId("raw-yaml")).not.toHaveTextContent("$pathOf");
		expect(screen.getByTestId("raw-yaml")).toHaveTextContent("x-keep: preserve-path");
	});

	it("sets $pathOf when the property type changes to path", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: /Schemas/ }));
		fireEvent.click(screen.getByRole("button", { name: /intake/ }));

		fireEvent.change(screen.getByLabelText("Type for note"), { target: { value: "path" } });
		const pathSelects = screen.getAllByLabelText("Path schema");
		expect(pathSelects.length).toBeGreaterThanOrEqual(2);
		const notePathSelect = pathSelects[pathSelects.length - 1] as HTMLSelectElement;
		expect(notePathSelect.value).toBe("finding");
		fireEvent.change(notePathSelect, { target: { value: "module" } });
		expect(screen.getByTestId("raw-yaml")).toHaveTextContent("#/schemas/module");
	});

	it("applies typed patches from the Definition editor and reflects them in the document", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		const nameInput = screen.getByDisplayValue("Discovery") as HTMLInputElement;
		fireEvent.change(nameInput, { target: { value: "Discovery renamed" } });
		expect(nameInput.value).toBe("Discovery renamed");
	});
});

describe("PipelineWorkbench — read-only / version view", () => {
	it("disables mutation controls and shows the version banner", () => {
		render(
			<Harness
				initial={initialEditorState(VALID_YAML)}
				readOnly
				readOnlyYaml={VALID_VERSION_YAML}
				versionLabel="v3 · published"
			/>,
		);
		// Read-only banner appears in the tab bar and the bottom bar.
		expect(screen.getAllByText(/Read-only view of v3 · published/).length).toBeGreaterThan(0);
		// No create controls.
		expect(screen.queryByRole("button", { name: "New stage" })).not.toBeInTheDocument();
		// Entity fields are disabled.
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		const nameInput = screen.getByDisplayValue("Discovery") as HTMLInputElement;
		expect(nameInput.disabled).toBe(true);
		// No delete affordance in read-only mode.
		expect(screen.queryByRole("button", { name: /Delete stage/ })).not.toBeInTheDocument();
	});

	it("disables property descriptions in a read-only schema version", () => {
		render(
			<Harness
				initial={initialEditorState(VALID_YAML)}
				readOnly
				readOnlyYaml={VALID_VERSION_YAML}
				versionLabel="v3 · published"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Schemas/ }));
		fireEvent.click(screen.getByRole("button", { name: /finding/ }));
		const summaryInput = screen.getByDisplayValue("summary");
		const summaryCard = summaryInput.parentElement;
		if (!summaryCard) throw new Error("summary property card was not rendered");
		const summaryTextboxes = within(summaryCard).getAllByRole("textbox");
		const summaryDescription = summaryTextboxes[1];
		if (!summaryDescription) throw new Error("summary description field was not rendered");
		expect(summaryDescription).toBeDisabled();
	});

	it("keeps the draft buffer out of the read-only Raw YAML view", () => {
		render(
			<Harness
				initial={initialEditorState(VALID_YAML)}
				readOnly
				readOnlyYaml={VALID_VERSION_YAML}
				versionLabel="v3 · published"
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Raw YAML" }));
		// The version banner stays; the editor area renders without crashing
		// (CodeMirror content is not asserted in jsdom).
		expect(screen.getAllByText(/Read-only view of v3 · published/).length).toBeGreaterThan(0);
	});
});

describe("PipelineWorkbench — diagnostics focus", () => {
	it("selects the referenced entity and jumps to the Definition view", () => {
		// A semantic warning on the review stage (unused schema would be on
		// schema; use a route diagnostic on the edge instead).
		const yaml = VALID_YAML.replace(
			"    name: Hand off\n    from: discovery\n    to: review\n    mode: map",
			"    name: Hand off\n    from: discovery\n    to: review\n    mode: map\n    foreach: \"$item\"",
		);
		const { document } = parsePipelineDocumentV3(yaml);
		if (!document) throw new Error("fixture must parse");
		const state = initialEditorState(yaml);
		expect(
			state.diagnostics.some(
				(d) => d.entity?.type === "edge" && d.entity.id === "discover-to-review",
			),
		).toBe(true);
		render(<Harness initial={state} />);
		fireEvent.click(screen.getByRole("button", { name: /Diagnostics: / }));
		// Click the warning chip.
		const chip = screen.getByRole("button", { name: /map edges do not expand items/ });
		fireEvent.click(chip);
		// The edge editor opens with the diagnostic visible.
		expect(screen.getAllByText(/discover-to-review/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/map edges do not expand items/).length).toBeGreaterThan(0);
	});
});

describe("PipelineWorkbench — entity creation", () => {
	it("exposes all entity creation actions and resets dialog fields", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		for (const kind of ["stage", "edge", "schema", "group"]) {
			expect(screen.getByRole("button", { name: `New ${kind}` })).toBeInTheDocument();
		}

		fireEvent.click(screen.getByRole("button", { name: "New group" }));
		const groupId = screen.getByPlaceholderText("group-id") as HTMLInputElement;
		fireEvent.change(groupId, { target: { value: "temporary-group" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		fireEvent.click(screen.getByRole("button", { name: "New stage" }));
		const stageId = screen.getByPlaceholderText("stage-id") as HTMLInputElement;
		expect(stageId.value).toBe("");
		expect(screen.getByDisplayValue("default")).toBeInTheDocument();
	});
});

describe("PipelineWorkbench — quick switcher", () => {
	it("opens with Ctrl/Cmd+P and jumps to a stage", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.keyDown(window, { key: "p", ctrlKey: true });
		expect(screen.getByPlaceholderText(/Jump to a stage/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("option", { name: /Discovery/ }));
		expect(screen.getByDisplayValue("Discovery")).toBeInTheDocument();
	});
});

describe("PipelineWorkbench — responsive drill-down", () => {
	const setNarrow = (narrow: boolean) => {
		window.matchMedia = (query: string) =>
			({
				matches: narrow,
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			}) as MediaQueryList;
	};

	it("shows one pane at a time with a visible back path", () => {
		setNarrow(true);
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		// Rail only — no list yet.
		expect(screen.getByRole("button", { name: "Stages 2" })).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Search stages…")).not.toBeInTheDocument();
		// Drill into the list.
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		expect(screen.getByPlaceholderText("Search stages…")).toBeInTheDocument();
		// Back to the rail.
		fireEvent.click(screen.getByRole("button", { name: /Sections/ }));
		expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
		// Drill into an entity editor and back.
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		expect(screen.getByDisplayValue("Discovery")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Stages/ }));
		expect(screen.getByPlaceholderText("Search stages…")).toBeInTheDocument();
		setNarrow(false);
	});

	it("mounts the creation dialog from the narrow rail", () => {
		setNarrow(true);
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: "New stage" }));
		expect(screen.getByRole("heading", { name: "New stage" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		setNarrow(false);
	});
});
