-- CreateEnum
CREATE TYPE "PatchRecordStatus" AS ENUM ('planned', 'applying', 'applied', 'failed', 'cancelled', 'needs_confirmation');

-- CreateTable
CREATE TABLE "patch_records" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "instruction_message_id" TEXT,
    "selected_region" JSONB NOT NULL,
    "user_instruction" TEXT NOT NULL,
    "patch_plan" JSONB NOT NULL,
    "operations" JSONB NOT NULL,
    "status" "PatchRecordStatus" NOT NULL DEFAULT 'planned',
    "before_product_design_state_version" INTEGER NOT NULL,
    "after_product_design_state_version" INTEGER,
    "affected_prd_document_id" TEXT,
    "affected_prototype_artifact_id" TEXT,
    "generated_by_run_id" TEXT,
    "error_message" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patch_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patch_records_project_id_idx" ON "patch_records"("project_id");

-- CreateIndex
CREATE INDEX "patch_records_conversation_id_idx" ON "patch_records"("conversation_id");

-- CreateIndex
CREATE INDEX "patch_records_status_idx" ON "patch_records"("status");

-- CreateIndex
CREATE INDEX "patch_records_generated_by_run_id_idx" ON "patch_records"("generated_by_run_id");

-- CreateIndex
CREATE INDEX "patch_records_created_at_idx" ON "patch_records"("created_at");

-- AddForeignKey
ALTER TABLE "patch_records" ADD CONSTRAINT "patch_records_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patch_records" ADD CONSTRAINT "patch_records_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
