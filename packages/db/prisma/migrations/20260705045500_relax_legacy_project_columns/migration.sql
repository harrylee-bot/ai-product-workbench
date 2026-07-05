-- The current application no longer writes legacy project/product-design
-- columns. Keep the columns for historical data, but relax NOT NULL so new
-- conversation-first writes do not fail on columns Prisma no longer knows.

ALTER TABLE "conversations" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "messages" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "file_assets" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "file_chunks" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "file_parse_results" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "knowledge_candidates" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "prototype_conversion_jobs" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "agent_run_logs" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "vibe_stream_event_logs" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "comments" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "constraint_rules" ALTER COLUMN "project_id" DROP NOT NULL;

ALTER TABLE "requirement_documents"
  ALTER COLUMN "project_id" DROP NOT NULL,
  ALTER COLUMN "product_design_state_id" DROP NOT NULL,
  ALTER COLUMN "product_design_state_version" DROP NOT NULL;

ALTER TABLE "requirement_document_versions" ALTER COLUMN "project_id" DROP NOT NULL;

ALTER TABLE "prototype_spec_records"
  ALTER COLUMN "project_id" DROP NOT NULL,
  ALTER COLUMN "product_design_state_id" DROP NOT NULL,
  ALTER COLUMN "product_design_state_version" DROP NOT NULL;

ALTER TABLE "prototype_artifacts"
  ALTER COLUMN "project_id" DROP NOT NULL,
  ALTER COLUMN "product_design_state_id" DROP NOT NULL,
  ALTER COLUMN "product_design_state_version" DROP NOT NULL;

ALTER TABLE "prototype_versions" ALTER COLUMN "project_id" DROP NOT NULL;

ALTER TABLE "qa_reports"
  ALTER COLUMN "project_id" DROP NOT NULL,
  ALTER COLUMN "product_design_state_id" DROP NOT NULL,
  ALTER COLUMN "product_design_state_version" DROP NOT NULL;

ALTER TABLE "share_links" ALTER COLUMN "project_id" DROP NOT NULL;

ALTER TABLE "rollback_records"
  ALTER COLUMN "project_id" DROP NOT NULL,
  ALTER COLUMN "from_product_design_state_version" DROP NOT NULL,
  ALTER COLUMN "to_product_design_state_version" DROP NOT NULL;
