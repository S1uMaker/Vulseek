#!/usr/bin/env python3
"""Validate a Vulseek output envelope and its JSON artifact files."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def fail(message: str) -> None:
    print(f"output validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{label} does not exist: {path}")
    except json.JSONDecodeError as exc:
        fail(f"{label} is invalid JSON at line {exc.lineno}, column {exc.colno}")
    except OSError as exc:
        fail(f"cannot read {label}: {exc}")
    raise AssertionError("unreachable")


def resolve_ref(schema: dict[str, Any], ref: str) -> Any:
    prefix = "#/definitions/"
    if not ref.startswith(prefix):
        fail(f"unsupported artifact schema reference: {ref}")
    definitions = schema.get("definitions")
    if not isinstance(definitions, dict) or ref[len(prefix) :] not in definitions:
        fail(f"unknown artifact schema reference: {ref}")
    return definitions[ref[len(prefix) :]]


def read_path(value: Any, expression: str) -> Any:
    parts = [part for part in expression.split(".") if part]
    if parts and parts[0] == "output":
        if not isinstance(value, dict) or "output" not in value:
            fail(f"artifact field parent is missing: {expression}")
        value = value["output"]
        parts = parts[1:]
    current = value
    for part in parts:
        is_list = part.endswith("[]")
        key = part[:-2] if is_list else part
        if not isinstance(current, dict) or key not in current:
            fail(f"artifact field is missing: {expression}")
        current = current[key]
        if is_list:
            if not isinstance(current, list):
                fail(f"artifact field is not a list: {expression}")
            return current
    return current


def resolve_task_artifact_path(value: Any, field_path: str) -> Path:
    if not isinstance(value, str) or not value:
        fail(f"artifact path is not a non-empty string: {field_path}")
    candidate = Path(value)
    task_root = Path(os.environ.get("VULSEEK_TASK_ROOT", "/task")).resolve()
    try:
        relative = candidate.relative_to("/task")
    except ValueError:
        fail(f"artifact path must be absolute under /task: {field_path}")
    resolved = (task_root / relative).resolve()
    try:
        resolved.relative_to(task_root)
    except ValueError:
        fail(f"artifact path must stay under /task: {field_path}")
    return resolved


def validate_with_schema(instance: Any, schema: Any, label: str) -> None:
    try:
        from jsonschema import Draft7Validator
    except ImportError:
        fail("the jsonschema Python package is not installed")

    validator = Draft7Validator(schema)
    errors = sorted(validator.iter_errors(instance), key=lambda error: list(error.path))
    if errors:
        first = errors[0]
        location = ".".join(str(item) for item in first.absolute_path) or "root"
        fail(f"{label} at {location}: {first.message}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    schema = load_json(args.schema, "schema")
    output = load_json(args.output, "output envelope")
    if not isinstance(schema, dict):
        fail("schema root must be an object")
    if not isinstance(output, dict):
        fail("output envelope must be an object")

    validate_with_schema(output, schema, "output envelope")

    route = output.get("route")
    artifact_entries = schema.get("x-vulseek-artifacts", [])
    if not isinstance(artifact_entries, list):
        fail("x-vulseek-artifacts must be an array")

    for entry in artifact_entries:
        if not isinstance(entry, dict):
            fail("x-vulseek-artifacts contains a non-object entry")
        entry_route = entry.get("route")
        if entry_route is not None and entry_route != route:
            continue
        field_path = entry.get("path")
        if not isinstance(field_path, str):
            fail("artifact entry has no valid path")
        artifact_value = read_path(output, field_path)
        kind = entry.get("kind")
        values = artifact_value if kind == "path_list" else [artifact_value]
        if kind not in {"path", "path_list"} or not isinstance(values, list):
            fail(f"invalid artifact entry for {field_path}")
        schema_ref = entry.get("schemaRef")
        artifact_schema = resolve_ref(schema, schema_ref) if isinstance(schema_ref, str) else entry.get("schema")
        if not isinstance(artifact_schema, dict):
            fail(f"artifact entry has no schema: {field_path}")
        for artifact_path in values:
            artifact_file = resolve_task_artifact_path(artifact_path, field_path)
            artifact = load_json(artifact_file, f"artifact {field_path}")
            validate_with_schema(artifact, artifact_schema, f"artifact {artifact_path}")

    print("output validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
