CREATE TYPE "QAReportStatus" AS ENUM ('running', 'passed', 'failed', 'warning');

CREATE TYPE "QAReportTrigger" AS ENUM ('initial_generation', 'patch', 'manual', 'rollback', 'pre_confirm');

CREATE TYPE "RollbackType" AS ENUM ('product_design_state');

CREATE TYPE "RollbackRecordStatus" AS ENUM ('running', 'completed', 'failed');

ALTER TABLE "patch_records" ADD COLUMN "related_qa_report_id" TEXT;

CREATE TABLE "qa_reports" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "product_design_state_id" TEXT NOT NULL,
  "product_design_state_version" INTEGER NOT NULL,
  "prd_document_id" TEXT,
  "prototype_artifact_id" TEXT,
  "prototype_spec_id" TEXT,
  "status" "QAReportStatus" NOT NULL,
  "trigger" "QAReportTrigger" NOT NULL,
  "check_types" JSONB NOT NULL,
  "summary" TEXT NOT NULL,
  "issues" JSONB NOT NULL,
  "blocking_count" INTEGER NOT NULL DEFAULT 0,
  "major_count" INTEGER NOT NULL DEFAULT 0,
  "minor_count" INTEGER NOT NULL DEFAULT 0,
  "info_count" INTEGER NOT NULL DEFAULT 0,
  "generated_by_run_id" TEXT,
  "related_patch_id" TEXT,
  "related_rollback_id" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "qa_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rollback_records" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "rollback_type" "RollbackType" NOT NULL,
  "from_product_design_state_version" INTEGER NOT NULL,
  "to_product_design_state_version" INTEGER NOT NULL,
  "before_prd_document_id" TEXT,
  "after_prd_document_id" TEXT,
  "before_prototype_artifact_id" TEXT,
  "after_prototype_artifact_id" TEXT,
  "reason" TEXT,
  "status" "RollbackRecordStatus" NOT NULL DEFAULT 'running',
  "generated_by_run_id" TEXT,
  "error_message" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "rollback_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "qa_reports_project_id_idx" ON "qa_reports"("project_id");
CREATE INDEX "qa_reports_product_design_state_id_idx" ON "qa_reports"("product_design_state_id");
CREATE INDEX "qa_reports_product_design_state_version_idx" ON "qa_reports"("product_design_state_version");
CREATE INDEX "qa_reports_status_idx" ON "qa_reports"("status");
CREATE INDEX "qa_reports_trigger_idx" ON "qa_reports"("trigger");
CREATE INDEX "qa_reports_generated_by_run_id_idx" ON "qa_reports"("generated_by_run_id");
CREATE INDEX "qa_reports_related_patch_id_idx" ON "qa_reports"("related_patch_id");
CREATE INDEX "qa_reports_related_rollback_id_idx" ON "qa_reports"("related_rollback_id");
CREATE INDEX "qa_reports_created_at_idx" ON "qa_reports"("created_at");

CREATE INDEX "rollback_records_project_id_idx" ON "rollback_records"("project_id");
CREATE INDEX "rollback_records_status_idx" ON "rollback_records"("status");
CREATE INDEX "rollback_records_created_at_idx" ON "rollback_records"("created_at");

ALTER TABLE "qa_reports" ADD CONSTRAINT "qa_reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rollback_records" ADD CONSTRAINT "rollback_records_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
