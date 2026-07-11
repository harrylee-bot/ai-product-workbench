-- Reconcile the physical PostgreSQL contract with the conversation-first
-- Prisma schema. Historical migrations added replacement enum labels and
-- columns without removing their project-era predecessors or restoring the
-- required constraints.

BEGIN;

-- Abort before any DDL if legacy/canonical task profiles disagree or version
-- history is already ambiguous. Equivalent duplicate profiles are reconciled
-- below by retaining the canonical conversation-first row.
DO $initial_contract_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "model_task_profiles" legacy
    JOIN "model_task_profiles" canonical
      ON canonical."task_type"::text = CASE legacy."task_type"::text
        WHEN 'product_planning' THEN 'conversation_planning'
        WHEN 'product_design' THEN 'conversation_design'
      END
    WHERE legacy."task_type"::text IN ('product_planning', 'product_design')
      AND (
        legacy."model_config_id" IS DISTINCT FROM canonical."model_config_id"
        OR legacy."temperature" IS DISTINCT FROM canonical."temperature"
        OR legacy."max_tokens" IS DISTINCT FROM canonical."max_tokens"
        OR legacy."response_format" IS DISTINCT FROM canonical."response_format"
        OR legacy."retry_count" IS DISTINCT FROM canonical."retry_count"
        OR legacy."timeout_ms" IS DISTINCT FROM canonical."timeout_ms"
        OR legacy."is_enabled" IS DISTINCT FROM canonical."is_enabled"
      )
  ) THEN
    RAISE EXCEPTION 'legacy and canonical model task profiles disagree; reconcile them before migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "conversation_design_versions"
    GROUP BY "state_id", "version" HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM "requirement_document_versions"
    GROUP BY "document_id", "version" HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM "prototype_versions"
    GROUP BY "artifact_id", "version" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate artifact versions must be reconciled before migration';
  END IF;
END $initial_contract_preflight$;

-- Enum replacements preserve rows by mapping each retired label explicitly.
CREATE TYPE "AdminAuditTargetType_contract" AS ENUM (
  'user',
  'conversation',
  'model_provider',
  'model_config',
  'model_task_profile',
  'knowledge_item',
  'knowledge_candidate',
  'system'
);
ALTER TABLE "admin_audit_logs"
  ALTER COLUMN "target_type" TYPE "AdminAuditTargetType_contract"
  USING (
    CASE
      WHEN "target_type"::text IN ('project', 'product') THEN 'conversation'
      ELSE "target_type"::text
    END
  )::"AdminAuditTargetType_contract";
ALTER TYPE "AdminAuditTargetType" RENAME TO "AdminAuditTargetType_legacy";
ALTER TYPE "AdminAuditTargetType_contract" RENAME TO "AdminAuditTargetType";
DROP TYPE "AdminAuditTargetType_legacy";

CREATE TYPE "FileParserType_contract" AS ENUM (
  'plain_text',
  'markdown',
  'docx',
  'pdf',
  'image',
  'zip',
  'axure_html_zip',
  'rp_reference',
  'rp_source',
  'unsupported'
);
ALTER TABLE "file_parse_results"
  ALTER COLUMN "parser_type" TYPE "FileParserType_contract"
  USING (
    CASE
      WHEN "parser_type"::text = 'rp_project' THEN 'rp_source'
      ELSE "parser_type"::text
    END
  )::"FileParserType_contract";
ALTER TYPE "FileParserType" RENAME TO "FileParserType_legacy";
ALTER TYPE "FileParserType_contract" RENAME TO "FileParserType";
DROP TYPE "FileParserType_legacy";

CREATE TYPE "KnowledgeCandidateSource_contract" AS ENUM (
  'prd',
  'prototype',
  'conversation_design_state',
  'conversation',
  'uploaded_file'
);
ALTER TABLE "knowledge_candidates"
  ALTER COLUMN "source" TYPE "KnowledgeCandidateSource_contract"
  USING (
    CASE
      WHEN "source"::text = 'product_design_state' THEN 'conversation_design_state'
      ELSE "source"::text
    END
  )::"KnowledgeCandidateSource_contract";
ALTER TYPE "KnowledgeCandidateSource" RENAME TO "KnowledgeCandidateSource_legacy";
ALTER TYPE "KnowledgeCandidateSource_contract" RENAME TO "KnowledgeCandidateSource";
DROP TYPE "KnowledgeCandidateSource_legacy";

