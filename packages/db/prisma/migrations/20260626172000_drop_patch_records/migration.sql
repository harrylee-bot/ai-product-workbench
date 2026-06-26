DROP TABLE IF EXISTS "patch_previews";
DROP TABLE IF EXISTS "patch_records";

ALTER TABLE "qa_reports" DROP COLUMN IF EXISTS "related_patch_id";

DROP TYPE IF EXISTS "PatchRecordStatus";

DELETE FROM "model_task_profiles" WHERE "task_type" = 'patch_planning';
UPDATE "model_call_logs" SET "task_type" = 'product_design' WHERE "task_type" = 'patch_planning';
UPDATE "product_design_states" SET "status" = 'design_ready' WHERE "status" = 'patching';
UPDATE "product_design_change_logs" SET "change_type" = 'update' WHERE "change_type" = 'patch';
UPDATE "qa_reports" SET "trigger" = 'manual' WHERE "trigger" = 'patch';
UPDATE "agent_step_logs" SET "agent_name" = 'product_designer_agent' WHERE "agent_name" = 'patch_agent';
UPDATE "agent_run_logs" SET "intent" = 'general_question'
WHERE "intent" IN ('patch_document', 'patch_prototype', 'global_adjustment');

ALTER TYPE "ModelTaskType" RENAME TO "ModelTaskType_old";
CREATE TYPE "ModelTaskType" AS ENUM (
  'intent_detection',
  'knowledge_classification',
  'requirement_analysis',
  'product_planning',
  'product_design',
  'prd_generation',
  'prototype_design',
  'prototype_code_generation',
  'qa_check',
  'knowledge_extraction',
  'general_chat'
);
ALTER TABLE "model_task_profiles"
  ALTER COLUMN "task_type" TYPE "ModelTaskType" USING "task_type"::text::"ModelTaskType";
ALTER TABLE "model_call_logs"
  ALTER COLUMN "task_type" TYPE "ModelTaskType" USING "task_type"::text::"ModelTaskType";
DROP TYPE "ModelTaskType_old";

ALTER TABLE "product_design_states" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "ProductDesignStateStatus" RENAME TO "ProductDesignStateStatus_old";
CREATE TYPE "ProductDesignStateStatus" AS ENUM (
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
ALTER TABLE "product_design_states"
  ALTER COLUMN "status" TYPE "ProductDesignStateStatus" USING "status"::text::"ProductDesignStateStatus";
ALTER TABLE "product_design_states" ALTER COLUMN "status" SET DEFAULT 'draft';
DROP TYPE "ProductDesignStateStatus_old";

ALTER TYPE "ProductDesignChangeType" RENAME TO "ProductDesignChangeType_old";
CREATE TYPE "ProductDesignChangeType" AS ENUM (
  'create',
  'update',
  'rollback',
  'confirm_assumption',
  'reject_assumption',
  'answer_question'
);
ALTER TABLE "product_design_change_logs"
  ALTER COLUMN "change_type" TYPE "ProductDesignChangeType" USING "change_type"::text::"ProductDesignChangeType";
DROP TYPE "ProductDesignChangeType_old";

ALTER TYPE "QAReportTrigger" RENAME TO "QAReportTrigger_old";
CREATE TYPE "QAReportTrigger" AS ENUM (
  'initial_generation',
  'manual',
  'rollback',
  'pre_confirm'
);
ALTER TABLE "qa_reports"
  ALTER COLUMN "trigger" TYPE "QAReportTrigger" USING "trigger"::text::"QAReportTrigger";
DROP TYPE "QAReportTrigger_old";

ALTER TYPE "AgentName" RENAME TO "AgentName_old";
CREATE TYPE "AgentName" AS ENUM (
  'orchestrator',
  'intent_agent',
  'knowledge_agent',
  'requirement_analyst_agent',
  'product_planner_agent',
  'product_designer_agent',
  'prd_writer_agent',
  'prototype_designer_agent',
  'prototype_code_agent',
  'qa_agent',
  'knowledge_extractor_agent'
);
ALTER TABLE "agent_step_logs"
  ALTER COLUMN "agent_name" TYPE "AgentName" USING "agent_name"::text::"AgentName";
DROP TYPE "AgentName_old";

ALTER TYPE "UserIntent" RENAME TO "UserIntent_old";
CREATE TYPE "UserIntent" AS ENUM (
  'new_requirement',
  'complete_requirement',
  'clarification_answer',
  'generate_prd',
  'generate_prototype',
  'export_word',
  'export_html',
  'knowledge_update',
  'general_question'
);
ALTER TABLE "agent_run_logs"
  ALTER COLUMN "intent" TYPE "UserIntent" USING "intent"::text::"UserIntent";
DROP TYPE "UserIntent_old";
