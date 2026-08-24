import io
import json
import os
import pathlib
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import research_db
from research_store import ResearchConflict, ResearchStore, ResearchStoreError


class _Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.description = None
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, statement, params):
        self.connection.queries.append((statement, params))
        row, rows, description = self.connection.responses.pop(0)
        self._rows = rows
        self.description = description
        self._row = row

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class _Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.transactions += 1
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.connection.completions += 1
        return False


class _Connection:
    def __init__(self, responses):
        self.responses = list(responses)
        self.queries = []
        self.transactions = 0
        self.completions = 0

    def cursor(self):
        return _Cursor(self)

    def transaction(self):
        return _Transaction(self)


def _response(row=None, rows=None, description=None):
    return row, list(rows or ([] if row is None else [row])), description


class ResearchDbCliContractTests(unittest.TestCase):
    def test_unknown_command_fails_before_connecting(self):
        connect = unittest.mock.Mock()
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            result = research_db.run(["apply-batch"], connect_fn=connect)

        self.assertEqual(result, 2)
        connect.assert_not_called()

    def test_unknown_flag_fails_before_connecting(self):
        connect = unittest.mock.Mock()
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            result = research_db.run(
                ["update-track", "--track-id", "track-a", "--unexpected", "value"],
                connect_fn=connect,
            )

        self.assertEqual(result, 2)
        connect.assert_not_called()

    def test_missing_database_context_does_not_print_database_url(self):
        connect = unittest.mock.Mock()
        stdout = io.StringIO()
        stderr = io.StringIO()

        with patch.dict(
            os.environ,
            {
                "VULSEEK_RESEARCH_DATABASE_URL": "postgresql://secret-user:secret-password@db/vulseek",
                "VULSEEK_SCAN_JOB_ID": "job-a",
                "VULSEEK_TASK_ID": "task-a",
            },
            clear=True,
        ), redirect_stdout(stdout), redirect_stderr(stderr):
            result = research_db.run(["list-tracks"], connect_fn=connect)

        self.assertNotEqual(result, 0)
        self.assertNotIn("secret-password", stdout.getvalue())
        self.assertNotIn("secret-password", stderr.getvalue())

    def test_cli_emits_json_only_for_successful_read(self):
        class FakeStore:
            def __init__(self, connection, scan_job_id, task_id, task_context=None):
                pass

            def list_entities(self, entity, filters, limit, offset):
                return {"status": "ok", "items": [{"trackId": "track-a"}]}

        stdout = io.StringIO()
        with patch.dict(
            os.environ,
            {
                "VULSEEK_RESEARCH_DATABASE_URL": "postgresql://user:password@db/vulseek",
                "VULSEEK_SCAN_JOB_ID": "job-a",
                "VULSEEK_TASK_ID": "task-a",
            },
            clear=True,
        ), patch.object(research_db, "ResearchStore", FakeStore), redirect_stdout(stdout):
            result = research_db.run(
                ["list-tracks"],
                connect_fn=lambda _: object(),
            )

        self.assertEqual(result, 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"status": "ok", "items": [{"trackId": "track-a"}]})

    def test_cli_uses_runtime_identity_from_environment(self):
        seen = {}

        class FakeStore:
            def __init__(self, connection, scan_job_id, task_id, task_context=None):
                seen["task_id"] = task_id
                seen["task_context"] = task_context

            def list_entities(self, entity, filters, limit, offset):
                return {"status": "ok", "items": []}

        stdout = io.StringIO()
        with patch.dict(
            os.environ,
            {
                "VULSEEK_RESEARCH_DATABASE_URL": "postgresql://user:password@db/vulseek",
                "VULSEEK_SCAN_JOB_ID": "job-a",
                "VULSEEK_TASK_ID": "task-current",
                "VULSEEK_STAGE_NAME": "track-plan",
            },
            clear=True,
        ), patch.object(research_db, "ResearchStore", FakeStore), redirect_stdout(stdout):
            result = research_db.run(
                ["list-tracks"],
                connect_fn=lambda _: object(),
            )

        self.assertEqual(result, 0)
        self.assertEqual(seen["task_id"], "task-current")
        self.assertEqual(seen["task_context"], {})