CREATE TYPE "KnowledgeScope_contract" AS ENUM ('global', 'conversation');
ALTER TABLE "knowledge_items" ALTER COLUMN "scope" DROP DEFAULT;
ALTER TABLE "knowledge_items"
  ALTER COLUMN "scope" TYPE "KnowledgeScope_contract"
  USING (
    CASE
      WHEN "scope"::text IN ('project', 'product') THEN 'conversation'
      ELSE "scope"::text
    END
  )::"KnowledgeScope_contract";
ALTER TYPE "KnowledgeScope" RENAME TO "KnowledgeScope_legacy";
ALTER TYPE "KnowledgeScope_contract" RENAME TO "KnowledgeScope";
DROP TYPE "KnowledgeScope_legacy";
ALTER TABLE "knowledge_items" ALTER COLUMN "scope" SET DEFAULT 'global';

CREATE TYPE "KnowledgeSource_contract" AS ENUM (
  'manual',
  'conversation_extraction',
  'file_extraction',
  'prd_confirmation',
  'prototype_confirmation'
);
ALTER TABLE "knowledge_items"
  ALTER COLUMN "source" TYPE "KnowledgeSource_contract"
  USING (
    CASE
      WHEN "source"::text = 'project_extraction' THEN 'conversation_extraction'
      ELSE "source"::text
    END
  )::"KnowledgeSource_contract";
ALTER TYPE "KnowledgeSource" RENAME TO "KnowledgeSource_legacy";
ALTER TYPE "KnowledgeSource_contract" RENAME TO "KnowledgeSource";
DROP TYPE "KnowledgeSource_legacy";

CREATE TYPE "KnowledgeType_contract" AS ENUM (
  'strong_rule',
  'default_rule',
  'reference_case',
  'design_pattern',
  'prd_writing_rule',
  'prototype_rule',
  'business_concept',
  'product_architecture',
  'page_inventory',
  'ui_style_guide',
  'prototype_asset_ref',
  'prototype_package',
  'prototype_page',
  'prototype_snapshot',
  'prototype_flow_edge'
);
ALTER TABLE "knowledge_items"
  ALTER COLUMN "type" TYPE "KnowledgeType_contract"
  USING (
    CASE
      WHEN "type"::text = 'prototype_project' THEN 'prototype_package'
      ELSE "type"::text
    END
  )::"KnowledgeType_contract";
ALTER TABLE "knowledge_candidates"
  ALTER COLUMN "suggested_type" TYPE "KnowledgeType_contract"
  USING (
    CASE
      WHEN "suggested_type"::text = 'prototype_project' THEN 'prototype_package'
      ELSE "suggested_type"::text
    END
  )::"KnowledgeType_contract";
ALTER TYPE "KnowledgeType" RENAME TO "KnowledgeType_legacy";
ALTER TYPE "KnowledgeType_contract" RENAME TO "KnowledgeType";
DROP TYPE "KnowledgeType_legacy";

CREATE TYPE "ModelTaskType_contract" AS ENUM (
  'intent_detection',
  'knowledge_classification',
  'requirement_analysis',
  'conversation_planning',
  'conversation_design',
  'prd_generation',
  'prototype_design',
  'prototype_code_generation',
  'qa_check',
  'knowledge_extraction',
  'general_chat'
);
-- Historical deployments can contain both the retired and canonical task
-- profile. Keep the canonical row when both exist so the enum rewrite cannot
-- collide with the unique task_type index; otherwise the legacy row is mapped.
DELETE FROM "model_task_profiles" legacy
WHERE (
    legacy."task_type"::text = 'product_planning'
    AND EXISTS (
      SELECT 1
      FROM "model_task_profiles" canonical
      WHERE canonical."task_type"::text = 'conversation_planning'
    )
  )
  OR (
    legacy."task_type"::text = 'product_design'
    AND EXISTS (
      SELECT 1
      FROM "model_task_profiles" canonical
      WHERE canonical."task_type"::text = 'conversation_design'
    )
  );
ALTER TABLE "model_task_profiles"
  ALTER COLUMN "task_type" TYPE "ModelTaskType_contract"
  USING (
    CASE
      WHEN "task_type"::text = 'product_planning' THEN 'conversation_planning'
      WHEN "task_type"::text = 'product_design' THEN 'conversation_design'
      ELSE "task_type"::text
    END
  )::"ModelTaskType_contract";
