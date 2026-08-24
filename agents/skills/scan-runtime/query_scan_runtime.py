#!/usr/bin/env python3
"""Query Vulseek scan-job runtime info from the internal HTTP API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

CAPACITY_PATH = "/api/internal/scan/runtime/downstream-capacity"
RUNNING_TASKS_PATH = "/api/internal/scan/runtime/running-tasks"


def fail(message: str) -> None:
    print(f"scan-runtime failed: {message}", file=sys.stderr)
    raise SystemExit(1)


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


def request_json(url: str, headers: dict[str, str]) -> Any:
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        fail(f"API HTTP {exc.code}: {detail or exc.reason}")
    except urllib.error.URLError as exc:
        fail(f"cannot reach runtime API: {exc.reason}")
    except TimeoutError:
        fail("runtime API timed out")
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

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
