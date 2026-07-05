-- Backfill the conversation-first schema for production databases that still
-- contain the older project/product-design tables. Keep the old tables/columns
-- in place for a later audited cleanup so existing data is not destroyed.

DO $$
BEGIN
  CREATE TYPE "ConversationDesignStateStatus" AS ENUM (
    'draft',
    'intake',
    'format_check',
    'scoring',
    'optimizing',
    'clarifying',
    'design_ready',
    'doc_ready',
    'doc_confirmed',
    'prd_ready',
    'prototype_ready',
    'qa_failed',
    'confirmed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ConversationDesignChangeType" AS ENUM (
    'create',
    'update',
    'rollback',
    'confirm_assumption',
    'reject_assumption',
    'answer_question'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $legacy_backfill$
BEGIN
IF to_regclass('public.projects') IS NULL OR to_regclass('public.product_design_states') IS NULL THEN
  RETURN;
END IF;

CREATE TEMP TABLE "_project_conversation_map" ON COMMIT DROP AS
SELECT
  p.id AS project_id,
  COALESCE(
    p.current_conversation_id,
    (
      SELECT c.id
      FROM "conversations" c
      WHERE c.project_id = p.id
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC NULLS LAST
      LIMIT 1
    )
  ) AS conversation_id
FROM "projects" p;

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "current_design_state_id" TEXT,
  ADD COLUMN IF NOT EXISTS "current_prd_document_id" TEXT,
  ADD COLUMN IF NOT EXISTS "current_prototype_artifact_id" TEXT,
  ADD COLUMN IF NOT EXISTS "latest_qa_report_id" TEXT,
  ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);

UPDATE "conversations"
SET "last_activity_at" = COALESCE("last_activity_at", "last_message_at", "updated_at", "created_at", CURRENT_TIMESTAMP);

UPDATE "conversations" c
SET
  "current_design_state_id" = COALESCE(c."current_design_state_id", p."current_product_design_state_id"),
  "current_prd_document_id" = COALESCE(c."current_prd_document_id", p."current_prd_document_id"),
  "current_prototype_artifact_id" = COALESCE(c."current_prototype_artifact_id", p."current_prototype_artifact_id"),
  "latest_qa_report_id" = COALESCE(c."latest_qa_report_id", p."latest_qa_report_id"),
  "last_activity_at" = COALESCE(c."last_activity_at", p."last_activity_at", c."last_message_at", c."updated_at", c."created_at")
FROM "projects" p
JOIN "_project_conversation_map" m ON m.project_id = p.id
WHERE c.id = m.conversation_id;

ALTER TABLE "conversations" ALTER COLUMN "last_activity_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "conversations" ALTER COLUMN "last_activity_at" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "conversation_design_states" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "business_goal" TEXT NOT NULL,
  "background" TEXT,
  "target_users" JSONB NOT NULL,
  "user_scenarios" JSONB NOT NULL,
  "pages" JSONB NOT NULL,
  "features" JSONB NOT NULL,
  "backend_configs" JSONB NOT NULL,
  "frontend_rules" JSONB NOT NULL,
  "business_rules" JSONB NOT NULL,
  "state_rules" JSONB NOT NULL,
  "exception_scenarios" JSONB NOT NULL,
  "acceptance_criteria" JSONB NOT NULL,
  "prototype_outline" JSONB,
  "assumptions" JSONB NOT NULL,
  "knowledge_refs" JSONB NOT NULL,
  "pending_questions" JSONB NOT NULL,
  "confirmed_facts" JSONB NOT NULL,
  "prototype_spec" JSONB,
  "prd_document" JSONB,
  "status" "ConversationDesignStateStatus" NOT NULL DEFAULT 'draft',
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "conversation_design_states_pkey" PRIMARY KEY ("id")
);

