#!/usr/bin/env python3
"""Orchestrator hunter dispatch wrapper over the scan-runtime HTTP API."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any

HUNTER_STAGE = "hunter"
HUNT_NAME_RE = re.compile(r"^#[1-9][0-9]* .+")
CANDIDATE_REQUIRED = (
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


CAPACITY_PATH = "/api/internal/scan/runtime/downstream-capacity"
RUNNING_TASKS_PATH = "/api/internal/scan/runtime/running-tasks"
POLL_MESSAGES_PATH = "/api/internal/scan/runtime/poll-messages"
COMPLETE_MESSAGES_PATH = "/api/internal/scan/runtime/complete-messages"
SUBMIT_OUTPUT_PATH = "/api/internal/scan/runtime/messages"


def load_runtime_api() -> Any:
    path = (
        Path(__file__).resolve().parent.parent
        / "scan-runtime"
        / "runtime_api.py"
    )
    spec = importlib.util.spec_from_file_location("runtime_api", path)
    if spec is None or spec.loader is None:
        print(f"orchestrator failed: cannot load {path}", file=sys.stderr)
        raise SystemExit(1)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.set_tool_name("orchestrator")
    return module


runtime = load_runtime_api()
fail = runtime.fail
runtime_request = runtime.runtime_request
write_debug_output = runtime.write_debug_output


def hunter_capacity(args: argparse.Namespace) -> dict[str, Any]:
    payload = runtime_request(args, CAPACITY_PATH, query={"toStage": HUNTER_STAGE})
    stages = payload.get("stages") if isinstance(payload, dict) else None
    if not isinstance(stages, list):
        fail("downstream-capacity did not return stages")
    hunter = next(
        (
            item
            for item in stages
            if isinstance(item, dict) and item.get("stageName") == HUNTER_STAGE
        ),
        None,
    )
    if not isinstance(hunter, dict):
        fail("downstream-capacity did not include hunter")
    return hunter


def list_hunters(args: argparse.Namespace) -> None:
    capacity = hunter_capacity(args)
    running = runtime_request(
        args, RUNNING_TASKS_PATH, query={"stage": HUNTER_STAGE}
    )
    tasks = running.get("tasks") if isinstance(running, dict) else None
    if not isinstance(tasks, list):
        fail("running-tasks did not return tasks")
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
    polled = runtime_request(
        args,
        POLL_MESSAGES_PATH,
        method="POST",
        query={"stage": stage},
    )
    items = polled.get("messages") if isinstance(polled, dict) else None
    if not isinstance(items, list):
        items = polled.get("tasks") if isinstance(polled, dict) else None
    if not isinstance(items, list):
        fail("poll-messages did not return messages")
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
        runtime_request(
            args,
            COMPLETE_MESSAGES_PATH,
            method="POST",
            query={"stage": stage},
            json_body={"messageIds": output_ids},
        )
    json.dump({"ok": True, "feedback": feedback}, sys.stdout, indent=2)
    sys.stdout.write("\n")


def read_stdin_object(command: str) -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        fail(f"{command} JSON is required on stdin")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"stdin is not valid JSON: {exc}")
    if not isinstance(payload, dict):
        fail("stdin must be a JSON object")
    return payload


def submit_stage_output(args: argparse.Namespace, output: dict[str, Any]) -> None:
    payload = runtime_request(
        args,
        SUBMIT_OUTPUT_PATH,
        method="POST",
        json_body={"output": output},
    )
    write_debug_output(output)
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def spawn_hunters(args: argparse.Namespace) -> None:
    payload = read_stdin_object("spawn_hunters")
    hunters = payload.get("hunters")
    if hunters is None:
        fail("hunters is required")
    if not isinstance(hunters, list):
        fail("hunters must be an array")
    if not hunters:
        fail("hunters must not be empty")
    if "candidates" in payload:
        fail("spawn_hunters does not take candidates")

    hunt_tasks: list[dict[str, str]] = []
    for index, item in enumerate(hunters):
        if not isinstance(item, dict):
            fail(f"hunters[{index}] must be an object")
        name = item.get("name")
        goal_prompt = item.get("goalPrompt")
        if not isinstance(name, str) or not HUNT_NAME_RE.match(name.strip()):
            fail(
                f"hunters[{index}].name must match `#<n> slug` with n >= 1"
            )
        if not isinstance(goal_prompt, str) or not goal_prompt.strip():
            fail(f"hunters[{index}].goalPrompt is required")
        hunt_tasks.append(
            {
                "name": name.strip(),
                "goalPrompt": goal_prompt.strip(),
            }
        )

    slots = hunter_capacity(args).get("availableSlots", 0)
    try:
        available = int(slots)
    except (TypeError, ValueError):
        available = 0
    if len(hunt_tasks) > available:
        fail(
            f"hunters length {len(hunt_tasks)} exceeds availableSlots {available}"
        )

    submit_stage_output(args, {"huntTasks": hunt_tasks, "candidates": []})


def validate_candidate(index: int, item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        fail(f"candidates[{index}] must be an object")
    missing = [key for key in CANDIDATE_REQUIRED if key not in item]
    if missing:
        fail(
            f"candidates[{index}] missing required fields: {', '.join(missing)}"
        )
    if not isinstance(item.get("title"), str) or not str(item["title"]).strip():
        fail(f"candidates[{index}].title is required")
    if not isinstance(item.get("claim"), str) or not str(item["claim"]).strip():
        fail(f"candidates[{index}].claim is required")
    if not isinstance(item.get("evidence"), list):
        fail(f"candidates[{index}].evidence must be an array")
    if not isinstance(item.get("preconditions"), list):
        fail(f"candidates[{index}].preconditions must be an array")
    if not isinstance(item.get("needsFuzzing"), bool):
        fail(f"candidates[{index}].needsFuzzing must be a boolean")
    if not isinstance(item.get("needsManualAnalysis"), bool):
        fail(f"candidates[{index}].needsManualAnalysis must be a boolean")
    return item


def create_candidate_id() -> str:
    return f"candidate-{uuid.uuid4().hex[:6]}"


def assign_candidate_ids(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    assigned: list[dict[str, Any]] = []
    for item in candidates:
        next_id = create_candidate_id()
        while next_id in seen:
            next_id = create_candidate_id()
        seen.add(next_id)
        assigned.append({**item, "id": next_id})
    return assigned


def submit_candidate(args: argparse.Namespace) -> None:
    payload = read_stdin_object("submit_candidate")
    if "hunters" in payload or "huntTasks" in payload:
        fail("submit_candidate does not take hunters")
    candidates = payload.get("candidates")
    if candidates is None:
        fail("candidates is required")
    if not isinstance(candidates, list):
        fail("candidates must be an array")
    if not candidates:
        fail("candidates must not be empty")
    validated = [validate_candidate(index, item) for index, item in enumerate(candidates)]
    submit_stage_output(
        args, {"huntTasks": [], "candidates": assign_candidate_ids(validated)}
    )


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
