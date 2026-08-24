#!/usr/bin/env python3
"""Direct, typed CLI for the agent-owned Research Registry."""

import argparse
import json
import os
import sys

from research_mutations import ENTITY_SPECS
from research_store import (
    ResearchConflict,
    ResearchStore,
    ResearchStoreError,
    connect_database,
)


ENTITY_FLAGS = {
    "track": {
        "id": "track-id",
        "required": ["track-key", "approach-family", "research-idea"],
        "scalar": ["track-key", "approach-family", "research-idea", "status", "block-reason", "reopen-condition", "next-step", "iteration"],
        "json": ["scope", "coverage"],
        "lists": ["mechanism", "evidence-ref", "finding-id-ref"],
    },
    "finding": {
        "id": "finding-id",
        "required": ["track-id", "content-file"],
        "scalar": ["track-id", "producer-task-id", "status", "latest-validation-verdict", "latest-review-decision"],
        "json": ["content"],
        "lists": ["required-evidence"],
    },
    "primitive": {
        "id": "primitive-id",
        "required": ["finding-id", "name", "capability", "trust-level"],
        "scalar": ["finding-id", "name", "capability", "trust-level", "status"],
        "json": ["required-input", "produced-capability"],
        "lists": ["evidence-ref"],
    },
    "chain": {
        "id": "chain-id",
        "required": ["chain-key"],
        "scalar": ["chain-key", "status"],
        "json": ["steps", "entrypoint", "primitive-gaps", "success-target"],
        "lists": ["required-capability", "produced-capability", "trust-boundary-crossing", "deployment-condition"],
    },
}


def _dest(flag):
    return flag.replace("-", "_")


def _add_create_update_fields(parser, entity, create):
    config = ENTITY_FLAGS[entity]
    parser.add_argument("--{}".format(config["id"]), required=True)
    required = set(config["required"] if create else [])
    for flag in config["scalar"]:
        parser.add_argument(
            "--{}".format(flag),
            required=flag in required,
            default=argparse.SUPPRESS,
        )
    for flag in config["json"]:
        parser.add_argument(
            "--{}-file".format(flag),
            required=("{}-file".format(flag) in required),
            default=argparse.SUPPRESS,
        )
    for flag in config["lists"]:
        parser.add_argument(
            "--{}".format(flag),
            action="append",
            default=argparse.SUPPRESS,
        )
    if not create:
        parser.add_argument("--expected-revision", required=True, type=int)
        for flag in ["block-reason", "reopen-condition", "next-step", "latest-validation-verdict", "latest-review-decision"]:
            if flag in config["scalar"]:
                parser.add_argument(
                    "--clear-{}".format(flag),
                    action="store_true",
                    default=False,
                )


def _add_parser_fields(parser, entity, create):
    _add_create_update_fields(parser, entity, create)


def build_parser():
    parser = argparse.ArgumentParser(prog="research_db.py")
    commands = parser.add_subparsers(dest="command")
    for entity, config in ENTITY_FLAGS.items():
        list_parser = commands.add_parser("list-{}".format("tracks" if entity == "track" else "findings" if entity == "finding" else "primitives" if entity == "primitive" else "chains"))
        list_parser.set_defaults(action="list", entity=entity)
        list_parser.add_argument("--status")
        list_parser.add_argument("--limit", type=int, default=100)
        list_parser.add_argument("--offset", type=int, default=0)
        if entity == "finding":
            list_parser.add_argument("--track-id")
        if entity == "primitive":
            list_parser.add_argument("--finding-id")

        get_parser = commands.add_parser("get-{}".format(entity))
        get_parser.set_defaults(action="get", entity=entity)
        get_parser.add_argument("--{}".format(config["id"]), required=True)

        create_parser = commands.add_parser("create-{}".format(entity))
        create_parser.set_defaults(action="create", entity=entity)
        _add_parser_fields(create_parser, entity, True)

        update_parser = commands.add_parser("update-{}".format(entity))
        update_parser.set_defaults(action="update", entity=entity)
        _add_parser_fields(update_parser, entity, False)

        delete_parser = commands.add_parser("delete-{}".format(entity))
        delete_parser.set_defaults(action="delete", entity=entity)
        delete_parser.add_argument("--{}".format(config["id"]), required=True)
        delete_parser.add_argument("--expected-revision", required=True, type=int)
    return parser


