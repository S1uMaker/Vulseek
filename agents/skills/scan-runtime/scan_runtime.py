#!/usr/bin/env python3
"""Vulseek scan-job runtime CLI over the internal HTTP API."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

_SKILL_DIR = str(Path(__file__).resolve().parent)
if _SKILL_DIR not in sys.path:
    sys.path.insert(0, _SKILL_DIR)

from runtime_api import (  # noqa: E402
    add_runtime_flags,
    emit_json,
    fail,
    read_json_stdin,
    runtime_request,
    set_tool_name,
    write_debug_output,
)

set_tool_name("scan-runtime")

CAPACITY_PATH = "/api/internal/scan/runtime/downstream-capacity"
RUNNING_TASKS_PATH = "/api/internal/scan/runtime/running-tasks"
STAGE_OUTPUTS_PATH = "/api/internal/scan/runtime/stage-outputs"
QUEUED_TASKS_PATH = "/api/internal/scan/runtime/complete-messages"
POLL_QUEUED_TASKS_PATH = "/api/internal/scan/runtime/poll-messages"
SUBMIT_OUTPUT_PATH = "/api/internal/scan/runtime/messages"

read_output_from_stdin = read_json_stdin


def downstream_capacity(args: argparse.Namespace) -> None:
    query = {"toStage": args.to_stage} if args.to_stage else None
    emit_json(runtime_request(args, CAPACITY_PATH, query=query))


def running_tasks(args: argparse.Namespace) -> None:
    stage = (args.stage or "").strip()
    if not stage:
        fail("--stage is required")
    emit_json(
        runtime_request(
            args,
            RUNNING_TASKS_PATH,
            query={"stage": stage},
        )
    )


def stage_outputs(args: argparse.Namespace) -> None:
    stage = (args.stage or "").strip()
    if not stage:
        fail("--stage is required")
    emit_json(
        runtime_request(
            args,
            STAGE_OUTPUTS_PATH,
            query={"stage": stage},
        )
    )


def poll_queued_tasks(args: argparse.Namespace) -> None:
    stage = (args.stage or "").strip()
    if not stage:
        fail("--stage is required")
    emit_json(
        runtime_request(
            args,
            POLL_QUEUED_TASKS_PATH,
            method="POST",
            query={"stage": stage},
        )
    )


def queued_tasks(args: argparse.Namespace) -> None:
    stage = (args.stage or "").strip()
    if not stage:
        fail("--stage is required")
    emit_json(
        runtime_request(
            args,
            QUEUED_TASKS_PATH,
            query={"stage": stage},
        )
    )


def complete_queued_tasks(args: argparse.Namespace) -> None:
    stage = (args.stage or os.environ.get("VULSEEK_STAGE_NAME") or "").strip()
    message_ids = [
        str(item).strip()
        for item in (args.message_id or [])
        if str(item).strip()
    ]
    if not stage:
        fail("--stage is required")
    if not message_ids:
        fail("--message-id is required")
    emit_json(
        runtime_request(
            args,
            QUEUED_TASKS_PATH,
            method="POST",
            query={"stage": stage},
            json_body={"messageIds": message_ids},
        )
    )


def post_task_output(args: argparse.Namespace) -> None:
    output = read_json_stdin()
    body: dict[str, Any] = {"output": output}
    if args.route:
        body["routeKey"] = args.route
    if getattr(args, "submission_key", None):
        body["submissionKey"] = args.submission_key
    payload = runtime_request(
        args,
        SUBMIT_OUTPUT_PATH,
        method="POST",
        json_body=body,
    )
    write_debug_output(output)
    emit_json(payload)


def submit_output(args: argparse.Namespace) -> None:
    post_task_output(args)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    capacity = subparsers.add_parser(
        "downstream-capacity",
        help="Query remaining downstream task slots for the current stage",
    )
    capacity.add_argument("--to-stage", dest="to_stage")
    add_runtime_flags(capacity)
    capacity.set_defaults(func=downstream_capacity)

    running = subparsers.add_parser(
        "running-tasks",
        help="Query active tasks for a pipeline stage",
    )
    running.add_argument("--stage", required=True)
    add_runtime_flags(running)
    running.set_defaults(func=running_tasks)

    outputs = subparsers.add_parser(
        "stage-outputs",
        help="Query completed Messages for a downstream pipeline stage",
    )
    outputs.add_argument("--stage", required=True)
    add_runtime_flags(outputs)
    outputs.set_defaults(func=stage_outputs)

    queued = subparsers.add_parser(
        "query-messages",
        help="Peek waiting inbound Messages on the current stage queue without taking them",
    )
    queued.add_argument("--stage", required=True)
    add_runtime_flags(queued)
    queued.set_defaults(func=queued_tasks)

    poll_queued = subparsers.add_parser(
        "poll-messages",
        help="Take waiting inbound Messages from this stage queue",
    )
    poll_queued.add_argument("--stage", required=True)
    add_runtime_flags(poll_queued)
    poll_queued.set_defaults(func=poll_queued_tasks)

    complete_queued = subparsers.add_parser(
        "complete-messages",
        help="Drop leftover inbound Messages from this stage queue after they are used",
    )
    complete_queued.add_argument("--stage")
    complete_queued.add_argument(
        "--message-id",
        dest="message_id",
        action="append",
        default=[],
    )
    add_runtime_flags(complete_queued)
    complete_queued.set_defaults(func=complete_queued_tasks)

    submit = subparsers.add_parser(
        "submit-message",
        help="Validate and submit a structured Message for the current task",
    )
    submit.add_argument("--route", dest="route")
    submit.add_argument("--submission-key", dest="submission_key")
    add_runtime_flags(submit)
    submit.set_defaults(func=submit_output)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
