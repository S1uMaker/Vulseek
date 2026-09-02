"""Allowlisted SQL metadata for the agent-owned Research Registry."""

from collections import namedtuple


EntitySpec = namedtuple(
    "EntitySpec",
    [
        "name",
        "table",
        "id_column",
        "columns",
        "required_create",
        "mutable",
        "json_columns",
        "list_columns",
        "identity_columns",
    ],
)


ENTITY_SPECS = {
    "track": EntitySpec(
        "track",
        "research_tracks",
        "trackId",
        (
            "trackId",
            "scanJobId",
            "trackKey",
            "approachFamily",
            "researchIdea",
            "scope",
            "mechanisms",
            "status",
            "coverage",
            "evidenceRefs",
            "findingIds",
            "blockReason",
            "reopenCondition",
            "nextStep",
            "iteration",
            "revision",
            "createdAt",
            "updatedAt",
        ),
        ("trackId", "trackKey", "approachFamily", "researchIdea"),
        {
            "trackKey",
            "approachFamily",
            "researchIdea",
            "scope",
            "mechanisms",
            "status",
            "coverage",
            "evidenceRefs",
            "findingIds",
            "blockReason",
            "reopenCondition",
            "nextStep",
            "iteration",
        },
        {"scope", "coverage"},
        {"mechanisms", "evidenceRefs", "findingIds"},
        ("trackId", "trackKey"),
    ),
    "finding": EntitySpec(
        "finding",
        "research_findings",
        "findingId",
        (
            "findingId",
            "scanJobId",
            "trackId",
            "producerTaskId",
            "messageId",
            "content",
            "status",
            "latestValidationVerdict",
            "latestReviewDecision",
            "requiredEvidence",
            "revision",
            "createdAt",
            "updatedAt",
        ),
        ("findingId", "trackId", "content"),
        {
            "trackId",
            "producerTaskId",
            "messageId",
            "content",
            "status",
            "latestValidationVerdict",
            "latestReviewDecision",
            "requiredEvidence",
        },
        {"content"},
        {"requiredEvidence"},
        ("findingId",),
    ),
    "primitive": EntitySpec(
        "primitive",
        "exploit_primitives",
        "primitiveId",
        (
            "primitiveId",
            "scanJobId",
            "findingId",
            "name",
            "capability",
            "requiredInput",
            "producedCapability",
            "trustLevel",
            "status",
            "evidenceRefs",
            "revision",
            "createdAt",
            "updatedAt",
        ),
        ("primitiveId", "findingId", "name", "capability", "trustLevel"),
        {
            "findingId",
            "name",
            "capability",
            "requiredInput",
            "producedCapability",
            "trustLevel",
            "status",
            "evidenceRefs",
        },
        {"requiredInput", "producedCapability"},
        {"evidenceRefs"},
        ("primitiveId",),
    ),
    "chain": EntitySpec(
        "chain",
        "exploit_chains",
        "chainId",
        (
            "chainId",
            "scanJobId",
            "chainKey",
            "status",
            "steps",
            "entrypoint",
            "requiredCapabilities",
            "producedCapabilities",
            "trustBoundaryCrossings",
            "deploymentConditions",
            "primitiveGaps",
            "successTarget",
            "revision",
            "createdAt",
            "updatedAt",
        ),
        ("chainId", "chainKey"),
        {
            "chainKey",
            "status",
            "steps",
            "entrypoint",
            "requiredCapabilities",
            "producedCapabilities",
            "trustBoundaryCrossings",
            "deploymentConditions",
            "primitiveGaps",
            "successTarget",
        },
        {"steps", "entrypoint", "primitiveGaps", "successTarget"},
        {"requiredCapabilities", "producedCapabilities", "trustBoundaryCrossings", "deploymentConditions"},
        ("chainId", "chainKey"),
    ),
}


def quote_identifier(identifier):
    """Quote a compile-time allowlisted PostgreSQL identifier."""
    return '"{}"'.format(identifier.replace('"', '""'))


def get_spec(entity):
    try:
        return ENTITY_SPECS[entity]
    except KeyError:
        raise ValueError("unknown Research entity: {}".format(entity))


def validate_values(spec, values, required=True):
    unknown = set(values) - set(spec.columns)
    if unknown:
        raise ValueError("unknown {} fields: {}".format(spec.name, ", ".join(sorted(unknown))))
    if required:
        missing = set(spec.required_create) - set(values)
        if missing:
            raise ValueError("missing {} fields: {}".format(spec.name, ", ".join(sorted(missing))))
    return values


def validate_patch(spec, patch):
    unknown = set(patch) - spec.mutable
    if unknown:
        raise ValueError("unknown or immutable {} fields: {}".format(spec.name, ", ".join(sorted(unknown))))
    if not patch:
        raise ValueError("{} update must change at least one field".format(spec.name))
    return patch


def _ordered_fields(spec, values):
    return [field for field in spec.columns if field in values]


def build_insert_statement(spec, values):
    validate_values(spec, values, required=False)
    fields = _ordered_fields(spec, values)
    if not fields:
        raise ValueError("{} create has no fields".format(spec.name))
    columns = ", ".join(quote_identifier(field) for field in fields)
    placeholders = ", ".join(["%s"] * len(fields))
    statement = (
        "INSERT INTO {} ({}) VALUES ({}) "
        "ON CONFLICT DO NOTHING RETURNING *"
    ).format(quote_identifier(spec.table), columns, placeholders)
    return statement, [values[field] for field in fields]


def build_update_statement(spec, scan_job_id, entity_id, expected_revision, patch):
    validate_patch(spec, patch)
    fields = _ordered_fields(spec, patch)
    assignments = ["{} = %s".format(quote_identifier(field)) for field in fields]
    assignments.extend(
        [
            '{} = {} + 1'.format(quote_identifier("revision"), quote_identifier("revision")),
            '{} = NOW()'.format(quote_identifier("updatedAt")),
        ]
    )
    statement = (
        "UPDATE {} SET {} WHERE {} = %s AND {} = %s AND {} = %s RETURNING *"
    ).format(
        quote_identifier(spec.table),
        ", ".join(assignments),
        quote_identifier("scanJobId"),
        quote_identifier(spec.id_column),
        quote_identifier("revision"),
    )
    params = [patch[field] for field in fields]
    params.extend([scan_job_id, entity_id, expected_revision])
    return statement, params


def build_delete_statement(spec, scan_job_id, entity_id, expected_revision):
    statement = (
        "DELETE FROM {} WHERE {} = %s AND {} = %s AND {} = %s RETURNING *"
    ).format(
        quote_identifier(spec.table),
        quote_identifier("scanJobId"),
        quote_identifier(spec.id_column),
        quote_identifier("revision"),
    )
    return statement, [scan_job_id, entity_id, expected_revision]