INSERT INTO "conversation_design_states" (
  "id",
  "conversation_id",
  "version",
  "title",
  "summary",
  "business_goal",
  "background",
  "target_users",
  "user_scenarios",
  "pages",
  "features",
  "backend_configs",
  "frontend_rules",
  "business_rules",
  "state_rules",
  "exception_scenarios",
  "acceptance_criteria",
  "prototype_outline",
  "assumptions",
  "knowledge_refs",
  "pending_questions",
  "confirmed_facts",
  "prototype_spec",
  "prd_document",
  "status",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at"
)
SELECT
  s."id",
  m."conversation_id",
  s."version",
  s."title",
  s."summary",
  s."business_goal",
  s."background",
  s."target_users",
  s."user_scenarios",
  s."pages",
  s."features",
  s."backend_configs",
  s."frontend_rules",
  s."business_rules",
  s."state_rules",
  s."exception_scenarios",
  s."acceptance_criteria",
  s."prototype_outline",
  s."assumptions",
  s."knowledge_refs",
  s."pending_questions",
  COALESCE(s."confirmed_facts", '[]'::jsonb),
  s."prototype_spec",
  s."prd_document",
  CASE
    WHEN s."status"::text IN (
      'draft',
      'intake',
      'format_check',
      'scoring',
      'optimizing',
      'clarifying',
      'design_ready',
      'doc_ready',
      'doc_confirmed',
      'prd_ready',
      'prototype_ready',
      'qa_failed',
      'confirmed'
    ) THEN s."status"::text::"ConversationDesignStateStatus"
    ELSE 'design_ready'::"ConversationDesignStateStatus"
  END,
  COALESCE(s."created_by", p."owner_id"),
  s."updated_by",
  s."created_at",
  s."updated_at"
FROM "product_design_states" s
JOIN "_project_conversation_map" m ON m.project_id = s.project_id
JOIN "projects" p ON p.id = s.project_id
WHERE m.conversation_id IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_design_states_conversation_id_version_key"
  ON "conversation_design_states"("conversation_id", "version");
CREATE INDEX IF NOT EXISTS "conversation_design_states_conversation_id_idx"
  ON "conversation_design_states"("conversation_id");
CREATE INDEX IF NOT EXISTS "conversation_design_states_status_idx"
  ON "conversation_design_states"("status");

CREATE TABLE IF NOT EXISTS "conversation_design_versions" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "state_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "reason" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_design_versions_pkey" PRIMARY KEY ("id")
);

INSERT INTO "conversation_design_versions" (
  "id",
  "conversation_id",
  "state_id",
  "version",
  "snapshot",
  "reason",
  "created_by",
  "created_at"
)
SELECT
  v."id",
  m."conversation_id",
  v."state_id",
  v."version",
  v."snapshot",
  v."reason",
  v."created_by",
  v."created_at"
FROM "product_design_versions" v
JOIN "_project_conversation_map" m ON m.project_id = v.project_id
WHERE m.conversation_id IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

CREATE INDEX IF NOT EXISTS "conversation_design_versions_conversation_id_idx"
  ON "conversation_design_versions"("conversation_id");
CREATE INDEX IF NOT EXISTS "conversation_design_versions_state_id_idx"
  ON "conversation_design_versions"("state_id");
CREATE INDEX IF NOT EXISTS "conversation_design_versions_version_idx"
  ON "conversation_design_versions"("version");

CREATE TABLE IF NOT EXISTS "conversation_design_change_logs" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "state_id" TEXT NOT NULL,
  "run_id" TEXT,
  "message_id" TEXT,
  "change_type" "ConversationDesignChangeType" NOT NULL,
  "path" TEXT,
  "before" JSONB,
  "after" JSONB,
  "reason" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_design_change_logs_pkey" PRIMARY KEY ("id")
);

INSERT INTO "conversation_design_change_logs" (
  "id",
  "conversation_id",
  "state_id",
  "run_id",
  "message_id",
  "change_type",
  "path",
  "before",
  "after",
  "reason",
  "created_by",
  "created_at"
)
SELECT
  l."id",
  m."conversation_id",
  l."state_id",
  l."run_id",
  l."message_id",
  CASE
    WHEN l."change_type"::text IN (
      'create',
      'update',
      'rollback',
      'confirm_assumption',
      'reject_assumption',
      'answer_question'
    ) THEN l."change_type"::text::"ConversationDesignChangeType"
    ELSE 'update'::"ConversationDesignChangeType"
  END,
  l."path",
  l."before",
  l."after",
  l."reason",
  l."created_by",
  l."created_at"
FROM "product_design_change_logs" l
JOIN "_project_conversation_map" m ON m.project_id = l.project_id
WHERE m.conversation_id IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

CREATE INDEX IF NOT EXISTS "conversation_design_change_logs_conversation_id_idx"
  ON "conversation_design_change_logs"("conversation_id");
CREATE INDEX IF NOT EXISTS "conversation_design_change_logs_state_id_idx"
  ON "conversation_design_change_logs"("state_id");
