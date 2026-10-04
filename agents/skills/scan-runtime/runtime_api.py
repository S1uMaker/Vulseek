#!/usr/bin/env python3
"""Shared auth, HTTP, and JSON helpers for Vulseek scan-runtime CLIs."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
from typing import Any

import requests

DEBUG_OUTPUT_PATH = "/task/output.json"
MAX_REQUEST_ATTEMPTS = 3
RETRY_DELAYS_SECONDS = (0.25, 0.5)

_tool_name = "runtime-api"


def set_tool_name(name: str) -> None:
    global _tool_name
    _tool_name = name.strip() or "runtime-api"


def fail(message: str) -> None:
    print(f"{_tool_name} failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def emit_json(payload: Any, exit_code: int = 0) -> None:
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")
    if exit_code:
        raise SystemExit(exit_code)


def read_json_stdin() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("JSON is required on stdin")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"stdin is not valid JSON: {exc}")


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
            f"{_tool_name} debug: could not write {path}: {exc}",
            file=sys.stderr,
        )


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
    return isinstance(error, (requests.ConnectionError, requests.Timeout))


def request_json(
    url: str,
    headers: dict[str, str],
    method: str = "GET",
    json_body: Any | None = None,
) -> Any:
    last_error: requests.RequestException | None = None
    for attempt in range(MAX_REQUEST_ATTEMPTS):
        try:
            method_name = method.upper()
            if method_name == "POST":
                response = requests.post(
                    url, headers=headers, json=json_body, timeout=30
                )
            elif method_name == "PATCH":
                response = requests.patch(
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
            if response is not None:
                try:
                    payload = json.loads(response.text)
                    emit_json(payload, 1)
                except json.JSONDecodeError:
                    pass
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
        return json.loads(body)
    except json.JSONDecodeError:
        fail(f"runtime API returned non-JSON (HTTP {status})")


def runtime_auth(args: Any) -> tuple[str, dict[str, str]]:
    api_url = (getattr(args, "api_url", None) or os.environ.get("VULSEEK_RUNTIME_API_URL") or "").rstrip(
        "/"
    )
    token = getattr(args, "token", None) or os.environ.get("VULSEEK_RUNTIME_TOKEN") or ""
    if not api_url:
        fail("VULSEEK_RUNTIME_API_URL is not set")
    if not token:
        fail("VULSEEK_RUNTIME_TOKEN is not set")
    context = load_runtime_identity()
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "X-Vulseek-Scan-Job-Id": str(context["scanJobId"]),
        "X-Vulseek-Task-Id": str(context["taskId"]),
    }
    return api_url, headers


def runtime_request(
    args: Any,
    path: str,
    *,
    method: str = "GET",
    query: dict[str, str] | None = None,
    json_body: Any | None = None,
) -> Any:
    api_url, headers = runtime_auth(args)
    if json_body is not None:
        headers = {**headers, "Content-Type": "application/json"}
    suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
    return request_json(
        f"{api_url}{path}{suffix}",
        headers,
        method=method,
        json_body=json_body,
    )


def add_runtime_flags(command: argparse.ArgumentParser) -> None:
    command.add_argument("--api-url")
    command.add_argument("--token")