ALTER TABLE "model_call_logs"
  ALTER COLUMN "task_type" TYPE "ModelTaskType_contract"
  USING (
    CASE
      WHEN "task_type"::text = 'product_planning' THEN 'conversation_planning'
      WHEN "task_type"::text = 'product_design' THEN 'conversation_design'
      ELSE "task_type"::text
    END
  )::"ModelTaskType_contract";
ALTER TYPE "ModelTaskType" RENAME TO "ModelTaskType_legacy";
ALTER TYPE "ModelTaskType_contract" RENAME TO "ModelTaskType";
DROP TYPE "ModelTaskType_legacy";

CREATE TYPE "RollbackType_contract" AS ENUM ('conversation_design_state');
ALTER TABLE "rollback_records"
  ALTER COLUMN "rollback_type" TYPE "RollbackType_contract"
  USING (
    CASE
      WHEN "rollback_type"::text = 'product_design_state' THEN 'conversation_design_state'
      ELSE "rollback_type"::text
    END
  )::"RollbackType_contract";
ALTER TYPE "RollbackType" RENAME TO "RollbackType_legacy";
ALTER TYPE "RollbackType_contract" RENAME TO "RollbackType";
DROP TYPE "RollbackType_legacy";

CREATE TYPE "UserRole_contract" AS ENUM ('user', 'admin', 'developer');
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users"
  ALTER COLUMN "role" TYPE "UserRole_contract"
  USING (
    CASE
      WHEN "role"::text = 'product' THEN 'user'
      ELSE "role"::text
    END
  )::"UserRole_contract";
ALTER TYPE "UserRole" RENAME TO "UserRole_legacy";
ALTER TYPE "UserRole_contract" RENAME TO "UserRole";
DROP TYPE "UserRole_legacy";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user';

-- Recover required conversation ownership from existing parent relations.
-- Existing valid ownership is never overwritten.
UPDATE "file_assets" f
SET "conversation_id" = m."conversation_id"
FROM "messages" m
WHERE f."message_id" = m."id"
  AND (
    f."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = f."conversation_id")
  );

UPDATE "file_parse_results" r
SET "conversation_id" = f."conversation_id"
FROM "file_assets" f
WHERE r."file_asset_id" = f."id"
  AND (
    r."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = r."conversation_id")
  );

UPDATE "file_chunks" ch
SET "conversation_id" = f."conversation_id"
FROM "file_assets" f
WHERE ch."file_asset_id" = f."id"
  AND (
    ch."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = ch."conversation_id")
  );

UPDATE "prototype_conversion_jobs" j
SET "conversation_id" = f."conversation_id"
FROM "file_assets" f
WHERE j."file_asset_id" = f."id"
  AND (
    j."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = j."conversation_id")
  );

UPDATE "conversation_design_versions" v
SET "conversation_id" = s."conversation_id"
FROM "conversation_design_states" s
WHERE v."state_id" = s."id"
  AND (
    v."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = v."conversation_id")
  );

UPDATE "conversation_design_change_logs" l
SET "conversation_id" = s."conversation_id"
FROM "conversation_design_states" s
WHERE l."state_id" = s."id"
  AND (
    l."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = l."conversation_id")
  );

UPDATE "requirement_documents" d
SET
  "conversation_id" = CASE
    WHEN d."conversation_id" IS NULL
      OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = d."conversation_id")
    THEN s."conversation_id"
    ELSE d."conversation_id"
  END,
  "conversation_design_state_version" = COALESCE(d."conversation_design_state_version", s."version")
FROM "conversation_design_states" s
WHERE d."conversation_design_state_id" = s."id";

UPDATE "requirement_documents" d
SET "conversation_design_state_id" = s."id"
FROM "conversation_design_states" s
WHERE d."conversation_id" = s."conversation_id"
  AND d."conversation_design_state_version" = s."version"
  AND (
    d."conversation_design_state_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "conversation_design_states" current_state
      WHERE current_state."id" = d."conversation_design_state_id"
    )
  );

UPDATE "requirement_document_versions" v
SET "conversation_id" = d."conversation_id"
FROM "requirement_documents" d
WHERE v."document_id" = d."id"
  AND (
    v."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = v."conversation_id")
  );

UPDATE "prototype_spec_records" p
SET
  "conversation_id" = CASE
    WHEN p."conversation_id" IS NULL
      OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = p."conversation_id")
    THEN s."conversation_id"
    ELSE p."conversation_id"
  END,
  "conversation_design_state_version" = COALESCE(p."conversation_design_state_version", s."version")
FROM "conversation_design_states" s
WHERE p."conversation_design_state_id" = s."id";

