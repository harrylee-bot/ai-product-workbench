-- CreateEnum
CREATE TYPE "AdminAuditTargetType" AS ENUM ('user', 'project', 'model_provider', 'model_config', 'model_task_profile', 'knowledge_item', 'knowledge_candidate', 'system');

-- AlterTable
ALTER TABLE "model_configs" ADD COLUMN "supports_multimodal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" "AdminAuditTargetType" NOT NULL,
    "target_id" TEXT,
    "detail" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_user_id_idx" ON "admin_audit_logs"("admin_user_id");

-- CreateIndex
CREATE INDEX "admin_audit_logs_target_type_idx" ON "admin_audit_logs"("target_type");

-- CreateIndex
CREATE INDEX "admin_audit_logs_target_id_idx" ON "admin_audit_logs"("target_id");

-- CreateIndex
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
