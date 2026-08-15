import * as React from "react";
import type { PipelineDiagnostic } from "@vulseek/server/services/scan/pipeline/document-v3";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { schemaIdFromPointer } from "@/lib/pipeline-editor/definition-helpers";
import { cn } from "@/lib/utils";
import { JsonEditor } from "../json-editor";

/**
 * Structured field engine for the Definition view.
 *
 * The workbench plan calls for RJSF as the field engine for ordinary scalar,
 * enum, array, conditional, and validation-driven fields, with custom
 * Vulseek widgets kept for references, prompts, route maps, artifacts,
 * effects, JSON values, and destructive operations. @rjsf is not installable
 * on this host (no registry access, absent from the local store), so this
 * module implements the equivalent contract on the installed shadcn/ui
 * primitives: a `FieldTemplate` wrapper (label + description + inline
 * validation) plus scalar/enum/boolean/array fields. The page layout and the
 * specialized V3 widgets remain hand-written, exactly as the plan intends.
 *
 * Every field is fully controlled: parents dispatch typed YAML patches on
 * change, so structured edits flow through the shared undo/redo history.
 */

export type FieldDiagnostics = Pick<PipelineDiagnostic, "severity" | "message">[];

/** `#/schemas/<id>` → `<id>` from a `$ref` object; anything else returns null. */
export const schemaIdFromRef = (
	value: Record<string, unknown> | undefined,
): string | null => schemaIdFromPointer(value?.["$ref"]);

/** FieldTemplate: label, description, inline validation, and hint slot. */
export const FieldTemplate = ({
	label,
	description,
	errors = [],
	children,
	className,
	required,
	action,
}: {
	label: string;
	description?: string;
	errors?: FieldDiagnostics;
	children: React.ReactNode;
	className?: string;
	required?: boolean;
	action?: React.ReactNode;
}) => {
	const blocking = errors.filter((error) => error.severity === "error");
	const hints = errors.filter((error) => error.severity === "warning");
	return (
		<div className={cn("space-y-1", className)}>
			<div className="flex items-center gap-1">
				<Label className="text-xs font-medium text-foreground">{label}</Label>
				{required ? (
					<span className="text-xs text-muted-foreground" aria-hidden>
						*
					</span>
				) : null}
				{action ? <div className="ml-auto min-w-0">{action}</div> : null}
			</div>
			{description ? (
				<p className="text-xs text-muted-foreground">{description}</p>
			) : null}
			{children}
			{blocking.length > 0 ? (
				<p className="text-xs text-red-600" role="alert">
					{blocking.map((error) => error.message).join(" ")}
				</p>
			) : null}
			{hints.length > 0 ? (
				<p className="text-xs text-amber-600">
					{hints.map((error) => error.message).join(" ")}
				</p>
			) : null}
		</div>
	);
};

export const TextField = ({
	label,
	value,
	onChange,
	placeholder,
	description,
	errors,
	readOnly,
}: {
	label: string;
	value: string;
	onChange?: (value: string) => void;
	placeholder?: string;
	description?: string;
	errors?: FieldDiagnostics;
	readOnly?: boolean;
}) => (
	<FieldTemplate label={label} description={description} errors={errors}>
		<Input
			value={value}
			placeholder={placeholder}
			disabled={readOnly}
			onChange={(event) => onChange?.(event.target.value)}
			className="h-9"
		/>
	</FieldTemplate>
);

export const NumberField = ({
	label,
	value,
	onChange,
	min,
	description,
	errors,
	readOnly,
}: {
	label: string;
	value: number;
	onChange: (value: number) => void;
	min?: number;
	description?: string;
	errors?: FieldDiagnostics;
	readOnly?: boolean;
}) => (
	<FieldTemplate label={label} description={description} errors={errors}>
		<Input
			type="number"
			value={Number.isFinite(value) ? String(value) : ""}
			min={min}
			disabled={readOnly}
			onChange={(event) => {
				const next = Number(event.target.value);
				if (Number.isFinite(next)) onChange(next);
			}}
			className="h-9"
		/>
	</FieldTemplate>
);