UPDATE "prototype_spec_records" p
SET "conversation_design_state_id" = s."id"
FROM "conversation_design_states" s
WHERE p."conversation_id" = s."conversation_id"
  AND p."conversation_design_state_version" = s."version"
  AND (
    p."conversation_design_state_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "conversation_design_states" current_state
      WHERE current_state."id" = p."conversation_design_state_id"
    )
  );

UPDATE "prototype_artifacts" a
SET
  "conversation_id" = CASE
    WHEN a."conversation_id" IS NULL
      OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = a."conversation_id")
    THEN p."conversation_id"
    ELSE a."conversation_id"
  END,
  "conversation_design_state_id" = CASE
    WHEN a."conversation_design_state_id" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "conversation_design_states" s
        WHERE s."id" = a."conversation_design_state_id"
      )
    THEN p."conversation_design_state_id"
    ELSE a."conversation_design_state_id"
  END,
  "conversation_design_state_version" = COALESCE(
    a."conversation_design_state_version",
    p."conversation_design_state_version"
  )
FROM "prototype_spec_records" p
WHERE a."prototype_spec_id" = p."id";

UPDATE "prototype_artifacts" a
SET "conversation_design_state_id" = s."id"
FROM "conversation_design_states" s
WHERE a."conversation_id" = s."conversation_id"
  AND a."conversation_design_state_version" = s."version"
  AND (
    a."conversation_design_state_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "conversation_design_states" current_state
      WHERE current_state."id" = a."conversation_design_state_id"
    )
  );

UPDATE "prototype_versions" v
SET "conversation_id" = a."conversation_id"
FROM "prototype_artifacts" a
WHERE v."artifact_id" = a."id"
  AND (
    v."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = v."conversation_id")
  );

UPDATE "qa_reports" q
SET
  "conversation_id" = CASE
    WHEN q."conversation_id" IS NULL
      OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = q."conversation_id")
    THEN s."conversation_id"
    ELSE q."conversation_id"
  END,
  "conversation_design_state_version" = COALESCE(q."conversation_design_state_version", s."version")
FROM "conversation_design_states" s
WHERE q."conversation_design_state_id" = s."id";

UPDATE "qa_reports" q
SET
  "conversation_id" = CASE
    WHEN q."conversation_id" IS NULL
      OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = q."conversation_id")
    THEN d."conversation_id"
    ELSE q."conversation_id"
  END,
  "conversation_design_state_id" = COALESCE(q."conversation_design_state_id", d."conversation_design_state_id"),
  "conversation_design_state_version" = COALESCE(
    q."conversation_design_state_version",
    d."conversation_design_state_version"
  )
FROM "requirement_documents" d
WHERE q."prd_document_id" = d."id";

UPDATE "qa_reports" q
SET
  "conversation_id" = CASE
    WHEN q."conversation_id" IS NULL
      OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = q."conversation_id")
    THEN a."conversation_id"
    ELSE q."conversation_id"
  END,
  "conversation_design_state_id" = COALESCE(q."conversation_design_state_id", a."conversation_design_state_id"),
  "conversation_design_state_version" = COALESCE(
    q."conversation_design_state_version",
    a."conversation_design_state_version"
  )
FROM "prototype_artifacts" a
WHERE q."prototype_artifact_id" = a."id";

UPDATE "qa_reports" q
SET
  "conversation_id" = CASE
    WHEN q."conversation_id" IS NULL
      OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = q."conversation_id")
    THEN p."conversation_id"
    ELSE q."conversation_id"
  END,
  "conversation_design_state_id" = COALESCE(q."conversation_design_state_id", p."conversation_design_state_id"),
  "conversation_design_state_version" = COALESCE(
    q."conversation_design_state_version",
    p."conversation_design_state_version"
  )
FROM "prototype_spec_records" p
WHERE q."prototype_spec_id" = p."id";

UPDATE "qa_reports" q
SET "conversation_design_state_id" = s."id"
FROM "conversation_design_states" s
WHERE q."conversation_id" = s."conversation_id"
  AND q."conversation_design_state_version" = s."version"
  AND (
    q."conversation_design_state_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "conversation_design_states" current_state
      WHERE current_state."id" = q."conversation_design_state_id"
    )
  );

UPDATE "share_links" l
SET "conversation_id" = d."conversation_id"
FROM "requirement_documents" d
WHERE l."prd_document_id" = d."id"
  AND (
    l."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = l."conversation_id")
  );

