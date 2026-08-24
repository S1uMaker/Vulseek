-- Backfill compiled pipeline snapshots: add presentation.jobTabs and drop
-- the retired compile-time `capabilities` field. Job result tabs are inferred
-- from stage effects/plugins when jobTabs is missing.

CREATE OR REPLACE FUNCTION vulseek_pipeline_job_tab_candidates()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT $json$[
    {
      "id": "candidates",
      "label": "Candidates",
      "renderer": "candidate-results",
      "dataSource": "vulnerability-candidates",
      "columns": ["title", "filePath", "analysisResult", "verificationResult", "triageResult", "score", "createdAt"],
      "filters": ["analysisResult", "verificationResult", "triageResult"],
      "defaultSort": {"field": "createdAt", "direction": "desc"},
      "detail": "vulnerability-candidate"
    }
  ]$json$::jsonb;
$$;

CREATE OR REPLACE FUNCTION vulseek_pipeline_job_tab_research()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT $json$[
    {
      "id": "findings",
      "label": "Findings",
      "renderer": "entity-table",
      "dataSource": "research-findings",
      "columns": ["title", "trackKey", "vulnerabilityClass", "location", "status", "confidence", "updatedAt"],
      "filters": ["status"],
      "defaultSort": {"field": "updatedAt", "direction": "desc"},
      "detail": "research-finding"
    },
    {
      "id": "tracks",
      "label": "Tracks",
      "renderer": "entity-table",
      "dataSource": "research-tracks",
      "columns": ["trackKey", "approachFamily", "researchIdea", "status", "iteration", "updatedAt"],
      "filters": ["status"],
      "defaultSort": {"field": "updatedAt", "direction": "desc"},
      "detail": "research-track"
    },
    {
      "id": "primitives",
      "label": "Primitives",
      "renderer": "entity-table",
      "dataSource": "exploit-primitives",
      "columns": ["name", "findingId", "capability", "trustLevel", "status", "updatedAt"],
      "filters": ["status", "trustLevel"],
      "defaultSort": {"field": "updatedAt", "direction": "desc"},
      "detail": "exploit-primitive"
    },
    {
      "id": "chains",
      "label": "Chains",
      "renderer": "entity-table",
      "dataSource": "exploit-chains",
      "columns": ["chainKey", "status", "updatedAt"],
      "filters": ["status"],
      "defaultSort": {"field": "updatedAt", "direction": "desc"},
      "detail": "exploit-chain"
    }
  ]$json$::jsonb;
$$;

CREATE OR REPLACE FUNCTION vulseek_pipeline_job_tab_tob_goal()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT $json$[
    {
      "id": "goal-candidates",
      "label": "Goal Candidates",
      "renderer": "entity-table",
      "dataSource": "tob-goal-candidates",
      "columns": ["title", "status", "huntGoalId", "summary", "updatedAt"],
      "filters": ["status", "huntGoalId"],
      "defaultSort": {"field": "updatedAt", "direction": "desc"},
      "detail": "tob-goal-candidate"
    },
    {
      "id": "goal-findings",
      "label": "Goal Findings",
      "renderer": "entity-table",
      "dataSource": "tob-goal-findings",
      "columns": ["title", "status", "huntGoalId", "summary", "updatedAt"],
      "filters": ["status", "huntGoalId"],
      "defaultSort": {"field": "updatedAt", "direction": "desc"},
      "detail": "tob-goal-finding"
    }
  ]$json$::jsonb;
$$;

CREATE OR REPLACE FUNCTION vulseek_pipeline_snapshot_stages(snapshot jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF snapshot IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  IF jsonb_typeof(snapshot->'stages') = 'array' THEN
    RETURN COALESCE(snapshot->'stages', '[]'::jsonb);
  END IF;
  IF jsonb_typeof(snapshot->'stages') = 'object' THEN
    RETURN COALESCE(
      (SELECT jsonb_agg(value) FROM jsonb_each(snapshot->'stages')),
      '[]'::jsonb
    );
  END IF;
  RETURN '[]'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION vulseek_infer_pipeline_job_tabs(snapshot jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  stages jsonb := vulseek_pipeline_snapshot_stages(snapshot);
  has_research boolean := false;
  has_tob boolean := false;
  has_candidates boolean := false;
  tabs jsonb := '[]'::jsonb;
BEGIN
  SELECT
    COALESCE(bool_or(
      COALESCE(effect->>'type', '') = 'research-registry'
      OR COALESCE(plugin, '') IN ('research-track', 'research-deadline')
    ), false),
    COALESCE(bool_or(COALESCE(effect->>'type', '') = 'tob-goal-registry'), false),
    COALESCE(bool_or(
      COALESCE(effect->>'type', '') IN ('sync-candidates', 'project-candidate-result')
    ), false)
  INTO has_research, has_tob, has_candidates
  FROM jsonb_array_elements(stages) AS stage
  LEFT JOIN LATERAL jsonb_array_elements(COALESCE(stage->'effects', '[]'::jsonb)) AS effect ON true
  LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(stage->'runtime'->'plugins', '[]'::jsonb)) AS plugin ON true;

  IF has_research THEN
    tabs := tabs || vulseek_pipeline_job_tab_research();
  END IF;
  IF has_tob THEN
    tabs := tabs || vulseek_pipeline_job_tab_tob_goal();
  END IF;
  IF has_candidates THEN
    tabs := tabs || vulseek_pipeline_job_tab_candidates();
  END IF;
  RETURN tabs;
END;
$$;

CREATE OR REPLACE FUNCTION vulseek_rewrite_pipeline_snapshot(snapshot jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF snapshot IS NULL OR jsonb_typeof(snapshot) <> 'object' THEN
    RETURN snapshot;
  END IF;
  snapshot := snapshot - 'capabilities';
  IF jsonb_typeof(snapshot->'presentation'->'jobTabs') = 'array' THEN
    RETURN snapshot;
  END IF;
  RETURN snapshot || jsonb_build_object(
    'presentation',
    jsonb_build_object('jobTabs', vulseek_infer_pipeline_job_tabs(snapshot))
  );
END;
$$;

UPDATE "scan_pipeline_versions"
SET "compiledDefinition" = vulseek_rewrite_pipeline_snapshot("compiledDefinition")
WHERE "compiledDefinition" IS NOT NULL
  AND (
    "compiledDefinition" ? 'capabilities'
    OR jsonb_typeof("compiledDefinition"->'presentation'->'jobTabs') IS DISTINCT FROM 'array'
  );

UPDATE "scan_jobs"
SET "pipelineCompiledSnapshot" = vulseek_rewrite_pipeline_snapshot("pipelineCompiledSnapshot")
WHERE "pipelineCompiledSnapshot" IS NOT NULL
  AND (
    "pipelineCompiledSnapshot" ? 'capabilities'
    OR jsonb_typeof("pipelineCompiledSnapshot"->'presentation'->'jobTabs') IS DISTINCT FROM 'array'
  );

DROP FUNCTION IF EXISTS vulseek_rewrite_pipeline_snapshot(jsonb);
DROP FUNCTION IF EXISTS vulseek_infer_pipeline_job_tabs(jsonb);
DROP FUNCTION IF EXISTS vulseek_pipeline_snapshot_stages(jsonb);
DROP FUNCTION IF EXISTS vulseek_pipeline_job_tab_tob_goal();
DROP FUNCTION IF EXISTS vulseek_pipeline_job_tab_research();
DROP FUNCTION IF EXISTS vulseek_pipeline_job_tab_candidates();
