ALTER TABLE "runs" DROP CONSTRAINT "runs_typed_options_check";

ALTER TABLE "runs"
ADD CONSTRAINT "runs_typed_options_check"
CHECK (
  jsonb_typeof("request") = 'object'
  AND jsonb_extract_path_text("request", 'modelId') = "model_id"
  AND jsonb_extract_path_text("request", 'workflow') IN ('generate', 'redesign', 'ideate', 'edit')
  AND jsonb_extract_path_text("request", 'targetSurface') IN ('app', 'web')
  AND jsonb_typeof(jsonb_extract_path("request", 'designStyle')) = 'object'
  AND CASE jsonb_extract_path_text("request", 'designStyle', 'kind')
    WHEN 'automatic' THEN
      jsonb_extract_path("request", 'designStyle') = '{"kind":"automatic"}'::jsonb
      AND "design_style_artifact_version_id" IS NULL
      AND "design_style_snapshot" IS NULL
      AND "design_style_snapshot_sha256" IS NULL
    WHEN 'preset' THEN
      (jsonb_extract_path("request", 'designStyle') - ARRAY['kind', 'presetId', 'version', 'checksum']) = '{}'::jsonb
      AND jsonb_typeof(jsonb_extract_path("request", 'designStyle', 'presetId')) IS NOT DISTINCT FROM 'string'
      AND jsonb_extract_path_text("request", 'designStyle', 'presetId') ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      AND jsonb_typeof(jsonb_extract_path("request", 'designStyle', 'version')) IS NOT DISTINCT FROM 'number'
      AND jsonb_extract_path_text("request", 'designStyle', 'version') ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(jsonb_extract_path("request", 'designStyle', 'checksum')) IS NOT DISTINCT FROM 'string'
      AND jsonb_extract_path_text("request", 'designStyle', 'checksum') ~ '^[0-9a-f]{64}$'
      AND "design_style_artifact_version_id" IS NULL
      AND jsonb_typeof("design_style_snapshot") IS NOT DISTINCT FROM 'object'
      AND "design_style_snapshot_sha256" IS NOT NULL
      AND ("design_style_snapshot" - ARRAY['protocol', 'source', 'label', 'swatch', 'description', 'directives', 'tokens']) = '{}'::jsonb
      AND "design_style_snapshot"->>'protocol' IS NOT DISTINCT FROM 'workbench.runtime.design-preset.v1'
      AND jsonb_typeof("design_style_snapshot"->'source') IS NOT DISTINCT FROM 'object'
      AND (("design_style_snapshot"->'source') - ARRAY['presetId', 'version', 'checksum']) = '{}'::jsonb
      AND "design_style_snapshot"#>>'{source,presetId}' IS NOT DISTINCT FROM jsonb_extract_path_text("request", 'designStyle', 'presetId')
      AND "design_style_snapshot"#>'{source,version}' IS NOT DISTINCT FROM jsonb_extract_path("request", 'designStyle', 'version')
      AND "design_style_snapshot"#>>'{source,checksum}' IS NOT DISTINCT FROM jsonb_extract_path_text("request", 'designStyle', 'checksum')
      AND jsonb_typeof("design_style_snapshot"->'label') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof("design_style_snapshot"->'swatch') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof("design_style_snapshot"->'description') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof("design_style_snapshot"->'directives') IS NOT DISTINCT FROM 'object'
      AND jsonb_typeof("design_style_snapshot"->'tokens') IS NOT DISTINCT FROM 'object'
    WHEN 'artifact' THEN
      (jsonb_extract_path("request", 'designStyle') - ARRAY['kind', 'artifactVersionId']) = '{}'::jsonb
      AND jsonb_typeof(jsonb_extract_path("request", 'designStyle', 'artifactVersionId')) IS NOT DISTINCT FROM 'string'
      AND length(jsonb_extract_path_text("request", 'designStyle', 'artifactVersionId')) > 0
      AND jsonb_extract_path_text("request", 'designStyle', 'artifactVersionId') = "design_style_artifact_version_id"
      AND jsonb_typeof("design_style_snapshot") IS NOT DISTINCT FROM 'object'
      AND "design_style_snapshot_sha256" IS NOT NULL
    ELSE FALSE
  END
  AND (
    jsonb_extract_path_text("request", 'workflow') <> 'redesign'
    OR CASE
      WHEN jsonb_typeof(jsonb_extract_path("request", 'attachmentIds')) = 'array'
      THEN jsonb_array_length(jsonb_extract_path("request", 'attachmentIds')) > 0
      ELSE FALSE
    END
  )
);