def _read_json_file(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as error:
        raise ValueError("invalid JSON artifact: {}".format(path)) from error


def _arg(args, flag):
    return getattr(args, _dest(flag), None)


def _has_arg(args, flag):
    return hasattr(args, _dest(flag))


def _entity_values(args, entity, include_id=True):
    config = ENTITY_FLAGS[entity]
    values = {}
    if include_id:
        values[ENTITY_SPECS[entity].id_column] = _arg(args, config["id"])
    scalar_to_column = {
        "track-key": "trackKey",
        "approach-family": "approachFamily",
        "research-idea": "researchIdea",
        "block-reason": "blockReason",
        "reopen-condition": "reopenCondition",
        "next-step": "nextStep",
        "track-id": "trackId",
        "producer-task-id": "producerTaskId",
        "content": "content",
        "finding-id": "findingId",
        "trust-level": "trustLevel",
        "required-input": "requiredInput",
        "produced-capability": "producedCapability",
        "chain-key": "chainKey",
        "entrypoint": "entrypoint",
        "primitive-gaps": "primitiveGaps",
        "success-target": "successTarget",
    }
    for flag in config["scalar"]:
        if _has_arg(args, flag):
            column = scalar_to_column.get(flag, _camel_case(flag))
            value = _arg(args, flag)
            if flag == "iteration":
                value = int(value)
            values[column] = value
    for flag in config["json"]:
        file_flag = "{}-file".format(flag)
        if _has_arg(args, file_flag):
            values[scalar_to_column.get(flag, _camel_case(flag))] = _read_json_file(_arg(args, file_flag))
    list_to_column = {
        "mechanism": "mechanisms",
        "evidence-ref": "evidenceRefs",
        "finding-id-ref": "findingIds",
        "required-evidence": "requiredEvidence",
        "required-capability": "requiredCapabilities",
        "produced-capability": "producedCapabilities",
        "trust-boundary-crossing": "trustBoundaryCrossings",
        "deployment-condition": "deploymentConditions",
    }
    for flag in config["lists"]:
        if _has_arg(args, flag):
            values[list_to_column[flag]] = list(_arg(args, flag))
    if not include_id:
        for flag in ["block-reason", "reopen-condition", "next-step", "latest-validation-verdict", "latest-review-decision"]:
            if flag in config["scalar"] and getattr(args, "clear_{}".format(_dest(flag)), False):
                values[scalar_to_column.get(flag, _camel_case(flag))] = None
    if entity == "finding" and _has_arg(args, "content-file"):
        values["content"] = _read_json_file(_arg(args, "content-file"))
    return values


def _camel_case(flag):
    pieces = flag.split("-")
    return pieces[0] + "".join(piece.title() for piece in pieces[1:])


def _print_json(value):
    print(json.dumps(value, separators=(",", ":"), ensure_ascii=True))


def _load_stage_input():
    path = "/task/inputs/task-input.json"
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise ValueError("invalid research stage input") from error
    if not isinstance(value, dict):
        raise ValueError("invalid research stage input")
    return {"stageInput": value}


def run(argv=None, connect_fn=connect_database):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as error:
        return 0 if error.code == 0 else 2
    if not getattr(args, "command", None):
        parser.print_usage(file=sys.stderr)
        return 2

    database_url = os.environ.get("VULSEEK_RESEARCH_DATABASE_URL", "")
    scan_job_id = os.environ.get("VULSEEK_SCAN_JOB_ID", "")
    task_id = os.environ.get("VULSEEK_TASK_ID", "")
    if not database_url or not scan_job_id:
        print("research database context is not configured", file=sys.stderr)
        return 4

    connection = None
    try:
        task_context = _load_stage_input()
        connection = connect_fn(database_url)
        store = ResearchStore(connection, scan_job_id, task_id, task_context)
        if args.action == "list":
            filters = {}
            if getattr(args, "status", None) is not None:
                filters["status"] = args.status
            if getattr(args, "track_id", None) is not None:
                filters["trackId"] = args.track_id
            if getattr(args, "finding_id", None) is not None:
                filters["findingId"] = args.finding_id
            result = store.list_entities(args.entity, filters, args.limit, args.offset)
        elif args.action == "get":
            result = store.get_entity(args.entity, _arg(args, ENTITY_FLAGS[args.entity]["id"]))
        elif args.action == "create":
            result = store.create_entity(args.entity, _entity_values(args, args.entity))
        elif args.action == "update":
            values = _entity_values(args, args.entity, include_id=False)
            entity_id = _arg(args, ENTITY_FLAGS[args.entity]["id"])
            result = store.update_entity(args.entity, entity_id, args.expected_revision, values)
        elif args.action == "delete":
            entity_id = _arg(args, ENTITY_FLAGS[args.entity]["id"])
            result = store.delete_entity(args.entity, entity_id, args.expected_revision)
        else:
            raise ValueError("unsupported Research command")
        _print_json(result)
        return 0
    except ResearchConflict as error:
        _print_json(
            {
                "status": error.status,
                "expectedRevision": error.expected_revision,
                "currentRevision": error.current_revision,
                "entity": error.entity,
            }
        )
        return 3
    except (ResearchStoreError, ValueError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 4 if isinstance(error, ResearchStoreError) else 2
    except Exception:
        print("research database operation failed", file=sys.stderr)
        return 4
    finally:
        if connection is not None and hasattr(connection, "close"):
            connection.close()


if __name__ == "__main__":
    raise SystemExit(run())
