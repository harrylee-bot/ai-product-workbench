-- CreateEnum
CREATE TYPE "ProductDesignChangeType" AS ENUM ('create', 'update', 'patch', 'rollback', 'confirm_assumption', 'reject_assumption', 'answer_question');

-- AlterTable
ALTER TABLE "product_design_states" ADD COLUMN "summary" TEXT;
ALTER TABLE "product_design_states" ADD COLUMN "prototype_outline" JSONB;
ALTER TABLE "product_design_states" ADD COLUMN "confirmed_facts" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "product_design_states" ADD COLUMN "created_by" TEXT NOT NULL DEFAULT 'system';
ALTER TABLE "product_design_states" ADD COLUMN "updated_by" TEXT;
ALTER TABLE "product_design_states" ALTER COLUMN "confirmed_facts" DROP DEFAULT;
ALTER TABLE "product_design_states" ALTER COLUMN "created_by" DROP DEFAULT;

-- CreateTable
CREATE TABLE "product_design_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "state_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_design_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_design_change_logs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "state_id" TEXT NOT NULL,
    "run_id" TEXT,
    "message_id" TEXT,
    "change_type" "ProductDesignChangeType" NOT NULL,
    "path" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_design_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_design_versions_project_id_idx" ON "product_design_versions"("project_id");

-- CreateIndex
CREATE INDEX "product_design_versions_state_id_idx" ON "product_design_versions"("state_id");

-- CreateIndex
CREATE INDEX "product_design_versions_version_idx" ON "product_design_versions"("version");

-- CreateIndex
CREATE INDEX "product_design_change_logs_project_id_idx" ON "product_design_change_logs"("project_id");

-- CreateIndex
CREATE INDEX "product_design_change_logs_state_id_idx" ON "product_design_change_logs"("state_id");

-- CreateIndex
CREATE INDEX "product_design_change_logs_run_id_idx" ON "product_design_change_logs"("run_id");

-- CreateIndex
CREATE INDEX "product_design_change_logs_created_at_idx" ON "product_design_change_logs"("created_at");

-- AddForeignKey
ALTER TABLE "product_design_versions" ADD CONSTRAINT "product_design_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_design_versions" ADD CONSTRAINT "product_design_versions_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "product_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_design_change_logs" ADD CONSTRAINT "product_design_change_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_design_change_logs" ADD CONSTRAINT "product_design_change_logs_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "product_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
