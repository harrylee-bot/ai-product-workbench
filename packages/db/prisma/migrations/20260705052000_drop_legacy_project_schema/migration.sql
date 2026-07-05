-- Remove the legacy project/product/product-design physical schema.
-- Current application code and Prisma schema are conversation-first and no
-- longer reference these columns or tables.

ALTER TABLE "agent_run_logs" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "comments" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "constraint_rules" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "deerflow_thread_bindings" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "file_chunks" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "file_parse_results" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "knowledge_candidates" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "knowledge_items" DROP COLUMN IF EXISTS "source_product_id" CASCADE;
ALTER TABLE "knowledge_retrieval_logs" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "messages" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "prototype_conversion_jobs" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "prototype_versions" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "requirement_document_versions" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "share_links" DROP COLUMN IF EXISTS "project_id" CASCADE;
ALTER TABLE "vibe_stream_event_logs" DROP COLUMN IF EXISTS "project_id" CASCADE;

ALTER TABLE "requirement_documents"
  DROP COLUMN IF EXISTS "project_id" CASCADE,
  DROP COLUMN IF EXISTS "product_design_state_id" CASCADE,
  DROP COLUMN IF EXISTS "product_design_state_version" CASCADE;

ALTER TABLE "prototype_spec_records"
  DROP COLUMN IF EXISTS "project_id" CASCADE,
  DROP COLUMN IF EXISTS "product_design_state_id" CASCADE,
  DROP COLUMN IF EXISTS "product_design_state_version" CASCADE;

ALTER TABLE "prototype_artifacts"
  DROP COLUMN IF EXISTS "project_id" CASCADE,
  DROP COLUMN IF EXISTS "product_design_state_id" CASCADE,
  DROP COLUMN IF EXISTS "product_design_state_version" CASCADE;

ALTER TABLE "qa_reports"
  DROP COLUMN IF EXISTS "project_id" CASCADE,
  DROP COLUMN IF EXISTS "product_design_state_id" CASCADE,
  DROP COLUMN IF EXISTS "product_design_state_version" CASCADE;

ALTER TABLE "rollback_records"
  DROP COLUMN IF EXISTS "project_id" CASCADE,
  DROP COLUMN IF EXISTS "from_product_design_state_version" CASCADE,
  DROP COLUMN IF EXISTS "to_product_design_state_version" CASCADE;

DROP TABLE IF EXISTS "product_design_change_logs" CASCADE;
DROP TABLE IF EXISTS "product_design_versions" CASCADE;
DROP TABLE IF EXISTS "product_design_states" CASCADE;
DROP TABLE IF EXISTS "projects" CASCADE;
DROP TABLE IF EXISTS "products" CASCADE;

DROP TYPE IF EXISTS "ProductDesignChangeType" CASCADE;
DROP TYPE IF EXISTS "ProductDesignStateStatus" CASCADE;
DROP TYPE IF EXISTS "ProjectStatus" CASCADE;
