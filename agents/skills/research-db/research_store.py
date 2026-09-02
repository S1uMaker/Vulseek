"""Parameterized PostgreSQL access for current Research Registry state."""

import datetime
import json
import os
from contextlib import nullcontext

from research_mutations import (
    ENTITY_SPECS,
    build_delete_statement,
    build_insert_statement,
    build_update_statement,
    get_spec,
    quote_identifier,
    validate_patch,
    validate_values,
)


class ResearchStoreError(Exception):
    pass


class ResearchConflict(ResearchStoreError):
    def __init__(self, status, entity=None, expected_revision=None, current_revision=None):
        super().__init__(status)
        self.status = status
        self.entity = entity
        self.expected_revision = expected_revision
        self.current_revision = current_revision


def _timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _row_to_dict(cursor, row):
    if row is None:
        return None
    if isinstance(row, dict):
        return dict(row)
    names = []
    for description in cursor.description or []:
        name = getattr(description, "name", None)
        names.append(name if name is not None else description[0])
    return dict(zip(names, row))


def _jsonb(value):
    try:
        from psycopg.types.json import Jsonb

        return Jsonb(value)
    except ImportError:
        return value


class ResearchStore:
    def __init__(self, connection, scan_job_id, task_id="", task_context=None):
        if not scan_job_id:
            raise ValueError("VULSEEK_SCAN_JOB_ID is required")
        self.connection = connection
        self.scan_job_id = scan_job_id
        self.task_id = task_id
        self.task_context = task_context or {}

    def _transaction(self):
        transaction = getattr(self.connection, "transaction", None)
        return transaction() if transaction else nullcontext()

    def _execute(self, statement, params=()):
        with self.connection.cursor() as cursor:
            cursor.execute(statement, tuple(params))
            return cursor, cursor.fetchone() if cursor.description else None

    def _fetch_one(self, statement, params=()):
        with self.connection.cursor() as cursor:
            cursor.execute(statement, tuple(params))
            return _row_to_dict(cursor, cursor.fetchone())

    def _fetch_all(self, statement, params=()):
        with self.connection.cursor() as cursor:
            cursor.execute(statement, tuple(params))
            return [_row_to_dict(cursor, row) for row in cursor.fetchall()]

    def _select_by_id(self, spec, entity_id, lock=False):
        statement = (
            'SELECT * FROM {} WHERE {} = %s AND {} = %s{}'
        ).format(
            quote_identifier(spec.table),
            quote_identifier("scanJobId"),
            quote_identifier(spec.id_column),
            " FOR UPDATE" if lock else "",
        )
        return self._fetch_one(statement, [self.scan_job_id, entity_id])

    def _select_by_identity(self, spec, values, lock=False):
        identity = [field for field in spec.identity_columns if field != "scanJobId"]
        if not identity:
            return None
        clauses = ['"scanJobId" = %s']
        params = [self.scan_job_id]
        for field in identity:
            if field not in values:
                return None
            clauses.append("{} = %s".format(quote_identifier(field)))
            params.append(values[field])
        statement = "SELECT * FROM {} WHERE {}{}".format(
            quote_identifier(spec.table),
            " AND ".join(clauses),
            " FOR UPDATE" if lock else "",
        )
        return self._fetch_one(statement, params)

    def _prepare_values(self, spec, values):
        values = dict(values)
        values["scanJobId"] = self.scan_job_id
        values.setdefault("revision", 0)
        now = _timestamp()
        values.setdefault("createdAt", now)
        values.setdefault("updatedAt", now)
        if spec.name == "finding":
            producer_task_id = values.get("producerTaskId") or self.task_id
            if producer_task_id and self.task_id and producer_task_id != self.task_id:
                raise ResearchStoreError(
                    "finding producerTaskId does not match the current task context"
                )
            if producer_task_id:
                values["producerTaskId"] = producer_task_id
            message_id = values.get("messageId") or os.environ.get(
                "VULSEEK_TASK_OUTPUT_ID"
            )
            if message_id:
                values["messageId"] = message_id

            expected_track_id = self._expected_track_id()
            if expected_track_id and values.get("trackId") != expected_track_id:
                raise ResearchStoreError(
                    "finding trackId does not match the current task context"
                )

        defaults = {
            "scope": {},
            "coverage": {},
            "mechanisms": [],
            "evidenceRefs": [],
            "findingIds": [],
            "requiredEvidence": [],
            "requiredInput": {},
            "producedCapability": {},
            "steps": [],
            "entrypoint": {},
            "requiredCapabilities": [],
            "producedCapabilities": [],
            "trustBoundaryCrossings": [],
            "deploymentConditions": [],
            "primitiveGaps": [],
            "successTarget": {},
        }
        for field, default in defaults.items():
            if field in spec.columns:
                values.setdefault(field, default)
        return validate_values(spec, values)

    def _expected_track_id(self):
        stage_input = self.task_context.get("stageInput")
        if not isinstance(stage_input, dict):
            return None
        if isinstance(stage_input.get("trackId"), str):
            return stage_input["trackId"]
        track = stage_input.get("track")
        if not isinstance(track, dict):
            return None
        if isinstance(track.get("trackId"), str):
            return track["trackId"]
        if isinstance(track.get("trackKey"), str):
            # Track IDs are stable identities and may outlive a track-key rename.
            # Resolve the current key from the registry before using the legacy
            # `track-<trackKey>` convention.
            row = self._fetch_one(
                'SELECT "trackId" FROM "research_tracks" WHERE "scanJobId" = %s AND "trackKey" = %s',
                [self.scan_job_id, track["trackKey"]],
            )
            if row and isinstance(row.get("trackId"), str):
                return row["trackId"]
            return "track-{}".format(track["trackKey"])
        return None

    def _adapt_values(self, spec, values):
        return {
            field: _jsonb(value) if field in spec.json_columns or field in spec.list_columns else value
            for field, value in values.items()
        }

    @staticmethod
    def _matches(row, values):
        return all(row.get(field) == value for field, value in values.items())

    def list_entities(self, entity, filters=None, limit=100, offset=0):
        spec = get_spec(entity)
        filters = filters or {}
        unknown = set(filters) - set(spec.columns) - {"status"}
        if unknown:
            raise ValueError("unsupported {} filters: {}".format(entity, ", ".join(sorted(unknown))))
        clauses = ['"scanJobId" = %s']
        params = [self.scan_job_id]
        for field in spec.columns:
            if field in filters and filters[field] is not None:
                clauses.append("{} = %s".format(quote_identifier(field)))
                params.append(filters[field])
        statement = (
            'SELECT * FROM {} WHERE {} ORDER BY "updatedAt" DESC LIMIT %s OFFSET %s'
        ).format(quote_identifier(spec.table), " AND ".join(clauses))
        params.extend([limit, offset])
        return {"status": "ok", "items": self._fetch_all(statement, params)}

    def get_entity(self, entity, entity_id):
        spec = get_spec(entity)
        row = self._select_by_id(spec, entity_id)
        if row is None:
            return {"status": "notFound", "entity": None}
        return {"status": "ok", "entity": row}

    def create_entity(self, entity, values):
        spec = get_spec(entity)
        requested_values = dict(values)
        values = self._prepare_values(spec, values)
        stored_values = self._adapt_values(spec, values)
        with self._transaction():
            statement, params = build_insert_statement(spec, stored_values)
            with self.connection.cursor() as cursor:
                cursor.execute(statement, tuple(params))
                row = _row_to_dict(cursor, cursor.fetchone())
            if row is not None:
                return {"status": "created", "revision": row["revision"], "entity": row}

            current = self._select_by_id(spec, values[spec.id_column], lock=True)
            if current is None:
                current = self._select_by_identity(spec, values, lock=True)
            comparable_values = dict(requested_values)
            comparable_values["scanJobId"] = self.scan_job_id
            if current is not None and self._matches(current, comparable_values):
                return {"status": "alreadyExists", "revision": current["revision"], "entity": current}
            raise ResearchConflict("conflict", current, None, current.get("revision") if current else None)

    def update_entity(self, entity, entity_id, expected_revision, patch):
        spec = get_spec(entity)
        validate_patch(spec, patch)
        stored_patch = self._adapt_values(spec, patch)
        with self._transaction():
            current = self._select_by_id(spec, entity_id, lock=True)
            if current is None:
                raise ResearchConflict("notFound", None, expected_revision, None)
            if self._matches(current, patch):
                return {"status": "alreadyApplied", "revision": current["revision"], "entity": current}

            statement, params = build_update_statement(
                spec,
                self.scan_job_id,
                entity_id,
                expected_revision,
                stored_patch,
            )
            with self.connection.cursor() as cursor:
                cursor.execute(statement, tuple(params))
                row = _row_to_dict(cursor, cursor.fetchone())
            if row is not None:
                return {"status": "updated", "revision": row["revision"], "entity": row}

            current = self._select_by_id(spec, entity_id, lock=True)
            if current is not None and self._matches(current, patch):
                return {"status": "alreadyApplied", "revision": current["revision"], "entity": current}
            raise ResearchConflict(
                "conflict",
                current,
                expected_revision,
                current.get("revision") if current else None,
            )

    def delete_entity(self, entity, entity_id, expected_revision):
        spec = get_spec(entity)
        with self._transaction():
            statement, params = build_delete_statement(
                spec, self.scan_job_id, entity_id, expected_revision
            )
            with self.connection.cursor() as cursor:
                cursor.execute(statement, tuple(params))
                row = _row_to_dict(cursor, cursor.fetchone())
            if row is not None:
                return {"status": "deleted", "entity": row}

            current = self._select_by_id(spec, entity_id, lock=True)
            if current is None:
                return {"status": "alreadyDeleted", "entity": None}
            raise ResearchConflict(
                "conflict",
                current,
                expected_revision,
                current.get("revision"),
            )


def connect_database(database_url):
    try:
        import psycopg
    except ImportError as error:
        raise RuntimeError("psycopg is required for research-db database operations") from error
    return psycopg.connect(database_url)