UPDATE "share_links" l
SET "conversation_id" = a."conversation_id"
FROM "prototype_artifacts" a
WHERE l."prototype_artifact_id" = a."id"
  AND (
    l."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = l."conversation_id")
  );

UPDATE "share_links" l
SET "conversation_id" = s."conversation_id"
FROM "conversation_design_states" s
WHERE l."conversation_design_state_id" = s."id"
  AND (
    l."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = l."conversation_id")
  );

UPDATE "rollback_records" r
SET "conversation_id" = d."conversation_id"
FROM "requirement_documents" d
WHERE d."id" IN (r."before_prd_document_id", r."after_prd_document_id")
  AND (
    r."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = r."conversation_id")
  );

UPDATE "rollback_records" r
SET "conversation_id" = a."conversation_id"
FROM "prototype_artifacts" a
WHERE a."id" IN (r."before_prototype_artifact_id", r."after_prototype_artifact_id")
  AND (
    r."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = r."conversation_id")
  );

UPDATE "constraint_rules" r
SET "conversation_id" = k."source_conversation_id"
FROM "knowledge_items" k
WHERE r."source_knowledge_id" = k."id"
  AND k."source_conversation_id" IS NOT NULL
  AND (
    r."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = r."conversation_id")
  );

UPDATE "knowledge_candidates" k
SET "conversation_id" = d."conversation_id"
FROM "requirement_documents" d
WHERE k."source" = 'prd'
  AND k."source_ref_id" = d."id"
  AND (
    k."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = k."conversation_id")
  );

UPDATE "knowledge_candidates" k
SET "conversation_id" = a."conversation_id"
FROM "prototype_artifacts" a
WHERE k."source" = 'prototype'
  AND k."source_ref_id" = a."id"
  AND (
    k."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = k."conversation_id")
  );

UPDATE "knowledge_candidates" k
SET "conversation_id" = s."conversation_id"
FROM "conversation_design_states" s
WHERE k."source" = 'conversation_design_state'
  AND k."source_ref_id" = s."id"
  AND (
    k."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = k."conversation_id")
  );

UPDATE "knowledge_candidates" k
SET "conversation_id" = f."conversation_id"
FROM "file_assets" f
WHERE k."source" = 'uploaded_file'
  AND k."source_ref_id" = f."id"
  AND (
    k."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = k."conversation_id")
  );

UPDATE "knowledge_candidates" k
SET "conversation_id" = k."source_ref_id"
WHERE k."source" = 'conversation'
  AND EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = k."source_ref_id")
  AND (
    k."conversation_id" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."id" = k."conversation_id")
  );

UPDATE "vibe_stream_event_logs" e
SET "conversation_id" = r."conversation_id"
FROM "agent_run_logs" r
WHERE e."run_id" = r."id"
  -- The owning run is authoritative even when the event points at another
  -- valid conversation; otherwise historical event queries can cross threads.
  AND e."conversation_id" IS DISTINCT FROM r."conversation_id";

-- Optional conversation references use SET NULL semantics; clear stale values
-- before installing the foreign key.
UPDATE "knowledge_items" k
SET "source_conversation_id" = NULL
WHERE k."source_conversation_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "conversations" c WHERE c."id" = k."source_conversation_id"
  );