class ResearchStoreRevisionTests(unittest.TestCase):
    def test_create_is_one_transaction_and_returns_revision(self):
        row = {
            "trackId": "track-a",
            "scanJobId": "job-a",
            "trackKey": "track-a",
            "approachFamily": "parser",
            "researchIdea": "inspect parser",
            "revision": 0,
        }
        connection = _Connection([_response(row)])
        result = ResearchStore(connection, "job-a", "task-a").create_entity(
            "track",
            {
                "trackId": "track-a",
                "trackKey": "track-a",
                "approachFamily": "parser",
                "researchIdea": "inspect parser",
            },
        )

        self.assertEqual(result["status"], "created")
        self.assertEqual(result["revision"], 0)
        self.assertEqual(connection.transactions, 1)
        self.assertEqual(connection.completions, 1)
        self.assertEqual(len(connection.queries), 1)

    def test_update_uses_revision_cas_and_increments_once(self):
        current = {
            "trackId": "track-a",
            "scanJobId": "job-a",
            "status": "queued",
            "revision": 2,
        }
        updated = dict(current, status="active", revision=3)
        connection = _Connection([_response(current), _response(updated)])
        result = ResearchStore(connection, "job-a").update_entity(
            "track", "track-a", 2, {"status": "active"}
        )

        self.assertEqual(result["status"], "updated")
        self.assertEqual(result["revision"], 3)
        self.assertIn('"revision" = "revision" + 1', connection.queries[1][0])
        self.assertEqual(connection.queries[1][1][-1], 2)

    def test_stale_update_returns_conflict_without_second_write(self):
        current = {
            "trackId": "track-a",
            "scanJobId": "job-a",
            "status": "active",
            "revision": 4,
        }
        connection = _Connection([_response(current), _response(None), _response(current)])

        with self.assertRaises(ResearchConflict) as raised:
            ResearchStore(connection, "job-a").update_entity(
                "track", "track-a", 3, {"status": "exhausted"}
            )

        self.assertEqual(raised.exception.status, "conflict")
        self.assertEqual(raised.exception.current_revision, 4)
        self.assertEqual(len(connection.queries), 3)
        self.assertEqual(connection.transactions, 1)

    def test_repeated_absolute_update_is_already_applied(self):
        current = {
            "trackId": "track-a",
            "scanJobId": "job-a",
            "status": "active",
            "revision": 4,
        }
        connection = _Connection([_response(current)])
        result = ResearchStore(connection, "job-a").update_entity(
            "track", "track-a", 4, {"status": "active"}
        )

        self.assertEqual(result["status"], "alreadyApplied")
        self.assertEqual(result["revision"], 4)
        self.assertEqual(len(connection.queries), 1)

    def test_row_description_supports_psycopg_style_objects(self):
        class Description:
            name = "trackId"

        connection = _Connection([_response(None, [{"track-a"}], [Description()])])
        result = ResearchStore(connection, "job-a")._fetch_all(
            'SELECT "trackId" FROM "research_tracks"', []
        )
        self.assertEqual(result, [{"trackId": "track-a"}])

    def test_finding_uses_task_context_and_rejects_cross_track_write(self):
        connection = _Connection([_response({"trackId": "track-parser-normalization"})])
        store = ResearchStore(
            connection,
            "job-a",
            "task-a",
            {"stageInput": {"track": {"trackKey": "parser-normalization"}}},
        )

        with self.assertRaisesRegex(ResearchStoreError, "trackId"):
            store._prepare_values(
                __import__("research_mutations").ENTITY_SPECS["finding"],
                {"findingId": "finding-a", "trackId": "track-subprocess-native"},
            )

    def test_finding_rejects_stale_producer_task(self):
        connection = _Connection([])
        store = ResearchStore(
            connection,
            "job-a",
            "task-current",
            {"stageInput": {"trackId": "track-a"}},
        )

        with self.assertRaisesRegex(ResearchStoreError, "producerTaskId"):
            store._prepare_values(
                __import__("research_mutations").ENTITY_SPECS["finding"],
                {
                    "findingId": "finding-a",
                    "trackId": "track-a",
                    "producerTaskId": "task-stale",
                },
            )


if __name__ == "__main__":
    unittest.main()
