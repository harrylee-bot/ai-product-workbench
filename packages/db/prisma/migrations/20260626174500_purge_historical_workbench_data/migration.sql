-- Purge historical test workbench state while keeping reusable foundations:
-- users, model providers/configs/task profiles, and curated knowledge base content.

UPDATE "projects"
SET
  "current_conversation_id" = NULL,
  "current_product_design_state_id" = NULL,
  "current_prd_document_id" = NULL,
  "current_prototype_artifact_id" = NULL,
  "latest_qa_report_id" = NULL;

DELETE FROM "vibe_stream_event_logs";
DELETE FROM "agent_step_logs";
DELETE FROM "agent_run_logs";
DELETE FROM "model_call_logs";
DELETE FROM "knowledge_retrieval_logs";
DELETE FROM "admin_audit_logs";
DELETE FROM "login_audit_logs";

DELETE FROM "share_links";
DELETE FROM "rollback_records";
DELETE FROM "qa_reports";
DELETE FROM "prototype_versions";
DELETE FROM "prototype_artifacts";
DELETE FROM "prototype_spec_records";
DELETE FROM "requirement_document_versions";
DELETE FROM "requirement_documents";
DELETE FROM "product_design_change_logs";
DELETE FROM "product_design_versions";
DELETE FROM "product_design_states";
DELETE FROM "constraint_rules";
DELETE FROM "knowledge_candidates";
DELETE FROM "file_chunks";
DELETE FROM "file_parse_results";
DELETE FROM "file_assets";
DELETE FROM "messages";
DELETE FROM "conversations";
DELETE FROM "projects";

UPDATE "knowledge_items"
SET
  "source_project_id" = NULL,
  "source_file_id" = NULL,
  "source_prd_document_id" = NULL,
  "source_prototype_artifact_id" = NULL
WHERE
  "source_project_id" IS NOT NULL
  OR "source_file_id" IS NOT NULL
  OR "source_prd_document_id" IS NOT NULL
  OR "source_prototype_artifact_id" IS NOT NULL;