-- Fail closed if deterministic recovery could not establish required
-- ownership. This avoids silently deleting or assigning business data to an
-- arbitrary conversation.
DO $contract_preflight$
DECLARE
  required_columns text[][] := ARRAY[
    ARRAY['comments', 'conversation_id'],
    ARRAY['constraint_rules', 'conversation_id'],
    ARRAY['file_assets', 'conversation_id'],
    ARRAY['file_chunks', 'conversation_id'],
    ARRAY['file_parse_results', 'conversation_id'],
    ARRAY['knowledge_candidates', 'conversation_id'],
    ARRAY['prototype_artifacts', 'conversation_id'],
    ARRAY['prototype_artifacts', 'conversation_design_state_id'],
    ARRAY['prototype_artifacts', 'conversation_design_state_version'],
    ARRAY['prototype_conversion_jobs', 'conversation_id'],
    ARRAY['prototype_spec_records', 'conversation_id'],
    ARRAY['prototype_spec_records', 'conversation_design_state_id'],
    ARRAY['prototype_spec_records', 'conversation_design_state_version'],
    ARRAY['prototype_versions', 'conversation_id'],
    ARRAY['qa_reports', 'conversation_id'],
    ARRAY['qa_reports', 'conversation_design_state_id'],
    ARRAY['qa_reports', 'conversation_design_state_version'],
    ARRAY['requirement_document_versions', 'conversation_id'],
    ARRAY['requirement_documents', 'conversation_id'],
    ARRAY['requirement_documents', 'conversation_design_state_id'],
    ARRAY['requirement_documents', 'conversation_design_state_version'],
    ARRAY['rollback_records', 'conversation_id'],
    ARRAY['rollback_records', 'from_conversation_design_state_version'],
    ARRAY['rollback_records', 'to_conversation_design_state_version'],
    ARRAY['share_links', 'conversation_id'],
    ARRAY['vibe_stream_event_logs', 'conversation_id']
  ];
  required_relations text[][] := ARRAY[
    ARRAY['agent_run_logs', 'conversation_id', 'conversations', 'id'],
    ARRAY['comments', 'conversation_id', 'conversations', 'id'],
    ARRAY['constraint_rules', 'conversation_id', 'conversations', 'id'],
    ARRAY['conversation_design_change_logs', 'conversation_id', 'conversations', 'id'],
    ARRAY['conversation_design_change_logs', 'state_id', 'conversation_design_states', 'id'],
    ARRAY['conversation_design_states', 'conversation_id', 'conversations', 'id'],
    ARRAY['conversation_design_versions', 'conversation_id', 'conversations', 'id'],
    ARRAY['conversation_design_versions', 'state_id', 'conversation_design_states', 'id'],
    ARRAY['file_assets', 'conversation_id', 'conversations', 'id'],
    ARRAY['knowledge_candidates', 'conversation_id', 'conversations', 'id'],
    ARRAY['prototype_artifacts', 'conversation_id', 'conversations', 'id'],
    ARRAY['prototype_artifacts', 'conversation_design_state_id', 'conversation_design_states', 'id'],
    ARRAY['prototype_conversion_jobs', 'conversation_id', 'conversations', 'id'],
    ARRAY['prototype_spec_records', 'conversation_id', 'conversations', 'id'],
    ARRAY['prototype_spec_records', 'conversation_design_state_id', 'conversation_design_states', 'id'],
    ARRAY['prototype_versions', 'conversation_id', 'conversations', 'id'],
    ARRAY['qa_reports', 'conversation_id', 'conversations', 'id'],
    ARRAY['qa_reports', 'conversation_design_state_id', 'conversation_design_states', 'id'],
    ARRAY['requirement_document_versions', 'conversation_id', 'conversations', 'id'],
    ARRAY['requirement_documents', 'conversation_id', 'conversations', 'id'],
    ARRAY['requirement_documents', 'conversation_design_state_id', 'conversation_design_states', 'id'],
    ARRAY['rollback_records', 'conversation_id', 'conversations', 'id'],
    ARRAY['share_links', 'conversation_id', 'conversations', 'id'],
    ARRAY['vibe_stream_event_logs', 'conversation_id', 'conversations', 'id']
  ];
  item text[];
  violation_count bigint;
BEGIN
  FOREACH item SLICE 1 IN ARRAY required_columns LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I IS NULL',
      item[1],
      item[2]
    ) INTO violation_count;
    IF violation_count > 0 THEN
      RAISE EXCEPTION
        'Cannot enforce conversation schema: %.% has % null row(s). Repair those rows and retry the migration.',
        item[1], item[2], violation_count;
    END IF;
  END LOOP;

  FOREACH item SLICE 1 IN ARRAY required_relations LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I child LEFT JOIN %I parent ON child.%I = parent.%I WHERE parent.%I IS NULL',
      item[1], item[3], item[2], item[4], item[4]
    ) INTO violation_count;
    IF violation_count > 0 THEN
      RAISE EXCEPTION
        'Cannot enforce conversation schema: %.% has % orphan row(s) relative to %.%. Repair those rows and retry the migration.',
        item[1], item[2], violation_count, item[3], item[4];
    END IF;
  END LOOP;
END $contract_preflight$;

ALTER TABLE "comments" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "constraint_rules" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "file_assets" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "file_chunks" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "file_parse_results" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "knowledge_candidates" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "prototype_artifacts"
  ALTER COLUMN "conversation_id" SET NOT NULL,
  ALTER COLUMN "conversation_design_state_id" SET NOT NULL,
  ALTER COLUMN "conversation_design_state_version" SET NOT NULL;
ALTER TABLE "prototype_conversion_jobs" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "prototype_spec_records"
  ALTER COLUMN "conversation_id" SET NOT NULL,
  ALTER COLUMN "conversation_design_state_id" SET NOT NULL,
  ALTER COLUMN "conversation_design_state_version" SET NOT NULL;
