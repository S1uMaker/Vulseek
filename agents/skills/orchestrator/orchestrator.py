#!/usr/bin/env python3
"""Orchestrator hunter dispatch wrapper over scan-runtime."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

HUNTER_STAGE = "hunter"
HUNT_NAME_RE = re.compile(r"^#[1-9][0-9]* .+")
CANDIDATE_REQUIRED = (
    "id",
    "functionId",
    "title",
    "description",
    "filePath",
    "line",
    "vulnerabilityType",
    "confidence",
    "score",
    "claim",
    "rootCauseKey",
    "evidence",
    "attackerControl",
    "affectedSink",
    "preconditions",
    "quickDisproofAttempt",
    "needsFuzzing",
    "needsManualAnalysis",
)
HUNTER_SUBMIT_FOOTER = (
    "Before ending this hunt, read $VULSEEK_AGENT_HOME/skills/scan-runtime/SKILL.md "
    "and /task/output.schema.json. Submit JSON with name set to the assigned hunt "
    "name exactly and feedback set to your feedback string, then call the "
    "scan-runtime submit-message command. A natural-language response is not a "
    "Message. Do not mark the Goal complete until submit-message succeeds; "
    "if it fails, correct the payload and retry."
)


def load_scan_runtime() -> Any:
    path = (
        Path(__file__).resolve().parent.parent
        / "scan-runtime"
        / "query_scan_runtime.py"
    )
    spec = importlib.util.spec_from_file_location("query_scan_runtime", path)
    if spec is None or spec.loader is None:
        print(f"orchestrator failed: cannot load {path}", file=sys.stderr)
        raise SystemExit(1)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime = load_scan_runtime()


def runtime_args(args: argparse.Namespace, **extra: Any) -> SimpleNamespace:
    return SimpleNamespace(
        api_url=getattr(args, "api_url", None),
        token=getattr(args, "token", None),
        **extra,
    )


def hunter_capacity(args: argparse.Namespace) -> dict[str, Any]:
    payload = capture_command(
        runtime.downstream_capacity,
        runtime_args(args, to_stage=HUNTER_STAGE),
    )
    stages = payload.get("stages") if isinstance(payload, dict) else None
    if not isinstance(stages, list):
        runtime.fail("downstream-capacity did not return stages")
    hunter = next(
        (
            item
            for item in stages
            if isinstance(item, dict) and item.get("stageName") == HUNTER_STAGE
        ),
        None,
    )
    if not isinstance(hunter, dict):
        runtime.fail("downstream-capacity did not include hunter")
    return hunter


def capture_command(func: Any, args: SimpleNamespace) -> Any:
    from io import StringIO
    from contextlib import redirect_stdout

    buffer = StringIO()
    with redirect_stdout(buffer):
        func(args)
    raw = buffer.getvalue()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        runtime.fail(f"wrapped scan-runtime output is not JSON: {exc}")


def list_hunters(args: argparse.Namespace) -> None:
    capacity = hunter_capacity(args)
    running = capture_command(
        runtime.running_tasks,
        runtime_args(args, stage=HUNTER_STAGE),
    )
    tasks = running.get("tasks") if isinstance(running, dict) else None
    if not isinstance(tasks, list):
        runtime.fail("running-tasks did not return tasks")
    hunters = []
    for item in tasks:
        if not isinstance(item, dict):
            continue
        hunters.append(
            {
                "name": item.get("name") or item.get("title") or "",
                "taskId": item.get("taskId"),
                "status": item.get("status"),
                "startedAt": item.get("startedAt"),
                "updatedAt": item.get("updatedAt"),
            }
        )
    json.dump(
        {
            "ok": True,
            "availableSlots": capacity.get("availableSlots", 0),
            "concurrency": capacity.get("concurrency", 0),
            "activeCount": capacity.get("activeTasks", len(hunters)),
            "hunters": hunters,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")


def queued_item_name(item: dict[str, Any]) -> str:
    name = item.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    inbound = item.get("input")
    if isinstance(inbound, dict):
        nested = inbound.get("name")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
    return ""


def queued_item_feedback(item: dict[str, Any]) -> str:
    inbound = item.get("input")
    if isinstance(inbound, dict):
        feedback = inbound.get("feedback")
        if isinstance(feedback, str):
            return feedback
    feedback = item.get("feedback")
    return feedback if isinstance(feedback, str) else ""


def get_hunter_feedback(args: argparse.Namespace) -> None:
    stage = (
        os.environ.get("VULSEEK_STAGE_NAME") or "orchestrator"
    ).strip() or "orchestrator"
    polled = capture_command(
        runtime.poll_queued_tasks,
        runtime_args(args, stage=stage),
    )
    items = polled.get("messages") if isinstance(polled, dict) else None
    if not isinstance(items, list):
        items = polled.get("tasks") if isinstance(polled, dict) else None
    if not isinstance(items, list):
        runtime.fail("poll-messages did not return messages")
    feedback = []
    output_ids: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        message_id = item.get("messageId")
        if isinstance(message_id, str) and message_id.strip():
            output_ids.append(message_id.strip())
        feedback.append(
            {
                "name": queued_item_name(item),
                "feedback": queued_item_feedback(item),
                "messageId": message_id
                if isinstance(message_id, str)
                else None,
            }
        )
    if output_ids:
        capture_command(
            runtime.complete_queued_tasks,
            runtime_args(args, stage=stage, message_id=output_ids),
        )
    json.dump({"ok": True, "feedback": feedback}, sys.stdout, indent=2)
    sys.stdout.write("\n")


def read_stdin_object(command: str) -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        runtime.fail(f"{command} JSON is required on stdin")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        runtime.fail(f"stdin is not valid JSON: {exc}")
    if not isinstance(payload, dict):
        runtime.fail("stdin must be a JSON object")
    return payload


def submit_stage_output(args: argparse.Namespace, output: dict[str, Any]) -> None:
    submit_args = runtime_args(args, route=None, submission_key=None)
    original_stdin = sys.stdin
    sys.stdin = _Stdin(json.dumps(output))
    try:
        runtime.submit_output(submit_args)
    finally:
        sys.stdin = original_stdin


def ensure_hunter_footer(goal_prompt: str) -> str:
    text = goal_prompt.rstrip()
    if HUNTER_SUBMIT_FOOTER in text:
        return text
    return f"{text}\n\n{HUNTER_SUBMIT_FOOTER}"


def spawn_hunters(args: argparse.Namespace) -> None:
    payload = read_stdin_object("spawn_hunters")
    hunters = payload.get("hunters")
    if hunters is None:
        runtime.fail("hunters is required")
    if not isinstance(hunters, list):
        runtime.fail("hunters must be an array")
    if not hunters:
        runtime.fail("hunters must not be empty")
    if "candidates" in payload:
        runtime.fail("spawn_hunters does not take candidates")

    hunt_tasks: list[dict[str, str]] = []
    for index, item in enumerate(hunters):
        if not isinstance(item, dict):
            runtime.fail(f"hunters[{index}] must be an object")
        name = item.get("name")
        goal_prompt = item.get("goalPrompt")
        if not isinstance(name, str) or not HUNT_NAME_RE.match(name.strip()):
            runtime.fail(
                f"hunters[{index}].name must match `#<n> slug` with n >= 1"
            )
        if not isinstance(goal_prompt, str) or not goal_prompt.strip():
            runtime.fail(f"hunters[{index}].goalPrompt is required")
        hunt_tasks.append(
            {
                "name": name.strip(),
                "goalPrompt": ensure_hunter_footer(goal_prompt),
            }
        )

    slots = hunter_capacity(args).get("availableSlots", 0)
    try:
        available = int(slots)
    except (TypeError, ValueError):
        available = 0
    if len(hunt_tasks) > available:
        runtime.fail(
            f"hunters length {len(hunt_tasks)} exceeds availableSlots {available}"
        )

    submit_stage_output(args, {"huntTasks": hunt_tasks, "candidates": []})


def validate_candidate(index: int, item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        runtime.fail(f"candidates[{index}] must be an object")
    missing = [key for key in CANDIDATE_REQUIRED if key not in item]
    if missing:
        runtime.fail(
            f"candidates[{index}] missing required fields: {', '.join(missing)}"
        )
    if not isinstance(item.get("id"), str) or not str(item["id"]).strip():
        runtime.fail(f"candidates[{index}].id is required")
    if not isinstance(item.get("title"), str) or not str(item["title"]).strip():
        runtime.fail(f"candidates[{index}].title is required")
    if not isinstance(item.get("claim"), str) or not str(item["claim"]).strip():
        runtime.fail(f"candidates[{index}].claim is required")
    if not isinstance(item.get("evidence"), list):
        runtime.fail(f"candidates[{index}].evidence must be an array")
    if not isinstance(item.get("preconditions"), list):
        runtime.fail(f"candidates[{index}].preconditions must be an array")
    if not isinstance(item.get("needsFuzzing"), bool):
        runtime.fail(f"candidates[{index}].needsFuzzing must be a boolean")
    if not isinstance(item.get("needsManualAnalysis"), bool):
        runtime.fail(f"candidates[{index}].needsManualAnalysis must be a boolean")
    return item


def submit_candidate(args: argparse.Namespace) -> None:
    payload = read_stdin_object("submit_candidate")
    if "hunters" in payload or "huntTasks" in payload:
        runtime.fail("submit_candidate does not take hunters")
    candidates = payload.get("candidates")
    if candidates is None:
        runtime.fail("candidates is required")
    if not isinstance(candidates, list):
        runtime.fail("candidates must be an array")
    if not candidates:
        runtime.fail("candidates must not be empty")
    validated = [validate_candidate(index, item) for index, item in enumerate(candidates)]
    submit_stage_output(args, {"huntTasks": [], "candidates": validated})


class _Stdin:
    def __init__(self, text: str) -> None:
        self._text = text

    def read(self) -> str:
        return self._text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name, func, help_text in (
        ("list_hunters", list_hunters, "List running hunters and remaining slots"),
        (
            "get_hunter_feedback",
            get_hunter_feedback,
            "Take inbound hunter feedback for this orchestrator stage",
        ),
        (
            "spawn_hunters",
            spawn_hunters,
            "Submit huntTasks within available slots",
        ),
        (
            "submit_candidate",
            submit_candidate,
            "Submit verified vulnerability candidates",
        ),
    ):
        command = subparsers.add_parser(name, help=help_text)
        command.add_argument("--api-url")
        command.add_argument("--token")
        command.set_defaults(func=func)
    alias = subparsers.add_parser(
        "submit-candidate",
        help="Submit verified vulnerability candidates",
    )
    alias.add_argument("--api-url")
    alias.add_argument("--token")
    alias.set_defaults(func=submit_candidate)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
