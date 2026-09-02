#!/usr/bin/env python3
"""Query Vulseek scan-job runtime info from the internal HTTP API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
from typing import Any

import requests

CAPACITY_PATH = "/api/internal/scan/runtime/downstream-capacity"
RUNNING_TASKS_PATH = "/api/internal/scan/runtime/running-tasks"
STAGE_OUTPUTS_PATH = "/api/internal/scan/runtime/stage-outputs"
QUEUED_TASKS_PATH = "/api/internal/scan/runtime/complete-messages"
POLL_QUEUED_TASKS_PATH = "/api/internal/scan/runtime/poll-messages"
SUBMIT_OUTPUT_PATH = "/api/internal/scan/runtime/messages"
DEBUG_OUTPUT_PATH = "/task/output.json"
MAX_REQUEST_ATTEMPTS = 3
RETRY_DELAYS_SECONDS = (0.25, 0.5)


def fail(message: str) -> None:
    print(f"scan-runtime failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def debug_output_path() -> str:
    return os.environ.get("VULSEEK_DEBUG_OUTPUT_PATH", "").strip() or DEBUG_OUTPUT_PATH


def write_debug_output(output: Any) -> None:
    path = debug_output_path()
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(output, handle, indent=2)
            handle.write("\n")
    except OSError as exc:
        print(
            f"scan-runtime debug: could not write {path}: {exc}",
            file=sys.stderr,
        )


def read_output_from_stdin() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("output JSON is required on stdin")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"stdin is not valid JSON: {exc}")


def load_runtime_identity() -> dict[str, str]:
    values = {
        "scanJobId": os.environ.get("VULSEEK_SCAN_JOB_ID", "").strip(),
        "taskId": os.environ.get("VULSEEK_TASK_ID", "").strip(),
        "stageName": os.environ.get("VULSEEK_STAGE_NAME", "").strip(),
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        fail("runtime environment is missing " + ", ".join(missing))
    return values


def is_retryable_request_error(error: requests.RequestException) -> bool:
    return isinstance(
        error,
        (requests.ConnectionError, requests.Timeout),
    )


def request_json(
    url: str,
    headers: dict[str, str],
    method: str = "GET",
    json_body: Any | None = None,
) -> Any:
    last_error: requests.RequestException | None = None
    for attempt in range(MAX_REQUEST_ATTEMPTS):
        try:
            if method.upper() == "POST":
                response = requests.post(
                    url, headers=headers, json=json_body, timeout=30
                )
            else:
                response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()
            body = response.text
            status = response.status_code
            break
        except requests.HTTPError as exc:
            response = exc.response
            status = response.status_code if response is not None else "unknown"
            detail = response.text if response is not None else str(exc)
            fail(f"API HTTP {status}: {detail or exc}")
        except requests.RequestException as exc:
            last_error = exc
            if (
                not is_retryable_request_error(exc)
                or attempt == MAX_REQUEST_ATTEMPTS - 1
            ):
                fail(
                    f"cannot reach runtime API after {attempt + 1} attempts: "
                    f"{exc}"
                )
            time.sleep(RETRY_DELAYS_SECONDS[attempt])
    else:
        fail(f"cannot reach runtime API: {last_error}")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        fail(f"runtime API returned non-JSON (HTTP {status})")
    return payload


def downstream_capacity(args: argparse.Namespace) -> None:
    api_url = (args.api_url or os.environ.get("VULSEEK_RUNTIME_API_URL") or "").rstrip(
        "/"
    )
    token = args.token or os.environ.get("VULSEEK_RUNTIME_TOKEN") or ""
    if not api_url:
        fail("VULSEEK_RUNTIME_API_URL is not set")
    if not token:
        fail("VULSEEK_RUNTIME_TOKEN is not set")
    context = load_runtime_identity()
    query = ""
    if args.to_stage:
        query = f"?{urllib.parse.urlencode({'toStage': args.to_stage})}"
    payload = request_json(
        f"{api_url}{CAPACITY_PATH}{query}",
        {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Vulseek-Scan-Job-Id": str(context["scanJobId"]),
            "X-Vulseek-Task-Id": str(context["taskId"]),
        },
    )
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def running_tasks(args: argparse.Namespace) -> None:
    api_url = (args.api_url or os.environ.get("VULSEEK_RUNTIME_API_URL") or "").rstrip(
        "/"
    )
    token = args.token or os.environ.get("VULSEEK_RUNTIME_TOKEN") or ""
    stage = (args.stage or "").strip()
    if not api_url:
        fail("VULSEEK_RUNTIME_API_URL is not set")
    if not token:
        fail("VULSEEK_RUNTIME_TOKEN is not set")
    if not stage:
        fail("--stage is required")
    context = load_runtime_identity()
    query = urllib.parse.urlencode({"stage": stage})
    payload = request_json(
        f"{api_url}{RUNNING_TASKS_PATH}?{query}",
        {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Vulseek-Scan-Job-Id": str(context["scanJobId"]),
            "X-Vulseek-Task-Id": str(context["taskId"]),
        },
    )
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def stage_outputs(args: argparse.Namespace) -> None:
    api_url = (args.api_url or os.environ.get("VULSEEK_RUNTIME_API_URL") or "").rstrip(
        "/"
    )
    token = args.token or os.environ.get("VULSEEK_RUNTIME_TOKEN") or ""
    stage = (args.stage or "").strip()
    if not api_url:
        fail("VULSEEK_RUNTIME_API_URL is not set")
    if not token:
        fail("VULSEEK_RUNTIME_TOKEN is not set")
    if not stage:
        fail("--stage is required")
    context = load_runtime_identity()
    query = urllib.parse.urlencode({"stage": stage})
    payload = request_json(
        f"{api_url}{STAGE_OUTPUTS_PATH}?{query}",
        {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Vulseek-Scan-Job-Id": str(context["scanJobId"]),
            "X-Vulseek-Task-Id": str(context["taskId"]),
        },
    )
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def poll_queued_tasks(args: argparse.Namespace) -> None:
    api_url = (args.api_url or os.environ.get("VULSEEK_RUNTIME_API_URL") or "").rstrip(
        "/"
    )
    token = args.token or os.environ.get("VULSEEK_RUNTIME_TOKEN") or ""
    stage = (args.stage or "").strip()
    if not api_url:
        fail("VULSEEK_RUNTIME_API_URL is not set")
    if not token:
        fail("VULSEEK_RUNTIME_TOKEN is not set")
    if not stage:
        fail("--stage is required")
    context = load_runtime_identity()
    query = urllib.parse.urlencode({"stage": stage})
    payload = request_json(
        f"{api_url}{POLL_QUEUED_TASKS_PATH}?{query}",
        {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Vulseek-Scan-Job-Id": str(context["scanJobId"]),
            "X-Vulseek-Task-Id": str(context["taskId"]),
        },
        method="POST",
    )
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def queued_tasks(args: argparse.Namespace) -> None:
    api_url = (args.api_url or os.environ.get("VULSEEK_RUNTIME_API_URL") or "").rstrip(
        "/"
    )
    token = args.token or os.environ.get("VULSEEK_RUNTIME_TOKEN") or ""
    stage = (args.stage or "").strip()
    if not api_url:
        fail("VULSEEK_RUNTIME_API_URL is not set")
    if not token:
        fail("VULSEEK_RUNTIME_TOKEN is not set")
    if not stage:
        fail("--stage is required")
    context = load_runtime_identity()
    query = urllib.parse.urlencode({"stage": stage})
    payload = request_json(
        f"{api_url}{QUEUED_TASKS_PATH}?{query}",
        {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Vulseek-Scan-Job-Id": str(context["scanJobId"]),
            "X-Vulseek-Task-Id": str(context["taskId"]),
        },
    )
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def complete_queued_tasks(args: argparse.Namespace) -> None:
    api_url = (args.api_url or os.environ.get("VULSEEK_RUNTIME_API_URL") or "").rstrip(
        "/"
    )
    token = args.token or os.environ.get("VULSEEK_RUNTIME_TOKEN") or ""
    stage = (args.stage or os.environ.get("VULSEEK_STAGE_NAME") or "").strip()
    message_ids = [
        str(item).strip()
        for item in (args.message_id or [])
        if str(item).strip()
    ]
    if not api_url:
        fail("VULSEEK_RUNTIME_API_URL is not set")
    if not token:
        fail("VULSEEK_RUNTIME_TOKEN is not set")
    if not stage:
        fail("--stage is required")
    if not message_ids:
        fail("--message-id is required")
    context = load_runtime_identity()
    query = urllib.parse.urlencode({"stage": stage})
    payload = request_json(
        f"{api_url}{QUEUED_TASKS_PATH}?{query}",
        {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Vulseek-Scan-Job-Id": str(context["scanJobId"]),
            "X-Vulseek-Task-Id": str(context["taskId"]),
        },
        method="POST",
        json_body={"messageIds": message_ids},
    )
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def post_task_output(args: argparse.Namespace) -> None:
    api_url = (args.api_url or os.environ.get("VULSEEK_RUNTIME_API_URL") or "").rstrip(
        "/"
    )
    token = args.token or os.environ.get("VULSEEK_RUNTIME_TOKEN") or ""
    if not api_url:
        fail("VULSEEK_RUNTIME_API_URL is not set")
    if not token:
        fail("VULSEEK_RUNTIME_TOKEN is not set")
    output = read_output_from_stdin()
    body: dict[str, Any] = {"output": output}
    if args.route:
        body["routeKey"] = args.route
    if getattr(args, "submission_key", None):
        body["submissionKey"] = args.submission_key
    context = load_runtime_identity()
    payload = request_json(
        f"{api_url}{SUBMIT_OUTPUT_PATH}",
        {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Vulseek-Scan-Job-Id": str(context["scanJobId"]),
            "X-Vulseek-Task-Id": str(context["taskId"]),
        },
        method="POST",
        json_body=body,
    )
    write_debug_output(output)
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


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
    capacity.add_argument("--api-url")
    capacity.add_argument("--token")
    capacity.set_defaults(func=downstream_capacity)

    running = subparsers.add_parser(
        "running-tasks",
        help="Query active tasks for a pipeline stage",
    )
    running.add_argument("--stage", required=True)
    running.add_argument("--api-url")
    running.add_argument("--token")
    running.set_defaults(func=running_tasks)

    outputs = subparsers.add_parser(
        "stage-outputs",
        help="Query completed Messages for a downstream pipeline stage",
    )
    outputs.add_argument("--stage", required=True)
    outputs.add_argument("--api-url")
    outputs.add_argument("--token")
    outputs.set_defaults(func=stage_outputs)

    queued = subparsers.add_parser(
        "query-messages",
        help="Peek waiting inbound Messages on the current stage queue without taking them",
    )
    queued.add_argument("--stage", required=True)
    queued.add_argument("--api-url")
    queued.add_argument("--token")
    queued.set_defaults(func=queued_tasks)

    poll_queued = subparsers.add_parser(
        "poll-messages",
        help="Take waiting inbound Messages from this stage queue",
    )
    poll_queued.add_argument("--stage", required=True)
    poll_queued.add_argument("--api-url")
    poll_queued.add_argument("--token")
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
    complete_queued.add_argument("--api-url")
    complete_queued.add_argument("--token")
    complete_queued.set_defaults(func=complete_queued_tasks)

    submit = subparsers.add_parser(
        "submit-message",
        help="Validate and submit a structured Message for the current task",
    )
    submit.add_argument("--route", dest="route")
    submit.add_argument("--submission-key", dest="submission_key")
    submit.add_argument("--api-url")
    submit.add_argument("--token")
    submit.set_defaults(func=submit_output)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