ALTER TABLE "prototype_versions" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "qa_reports"
  ALTER COLUMN "conversation_id" SET NOT NULL,
  ALTER COLUMN "conversation_design_state_id" SET NOT NULL,
  ALTER COLUMN "conversation_design_state_version" SET NOT NULL;
ALTER TABLE "requirement_document_versions" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "requirement_documents"
  ALTER COLUMN "conversation_id" SET NOT NULL,
  ALTER COLUMN "conversation_design_state_id" SET NOT NULL,
  ALTER COLUMN "conversation_design_state_version" SET NOT NULL;
ALTER TABLE "rollback_records"
  ALTER COLUMN "conversation_id" SET NOT NULL,
  ALTER COLUMN "from_conversation_design_state_version" SET NOT NULL,
  ALTER COLUMN "to_conversation_design_state_version" SET NOT NULL;
ALTER TABLE "share_links" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "vibe_stream_event_logs" ALTER COLUMN "conversation_id" SET NOT NULL;

DROP INDEX IF EXISTS "knowledge_items_scope_source_project_id_idx";
ALTER TABLE "knowledge_items" DROP COLUMN IF EXISTS "source_project_id" CASCADE;

CREATE INDEX IF NOT EXISTS "knowledge_retrieval_logs_conversation_id_idx"
  ON "knowledge_retrieval_logs"("conversation_id");
CREATE INDEX IF NOT EXISTS "requirement_document_versions_conversation_id_idx"
  ON "requirement_document_versions"("conversation_id");
CREATE INDEX IF NOT EXISTS "rollback_records_conversation_id_idx"
  ON "rollback_records"("conversation_id");

-- Replace historical RESTRICT/SET NULL relations and install the missing
-- conversation-first foreign keys with the Prisma-declared delete behavior.
ALTER TABLE "agent_run_logs" DROP CONSTRAINT IF EXISTS "agent_run_logs_conversation_id_fkey";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_conversation_id_fkey";
ALTER TABLE "prototype_conversion_jobs" DROP CONSTRAINT IF EXISTS "prototype_conversion_jobs_conversation_id_fkey";
ALTER TABLE "conversation_design_states" DROP CONSTRAINT IF EXISTS "conversation_design_states_conversation_id_fkey";
ALTER TABLE "conversation_design_versions" DROP CONSTRAINT IF EXISTS "conversation_design_versions_conversation_id_fkey";
ALTER TABLE "conversation_design_versions" DROP CONSTRAINT IF EXISTS "conversation_design_versions_state_id_fkey";
ALTER TABLE "conversation_design_change_logs" DROP CONSTRAINT IF EXISTS "conversation_design_change_logs_conversation_id_fkey";
ALTER TABLE "conversation_design_change_logs" DROP CONSTRAINT IF EXISTS "conversation_design_change_logs_state_id_fkey";
ALTER TABLE "requirement_documents" DROP CONSTRAINT IF EXISTS "requirement_documents_conversation_id_fkey";
ALTER TABLE "requirement_documents" DROP CONSTRAINT IF EXISTS "requirement_documents_conversation_design_state_id_fkey";
ALTER TABLE "requirement_document_versions" DROP CONSTRAINT IF EXISTS "requirement_document_versions_conversation_id_fkey";
ALTER TABLE "prototype_spec_records" DROP CONSTRAINT IF EXISTS "prototype_spec_records_conversation_id_fkey";
ALTER TABLE "prototype_spec_records" DROP CONSTRAINT IF EXISTS "prototype_spec_records_conversation_design_state_id_fkey";
ALTER TABLE "prototype_artifacts" DROP CONSTRAINT IF EXISTS "prototype_artifacts_conversation_id_fkey";
ALTER TABLE "prototype_artifacts" DROP CONSTRAINT IF EXISTS "prototype_artifacts_conversation_design_state_id_fkey";
ALTER TABLE "prototype_versions" DROP CONSTRAINT IF EXISTS "prototype_versions_conversation_id_fkey";
ALTER TABLE "qa_reports" DROP CONSTRAINT IF EXISTS "qa_reports_conversation_id_fkey";
ALTER TABLE "rollback_records" DROP CONSTRAINT IF EXISTS "rollback_records_conversation_id_fkey";
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_conversation_id_fkey";
ALTER TABLE "constraint_rules" DROP CONSTRAINT IF EXISTS "constraint_rules_conversation_id_fkey";
ALTER TABLE "knowledge_items" DROP CONSTRAINT IF EXISTS "knowledge_items_source_conversation_id_fkey";
ALTER TABLE "knowledge_candidates" DROP CONSTRAINT IF EXISTS "knowledge_candidates_conversation_id_fkey";
ALTER TABLE "vibe_stream_event_logs" DROP CONSTRAINT IF EXISTS "vibe_stream_event_logs_conversation_id_fkey";
ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "comments_conversation_id_fkey";

