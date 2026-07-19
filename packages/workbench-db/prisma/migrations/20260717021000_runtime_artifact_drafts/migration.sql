ALTER TABLE "artifact_versions"
ADD COLUMN "runtime_draft_source_id" TEXT,
ADD COLUMN "runtime_draft_index" INTEGER,
ADD COLUMN "runtime_draft_title" TEXT;

CREATE UNIQUE INDEX "artifact_versions_created_by_run_id_runtime_draft_source_id_key"
ON "artifact_versions"("created_by_run_id", "runtime_draft_source_id");

CREATE UNIQUE INDEX "artifact_versions_created_by_run_id_runtime_draft_index_key"
ON "artifact_versions"("created_by_run_id", "runtime_draft_index");

ALTER TABLE "artifact_versions"
ADD CONSTRAINT "artifact_versions_runtime_draft_fields_check"
CHECK (
  (
    "runtime_draft_source_id" IS NULL
    AND "runtime_draft_index" IS NULL
    AND "runtime_draft_title" IS NULL
  )
  OR
  (
    "runtime_draft_source_id" IS NOT NULL
    AND "runtime_draft_index" IS NOT NULL
    AND "runtime_draft_title" IS NOT NULL
    AND "runtime_draft_index" >= 0
    AND "created_by_run_id" IS NOT NULL
  )
);
