CREATE TYPE "PrototypePlanStatus" AS ENUM ('draft', 'approved', 'generating', 'ready', 'failed', 'cancelled');
CREATE TYPE "PrototypeRevisionStatus" AS ENUM ('queued', 'generating', 'ready', 'confirmed', 'rejected', 'failed', 'cancelled');
CREATE TYPE "PrototypeFeedbackStatus" AS ENUM ('open', 'resolved');
CREATE TYPE "PrototypeShareStatus" AS ENUM ('active', 'revoked', 'expired');
CREATE TYPE "PrototypeExportFormat" AS ENUM ('html', 'react');
CREATE TYPE "PrototypeExportStatus" AS ENUM ('queued', 'building', 'succeeded', 'failed', 'cancelled');
CREATE TYPE "PrototypeMutationKind" AS ENUM ('plan_create', 'plan_approve', 'plan_cancel', 'revision_create', 'feedback_create', 'feedback_resolve', 'share_create', 'share_revoke', 'export_create', 'export_retry', 'export_cancel');

CREATE TABLE "prototype_plans" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "status" "PrototypePlanStatus" NOT NULL DEFAULT 'draft',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prototype_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prototype_plans_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "prototype_plans_idempotency_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$')
);
CREATE UNIQUE INDEX "prototype_plans_project_idempotency_key" ON "prototype_plans"("project_id", "idempotency_key");
CREATE INDEX "prototype_plans_project_status_updated_at_idx" ON "prototype_plans"("project_id", "status", "updated_at");
CREATE INDEX "prototype_plans_created_by_id_idx" ON "prototype_plans"("created_by_id");
ALTER TABLE "prototype_plans" ADD CONSTRAINT "prototype_plans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_plans" ADD CONSTRAINT "prototype_plans_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "prototype_revisions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "PrototypeRevisionStatus" NOT NULL DEFAULT 'queued',
  "title" TEXT NOT NULL,
  "pages" JSONB NOT NULL,
  "document_sha256" CHAR(64) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prototype_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prototype_revisions_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "prototype_revisions_document_sha256_check" CHECK ("document_sha256" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "prototype_revisions_project_plan_idempotency_key" ON "prototype_revisions"("project_id", "plan_id", "idempotency_key");
CREATE UNIQUE INDEX "prototype_revisions_plan_revision_key" ON "prototype_revisions"("plan_id", "revision");
CREATE INDEX "prototype_revisions_project_created_at_idx" ON "prototype_revisions"("project_id", "created_at");
CREATE INDEX "prototype_revisions_project_status_updated_at_idx" ON "prototype_revisions"("project_id", "status", "updated_at");
ALTER TABLE "prototype_revisions" ADD CONSTRAINT "prototype_revisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_revisions" ADD CONSTRAINT "prototype_revisions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "prototype_plans"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_revisions" ADD CONSTRAINT "prototype_revisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "prototype_feedback" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "anchor" JSONB,
  "status" "PrototypeFeedbackStatus" NOT NULL DEFAULT 'open',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prototype_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prototype_feedback_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "prototype_feedback_project_creator_idempotency_key" ON "prototype_feedback"("project_id", "created_by_id", "idempotency_key");
CREATE INDEX "prototype_feedback_project_revision_status_created_at_idx" ON "prototype_feedback"("project_id", "revision_id", "status", "created_at");
ALTER TABLE "prototype_feedback" ADD CONSTRAINT "prototype_feedback_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_feedback" ADD CONSTRAINT "prototype_feedback_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "prototype_revisions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_feedback" ADD CONSTRAINT "prototype_feedback_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "prototype_shares" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "status" "PrototypeShareStatus" NOT NULL DEFAULT 'active',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prototype_shares_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prototype_shares_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "prototype_shares_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "prototype_shares_project_creator_idempotency_key" ON "prototype_shares"("project_id", "created_by_id", "idempotency_key");
CREATE INDEX "prototype_shares_project_status_created_at_idx" ON "prototype_shares"("project_id", "status", "created_at");
CREATE INDEX "prototype_shares_revision_id_idx" ON "prototype_shares"("revision_id");
ALTER TABLE "prototype_shares" ADD CONSTRAINT "prototype_shares_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_shares" ADD CONSTRAINT "prototype_shares_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "prototype_revisions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_shares" ADD CONSTRAINT "prototype_shares_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "prototype_exports" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "format" "PrototypeExportFormat" NOT NULL,
  "status" "PrototypeExportStatus" NOT NULL DEFAULT 'queued',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "artifact_key" TEXT,
  "artifact_sha256" CHAR(64),
  "byte_size" INTEGER,
  "media_type" TEXT,
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "prototype_exports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prototype_exports_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "prototype_exports_artifact_sha256_check" CHECK ("artifact_sha256" IS NULL OR "artifact_sha256" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "prototype_exports_project_creator_idempotency_key" ON "prototype_exports"("project_id", "created_by_id", "idempotency_key");
CREATE INDEX "prototype_exports_project_status_updated_at_idx" ON "prototype_exports"("project_id", "status", "updated_at");
CREATE INDEX "prototype_exports_revision_id_idx" ON "prototype_exports"("revision_id");
ALTER TABLE "prototype_exports" ADD CONSTRAINT "prototype_exports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_exports" ADD CONSTRAINT "prototype_exports_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "prototype_revisions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_exports" ADD CONSTRAINT "prototype_exports_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "prototype_mutation_receipts" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "kind" "PrototypeMutationKind" NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "response" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prototype_mutation_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prototype_mutation_receipts_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "prototype_mutation_receipts_scope_key" ON "prototype_mutation_receipts"("project_id", "target_id", "created_by_id", "kind", "idempotency_key");
CREATE INDEX "prototype_mutation_receipts_project_created_at_idx" ON "prototype_mutation_receipts"("project_id", "created_at");
ALTER TABLE "prototype_mutation_receipts" ADD CONSTRAINT "prototype_mutation_receipts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_mutation_receipts" ADD CONSTRAINT "prototype_mutation_receipts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