ALTER TABLE "file_assets"
  ADD CONSTRAINT "file_assets_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prototype_conversion_jobs"
  ADD CONSTRAINT "prototype_conversion_jobs_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_design_states"
  ADD CONSTRAINT "conversation_design_states_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_design_versions"
  ADD CONSTRAINT "conversation_design_versions_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_design_versions"
  ADD CONSTRAINT "conversation_design_versions_state_id_fkey"
  FOREIGN KEY ("state_id") REFERENCES "conversation_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversation_design_change_logs"
  ADD CONSTRAINT "conversation_design_change_logs_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_design_change_logs"
  ADD CONSTRAINT "conversation_design_change_logs_state_id_fkey"
  FOREIGN KEY ("state_id") REFERENCES "conversation_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requirement_documents"
  ADD CONSTRAINT "requirement_documents_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_documents"
  ADD CONSTRAINT "requirement_documents_conversation_design_state_id_fkey"
  FOREIGN KEY ("conversation_design_state_id") REFERENCES "conversation_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requirement_document_versions"
  ADD CONSTRAINT "requirement_document_versions_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prototype_spec_records"
  ADD CONSTRAINT "prototype_spec_records_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prototype_spec_records"
  ADD CONSTRAINT "prototype_spec_records_conversation_design_state_id_fkey"
  FOREIGN KEY ("conversation_design_state_id") REFERENCES "conversation_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prototype_artifacts"
  ADD CONSTRAINT "prototype_artifacts_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prototype_artifacts"
  ADD CONSTRAINT "prototype_artifacts_conversation_design_state_id_fkey"
  FOREIGN KEY ("conversation_design_state_id") REFERENCES "conversation_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prototype_versions"
  ADD CONSTRAINT "prototype_versions_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "qa_reports"
  ADD CONSTRAINT "qa_reports_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rollback_records"
  ADD CONSTRAINT "rollback_records_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "share_links"
  ADD CONSTRAINT "share_links_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "constraint_rules"
  ADD CONSTRAINT "constraint_rules_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_items"
  ADD CONSTRAINT "knowledge_items_source_conversation_id_fkey"
  FOREIGN KEY ("source_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "knowledge_candidates"
  ADD CONSTRAINT "knowledge_candidates_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_run_logs"
  ADD CONSTRAINT "agent_run_logs_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vibe_stream_event_logs"
  ADD CONSTRAINT "vibe_stream_event_logs_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments"
  ADD CONSTRAINT "comments_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- These collaboration tables existed in the Prisma model but never received
-- a migration, so clean deployments could not use their API paths.
CREATE TABLE IF NOT EXISTS "votes" (
  "id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "is_upvoted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "votes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "suggestions" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "original_text" TEXT NOT NULL,
  "suggested_text" TEXT NOT NULL,
  "description" TEXT,
  "is_resolved" BOOLEAN NOT NULL DEFAULT false,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "suggestions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "streams" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "streams_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "votes_message_id_idx" ON "votes"("message_id");
CREATE INDEX IF NOT EXISTS "votes_user_id_idx" ON "votes"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "votes_message_id_user_id_key" ON "votes"("message_id", "user_id");
CREATE INDEX IF NOT EXISTS "suggestions_document_id_idx" ON "suggestions"("document_id");
CREATE INDEX IF NOT EXISTS "suggestions_user_id_idx" ON "suggestions"("user_id");
CREATE INDEX IF NOT EXISTS "streams_chat_id_idx" ON "streams"("chat_id");

ALTER TABLE "votes" DROP CONSTRAINT IF EXISTS "votes_message_id_fkey";
ALTER TABLE "votes" DROP CONSTRAINT IF EXISTS "votes_user_id_fkey";
ALTER TABLE "suggestions" DROP CONSTRAINT IF EXISTS "suggestions_user_id_fkey";

ALTER TABLE "votes"
  ADD CONSTRAINT "votes_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "votes"
  ADD CONSTRAINT "votes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "suggestions"
  ADD CONSTRAINT "suggestions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
