-- v1 RP prototype pipeline: track Axure RP source conversion into HTML visual knowledge assets.

ALTER TYPE "FileParserType" ADD VALUE IF NOT EXISTS 'rp_project';
ALTER TYPE "FileChunkSourceType" ADD VALUE IF NOT EXISTS 'prototype_snapshot';
ALTER TYPE "FileChunkSourceType" ADD VALUE IF NOT EXISTS 'prototype_flow_edge';
ALTER TYPE "KnowledgeType" ADD VALUE IF NOT EXISTS 'prototype_project';
ALTER TYPE "KnowledgeType" ADD VALUE IF NOT EXISTS 'prototype_page';
ALTER TYPE "KnowledgeType" ADD VALUE IF NOT EXISTS 'prototype_snapshot';
ALTER TYPE "KnowledgeType" ADD VALUE IF NOT EXISTS 'prototype_flow_edge';

CREATE TYPE "PrototypeConversionStatus" AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled'
);

CREATE TABLE "prototype_conversion_jobs" (
  "id" TEXT NOT NULL,
  "file_asset_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "status" "PrototypeConversionStatus" NOT NULL DEFAULT 'queued',
  "stage" TEXT NOT NULL DEFAULT 'queued',
  "source_file_path" TEXT NOT NULL,
  "output_path" TEXT,
  "output_entry_file" TEXT,
  "output_zip_path" TEXT,
  "page_count" INTEGER NOT NULL DEFAULT 0,
  "screenshot_count" INTEGER NOT NULL DEFAULT 0,
  "converter_name" TEXT,
  "converter_version" TEXT,
  "error_message" TEXT,
  "metadata" JSONB,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "prototype_conversion_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prototype_conversion_jobs_file_asset_id_key"
  ON "prototype_conversion_jobs"("file_asset_id");
CREATE INDEX "prototype_conversion_jobs_project_id_idx"
  ON "prototype_conversion_jobs"("project_id");
CREATE INDEX "prototype_conversion_jobs_status_idx"
  ON "prototype_conversion_jobs"("status");
CREATE INDEX "prototype_conversion_jobs_stage_idx"
  ON "prototype_conversion_jobs"("stage");
CREATE INDEX "prototype_conversion_jobs_created_at_idx"
  ON "prototype_conversion_jobs"("created_at");

ALTER TABLE "prototype_conversion_jobs"
  ADD CONSTRAINT "prototype_conversion_jobs_file_asset_id_fkey"
  FOREIGN KEY ("file_asset_id") REFERENCES "file_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prototype_conversion_jobs"
  ADD CONSTRAINT "prototype_conversion_jobs_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