CREATE INDEX IF NOT EXISTS "conversation_design_change_logs_run_id_idx"
  ON "conversation_design_change_logs"("run_id");
CREATE INDEX IF NOT EXISTS "conversation_design_change_logs_created_at_idx"
  ON "conversation_design_change_logs"("created_at");

ALTER TABLE "requirement_documents"
  ADD COLUMN IF NOT EXISTS "conversation_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_version" INTEGER;

UPDATE "requirement_documents" d
SET
  "conversation_id" = COALESCE(d."conversation_id", m."conversation_id"),
  "conversation_design_state_id" = COALESCE(d."conversation_design_state_id", d."product_design_state_id"),
  "conversation_design_state_version" = COALESCE(d."conversation_design_state_version", d."product_design_state_version")
FROM "_project_conversation_map" m
WHERE d."project_id" = m.project_id;

ALTER TABLE "requirement_document_versions" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "requirement_document_versions" v
SET "conversation_id" = COALESCE(v."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE v."project_id" = m.project_id;

ALTER TABLE "prototype_spec_records"
  ADD COLUMN IF NOT EXISTS "conversation_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_version" INTEGER;

UPDATE "prototype_spec_records" s
SET
  "conversation_id" = COALESCE(s."conversation_id", m."conversation_id"),
  "conversation_design_state_id" = COALESCE(s."conversation_design_state_id", s."product_design_state_id"),
  "conversation_design_state_version" = COALESCE(s."conversation_design_state_version", s."product_design_state_version")
FROM "_project_conversation_map" m
WHERE s."project_id" = m.project_id;

ALTER TABLE "prototype_artifacts"
  ADD COLUMN IF NOT EXISTS "conversation_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_version" INTEGER;

UPDATE "prototype_artifacts" a
SET
  "conversation_id" = COALESCE(a."conversation_id", m."conversation_id"),
  "conversation_design_state_id" = COALESCE(a."conversation_design_state_id", a."product_design_state_id"),
  "conversation_design_state_version" = COALESCE(a."conversation_design_state_version", a."product_design_state_version")
FROM "_project_conversation_map" m
WHERE a."project_id" = m.project_id;

ALTER TABLE "prototype_versions" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "prototype_versions" v
SET "conversation_id" = COALESCE(v."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE v."project_id" = m.project_id;

ALTER TABLE "qa_reports"
  ADD COLUMN IF NOT EXISTS "conversation_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_version" INTEGER;

UPDATE "qa_reports" q
SET
  "conversation_id" = COALESCE(q."conversation_id", m."conversation_id"),
  "conversation_design_state_id" = COALESCE(q."conversation_design_state_id", q."product_design_state_id"),
  "conversation_design_state_version" = COALESCE(q."conversation_design_state_version", q."product_design_state_version")
FROM "_project_conversation_map" m
WHERE q."project_id" = m.project_id;

ALTER TABLE "share_links"
  ADD COLUMN IF NOT EXISTS "conversation_id" TEXT,
  ADD COLUMN IF NOT EXISTS "conversation_design_state_id" TEXT;

UPDATE "share_links" s
SET
  "conversation_id" = COALESCE(s."conversation_id", m."conversation_id"),
  "conversation_design_state_id" = COALESCE(s."conversation_design_state_id", s."product_design_state_id")
FROM "_project_conversation_map" m
WHERE s."project_id" = m.project_id;

ALTER TABLE "rollback_records"
  ADD COLUMN IF NOT EXISTS "conversation_id" TEXT,
  ADD COLUMN IF NOT EXISTS "from_conversation_design_state_version" INTEGER,
  ADD COLUMN IF NOT EXISTS "to_conversation_design_state_version" INTEGER;

UPDATE "rollback_records" r
SET
  "conversation_id" = COALESCE(r."conversation_id", m."conversation_id"),
  "from_conversation_design_state_version" = COALESCE(
    r."from_conversation_design_state_version",
    r."from_product_design_state_version"
  ),
  "to_conversation_design_state_version" = COALESCE(
    r."to_conversation_design_state_version",
    r."to_product_design_state_version"
  )
FROM "_project_conversation_map" m
WHERE r."project_id" = m.project_id;

ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "comments" c
SET "conversation_id" = COALESCE(c."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE c."project_id" = m.project_id;

ALTER TABLE "constraint_rules" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "constraint_rules" r
SET "conversation_id" = COALESCE(r."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE r."project_id" = m.project_id;

ALTER TABLE "file_chunks" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "file_chunks" c
SET "conversation_id" = COALESCE(c."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE c."project_id" = m.project_id;

ALTER TABLE "file_parse_results" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "file_parse_results" r
SET "conversation_id" = COALESCE(r."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE r."project_id" = m.project_id;

UPDATE "file_assets" f
SET "conversation_id" = COALESCE(f."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE f."project_id" = m.project_id;

ALTER TABLE "knowledge_candidates" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "knowledge_candidates" c
SET "conversation_id" = COALESCE(c."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE c."project_id" = m.project_id;

ALTER TABLE "knowledge_items" ADD COLUMN IF NOT EXISTS "source_conversation_id" TEXT;
UPDATE "knowledge_items" k
SET "source_conversation_id" = COALESCE(k."source_conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE k."source_project_id" = m.project_id;

ALTER TABLE "prototype_conversion_jobs" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "prototype_conversion_jobs" j
SET "conversation_id" = COALESCE(j."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE j."project_id" = m.project_id;

UPDATE "agent_run_logs" l
SET "conversation_id" = COALESCE(l."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE l."project_id" = m.project_id;

ALTER TABLE "vibe_stream_event_logs" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;
UPDATE "vibe_stream_event_logs" e
SET "conversation_id" = COALESCE(e."conversation_id", m."conversation_id")
FROM "_project_conversation_map" m
WHERE e."project_id" = m.project_id;

CREATE INDEX IF NOT EXISTS "conversations_last_activity_at_idx"
  ON "conversations"("last_activity_at");
CREATE INDEX IF NOT EXISTS "conversations_status_idx"
  ON "conversations"("status");
CREATE INDEX IF NOT EXISTS "requirement_documents_conversation_id_idx"
  ON "requirement_documents"("conversation_id");
CREATE INDEX IF NOT EXISTS "requirement_documents_conversation_design_state_id_idx"
  ON "requirement_documents"("conversation_design_state_id");
CREATE INDEX IF NOT EXISTS "prototype_spec_records_conversation_id_idx"
  ON "prototype_spec_records"("conversation_id");
CREATE INDEX IF NOT EXISTS "prototype_spec_records_conversation_design_state_id_idx"
  ON "prototype_spec_records"("conversation_design_state_id");
CREATE INDEX IF NOT EXISTS "prototype_artifacts_conversation_id_idx"
  ON "prototype_artifacts"("conversation_id");
CREATE INDEX IF NOT EXISTS "prototype_artifacts_conversation_design_state_id_idx"
  ON "prototype_artifacts"("conversation_design_state_id");
CREATE INDEX IF NOT EXISTS "prototype_versions_conversation_id_idx"
  ON "prototype_versions"("conversation_id");
CREATE INDEX IF NOT EXISTS "qa_reports_conversation_id_idx"
  ON "qa_reports"("conversation_id");
CREATE INDEX IF NOT EXISTS "qa_reports_conversation_design_state_id_idx"
  ON "qa_reports"("conversation_design_state_id");
CREATE INDEX IF NOT EXISTS "qa_reports_conversation_design_state_version_idx"
  ON "qa_reports"("conversation_design_state_version");
CREATE INDEX IF NOT EXISTS "share_links_conversation_id_idx"
  ON "share_links"("conversation_id");
CREATE INDEX IF NOT EXISTS "comments_conversation_id_idx"
  ON "comments"("conversation_id");
CREATE INDEX IF NOT EXISTS "constraint_rules_conversation_id_idx"
  ON "constraint_rules"("conversation_id");
CREATE INDEX IF NOT EXISTS "file_chunks_conversation_id_idx"
  ON "file_chunks"("conversation_id");
CREATE INDEX IF NOT EXISTS "file_parse_results_conversation_id_idx"
  ON "file_parse_results"("conversation_id");
CREATE INDEX IF NOT EXISTS "knowledge_candidates_conversation_id_idx"
  ON "knowledge_candidates"("conversation_id");
CREATE INDEX IF NOT EXISTS "knowledge_items_scope_source_conversation_id_idx"
  ON "knowledge_items"("scope", "source_conversation_id");
CREATE INDEX IF NOT EXISTS "prototype_conversion_jobs_conversation_id_idx"
  ON "prototype_conversion_jobs"("conversation_id");
CREATE INDEX IF NOT EXISTS "vibe_stream_event_logs_conversation_id_idx"
  ON "vibe_stream_event_logs"("conversation_id");

END $legacy_backfill$;