export const SelectField = ({
	label,
	value,
	options,
	onChange,
	description,
	errors,
	readOnly,
	allowEmpty,
}: {
	label: string;
	value: string;
	options: ReadonlyArray<{ value: string; label: string }>;
	onChange?: (value: string) => void;
	description?: string;
	errors?: FieldDiagnostics;
	readOnly?: boolean;
	allowEmpty?: boolean;
}) => (
	<FieldTemplate label={label} description={description} errors={errors}>
		<select
			value={value}
			disabled={readOnly}
			onChange={(event) => onChange?.(event.target.value)}
			className="h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
		>
			{allowEmpty ? <option value="">—</option> : null}
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	</FieldTemplate>
);

export const ToggleField = ({
	label,
	checked,
	onChange,
	description,
	readOnly,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	description?: string;
	readOnly?: boolean;
}) => (
	<div className="flex items-center justify-between gap-3">
		<div className="space-y-0.5">
			<Label className="text-xs font-medium text-foreground">{label}</Label>
			{description ? (
				<p className="text-xs text-muted-foreground">{description}</p>
			) : null}
		</div>
		<Switch
			checked={checked}
			disabled={readOnly}
			onCheckedChange={onChange}
			aria-label={label}
		/>
	</div>
);

export const CheckboxField = ({
	label,
	checked,
	onChange,
	readOnly,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	readOnly?: boolean;
}) => (
	<div className="flex items-center gap-2">
		<Checkbox
			id={`cb-${label}`}
			checked={checked}
			disabled={readOnly}
			onCheckedChange={(value) => onChange(value === true)}
		/>
		<Label htmlFor={`cb-${label}`} className="text-xs">
			{label}
		</Label>
	</div>
);

export const TextAreaField = ({
	label,
	value,
	onChange,
	rows = 5,
	description,
	errors,
	readOnly,
	placeholder,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	rows?: number;
	description?: string;
	errors?: FieldDiagnostics;
	readOnly?: boolean;
	placeholder?: string;
}) => (
	<FieldTemplate label={label} description={description} errors={errors}>
		<Textarea
			value={value}
			rows={rows}
			placeholder={placeholder}
			disabled={readOnly}
			onChange={(event) => onChange(event.target.value)}
			className="font-mono text-xs"
		/>
	</FieldTemplate>
);

export const JsonField = ({
	label,
	value,
	onChange,
	description,
	errors,
	readOnly,
	rows,
}: {
	label: string;
	value: unknown;
	onChange: (value: unknown) => void;
	description?: string;
	errors?: FieldDiagnostics;
	readOnly?: boolean;
	rows?: number;
}) => (
	<FieldTemplate label={label} description={description} errors={errors}>
		<JsonEditor value={value} onChange={onChange} label={label} rows={rows} />
	</FieldTemplate>
);

/**
 * Generic array editor: renders one row per item with remove buttons and an
 * "Add" button. Rows are controlled by index; parents own item identity and
 * reorder semantics via their patch layer.
 */
export const ArrayField = <T,>({
	label,
	items,
	onAdd,
	onRemove,
	onChange,
	renderItem,
	description,
	addLabel,
	readOnly,
}: {
	label: string;
	items: T[];
	onAdd: () => void;
	onRemove: (index: number) => void;
	onChange: (index: number, item: T) => void;
	renderItem: (item: T, index: number, onChange: (item: T) => void) => React.ReactNode;
	description?: string;
	addLabel?: string;
	readOnly?: boolean;
}) => (
	<FieldTemplate label={label} description={description}>
		<div className="space-y-2">
			{items.map((item, index) => (
				<div key={index} className="space-y-2 rounded-md border p-2">
					{renderItem(item, index, (next) => onChange(index, next))}
					{!readOnly ? (
						<button
							type="button"
							onClick={() => onRemove(index)}
							className="text-xs text-red-600 hover:underline"
						>
							Remove
						</button>
					) : null}
				</div>
			))}
			{!readOnly ? (
				<button
					type="button"
					onClick={onAdd}
					className="rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
				>
					{addLabel ?? `Add ${label.toLowerCase()}`}
				</button>
			) : null}
		</div>
	</FieldTemplate>
);

/**
 * Custom schema-reference widget: a select of defined schemas plus an
 * "inline" option that reveals the JSON editor. `value` is the raw schema
 * object (a `{$ref}` or an inline JSON Schema).
 */
