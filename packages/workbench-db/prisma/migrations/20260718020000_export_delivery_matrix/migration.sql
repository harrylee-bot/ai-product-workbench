CREATE TYPE "ExportPackaging" AS ENUM ('single_file', 'zip');
CREATE TYPE "ExternalExportTarget" AS ENUM ('ai_studio', 'netlify', 'lovable', 'bolt');
CREATE TYPE "ExternalExportAuthentication" AS ENUM ('not_required', 'required', 'authenticated');
CREATE TYPE "ExternalExportDeliveryStatus" AS ENUM (
  'pending_confirmation',
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled'
);

ALTER TABLE "export_jobs"
ADD COLUMN "packaging" "ExportPackaging";

ALTER TABLE "export_jobs"
DISABLE TRIGGER "export_jobs_mutation_guard";

UPDATE "export_jobs"
SET "packaging" = CASE
  WHEN "format" = 'html' THEN 'single_file'::"ExportPackaging"
  ELSE 'zip'::"ExportPackaging"
END
WHERE "packaging" IS NULL;

ALTER TABLE "export_jobs"
ENABLE TRIGGER "export_jobs_mutation_guard";

ALTER TABLE "export_jobs"
ALTER COLUMN "packaging" SET NOT NULL;

ALTER TABLE "export_jobs"
ADD CONSTRAINT "export_jobs_format_packaging_check"
CHECK (
  ("format" = 'html' AND "packaging" IN ('single_file', 'zip'))
  OR ("format" IN ('react', 'figma', 'mcp') AND "packaging" = 'zip')
);

CREATE TABLE "external_export_deliveries" (
  "id" TEXT NOT NULL,
  "export_job_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "target" "ExternalExportTarget" NOT NULL,
  "authentication" "ExternalExportAuthentication" NOT NULL,
  "status" "ExternalExportDeliveryStatus" NOT NULL DEFAULT 'pending_confirmation',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL,
  "remote_reference" VARCHAR(500),
  "failure_code" VARCHAR(120),
  "failure_detail" VARCHAR(4000),
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "lease_token" VARCHAR(128),
  "lease_expires_at" TIMESTAMPTZ(6),
  "transfer_authorized_at" TIMESTAMPTZ(6),
  "confirmed_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "external_export_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_export_deliveries_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "external_export_deliveries_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "external_export_deliveries_attempt_check" CHECK ("attempt" >= 0),
  CONSTRAINT "external_export_deliveries_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "external_export_deliveries_transfer_evidence_check" CHECK (
    ("remote_reference" IS NULL OR "transfer_authorized_at" IS NOT NULL)
    AND ("transfer_authorized_at" IS NULL OR (
      "attempt" >= 1 AND "confirmed_at" IS NOT NULL AND "started_at" IS NOT NULL
    ))
  ),
  CONSTRAINT "external_export_deliveries_state_check" CHECK (
    ("status" = 'pending_confirmation'
      AND "attempt" = 0
      AND "confirmed_at" IS NULL AND "started_at" IS NULL AND "finished_at" IS NULL
      AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
      AND "transfer_authorized_at" IS NULL
      AND "remote_reference" IS NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL)
    OR ("status" = 'queued'
      AND "confirmed_at" IS NOT NULL AND "started_at" IS NULL AND "finished_at" IS NULL
      AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
      AND "transfer_authorized_at" IS NULL
      AND "remote_reference" IS NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL)
    OR ("status" = 'running'
      AND "attempt" >= 1
      AND "confirmed_at" IS NOT NULL AND "started_at" IS NOT NULL AND "finished_at" IS NULL
      AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL
      AND "remote_reference" IS NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL)
    OR ("status" = 'cancelling'
      AND "attempt" >= 1
      AND "confirmed_at" IS NOT NULL AND "started_at" IS NOT NULL AND "finished_at" IS NULL
      AND (("lease_token" IS NULL AND "lease_expires_at" IS NULL)
        OR ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
      AND "failure_code" IS NULL AND "failure_detail" IS NULL)
    OR ("status" = 'succeeded'
      AND "attempt" >= 1
      AND "confirmed_at" IS NOT NULL AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL
      AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
      AND "transfer_authorized_at" IS NOT NULL
      AND "remote_reference" IS NOT NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL)
    OR ("status" = 'failed'
      AND "attempt" >= 1
      AND "confirmed_at" IS NOT NULL AND "finished_at" IS NOT NULL
      AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
      AND "remote_reference" IS NULL AND "failure_code" IS NOT NULL)
    OR ("status" = 'cancelled'
      AND "finished_at" IS NOT NULL AND "remote_reference" IS NULL
      AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
      AND "failure_code" IS NULL AND "failure_detail" IS NULL)
  )
);

CREATE UNIQUE INDEX "external_export_deliveries_export_job_id_idempotency_key_key"
ON "external_export_deliveries"("export_job_id", "idempotency_key");
CREATE INDEX "external_export_deliveries_created_by_id_created_at_idx"
ON "external_export_deliveries"("created_by_id", "created_at");
CREATE INDEX "external_export_deliveries_export_job_id_created_at_idx"
ON "external_export_deliveries"("export_job_id", "created_at");
CREATE INDEX "external_export_deliveries_status_updated_at_idx"
ON "external_export_deliveries"("status", "updated_at");
CREATE UNIQUE INDEX "external_export_deliveries_lease_token_key"
ON "external_export_deliveries"("lease_token");
CREATE INDEX "external_export_deliveries_status_lease_expires_at_idx"
ON "external_export_deliveries"("status", "lease_expires_at");

ALTER TABLE "external_export_deliveries"
ADD CONSTRAINT "external_export_deliveries_export_job_id_fkey"
FOREIGN KEY ("export_job_id") REFERENCES "export_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "external_export_deliveries"
ADD CONSTRAINT "external_export_deliveries_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