export const SchemaReferenceField = ({
	label,
	value,
	schemaIds,
	onChange,
	onNavigateToSchema,
	description,
	errors,
	readOnly,
}: {
	label: string;
	value: Record<string, unknown> | undefined;
	schemaIds: string[];
	onChange: (value: Record<string, unknown> | undefined) => void;
	onNavigateToSchema?: (schemaId: string) => void;
	description?: string;
	errors?: FieldDiagnostics;
	readOnly?: boolean;
}) => {
	const refId = schemaIdFromRef(value);
	const isRef = refId !== null && schemaIds.includes(refId);
	const mode = isRef ? refId : "inline";

	return (
		<FieldTemplate
			label={label}
			description={description}
			errors={errors}
			action={
				isRef && onNavigateToSchema ? (
					<button
						type="button"
						onClick={() => onNavigateToSchema(refId)}
						className="truncate text-xs text-sky-600 hover:underline"
					>
						#/schemas/{refId}
					</button>
				) : null
			}
		>
			<div className="space-y-2">
				<select
					value={mode}
					disabled={readOnly}
					onChange={(event) => {
						const next = event.target.value;
						if (next === "inline") {
							onChange(value && typeof value["$ref"] !== "string" ? value : undefined);
						} else {
							onChange({ $ref: `#/schemas/${next}` });
						}
					}}
					className="h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
				>
					<option value="inline">Inline schema…</option>
					{schemaIds.map((id) => (
						<option key={id} value={id}>
							#/schemas/{id}
						</option>
					))}
				</select>
				{mode === "inline" ? (
					<JsonEditor
						value={value ?? {}}
						label={label}
						rows={5}
						onChange={(next) => onChange(next as Record<string, unknown>)}
					/>
				) : null}
			</div>
		</FieldTemplate>
	);
};

/**
 * `$pathOf` target picker: select a document schema and jump to it. Used by
 * schema form properties whose type is `path`.
 */
export const PathOfReferenceField = ({
	label,
	value,
	schemaIds,
	onChange,
	onNavigateToSchema,
	description,
	errors,
	readOnly,
}: {
	label: string;
	value: string;
	schemaIds: string[];
	onChange: (schemaId: string) => void;
	onNavigateToSchema?: (schemaId: string) => void;
	description?: string;
	errors?: FieldDiagnostics;
	readOnly?: boolean;
}) => {
	const options = value && !schemaIds.includes(value) ? [value, ...schemaIds] : schemaIds;
	const canNavigate = value.length > 0 && Boolean(onNavigateToSchema);

	return (
		<FieldTemplate
			label={label}
			description={description}
			errors={errors}
			action={
				canNavigate ? (
					<button
						type="button"
						onClick={() => onNavigateToSchema?.(value)}
						className="truncate text-xs text-sky-600 hover:underline"
					>
						#/schemas/{value}
					</button>
				) : null
			}
		>
			<select
				value={value}
				disabled={readOnly}
				aria-label={label}
				onChange={(event) => onChange(event.target.value)}
				className="h-8 w-full rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
			>
				<option value="">Select schema…</option>
				{options.map((id) => (
					<option key={id} value={id}>
						#/schemas/{id}
					</option>
				))}
			</select>
		</FieldTemplate>
	);
};

export const EmptyState = ({ title, hint }: { title: string; hint?: string }) => (	<div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
		<p className="text-sm font-medium text-foreground">{title}</p>
		{hint ? <p className="max-w-xs text-xs text-muted-foreground">{hint}</p> : null}
	</div>
);

export const SectionHeading = ({
	title,
	subtitle,
	actions,
}: {
	title: string;
	subtitle?: string;
	actions?: React.ReactNode;
}) => (
	<div className="flex items-start justify-between gap-2 border-b px-4 py-3">
		<div className="min-w-0">
			<h2 className="truncate text-sm font-semibold">{title}</h2>
			{subtitle ? (
				<p className="truncate text-xs text-muted-foreground">{subtitle}</p>
			) : null}
		</div>
		{actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
	</div>
);

/** Inline diagnostics for one entity, rendered under the editor heading. */
export const EntityDiagnostics = ({
	diagnostics,
}: {
	diagnostics: PipelineDiagnostic[];
}) => {
	if (diagnostics.length === 0) return null;
	return (
		<div className="space-y-1 border-b px-4 py-2">
			{diagnostics.map((diagnostic, index) => (
				<p
					key={`${diagnostic.code}-${index}`}
					className={
						"text-xs " +
						(diagnostic.severity === "error" ? "text-red-600" : "text-amber-600")
					}
				>
					{diagnostic.message}
				</p>
			))}
		</div>
	);
};
