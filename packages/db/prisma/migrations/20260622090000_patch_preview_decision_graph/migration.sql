CREATE TABLE "patch_previews" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "patch_record_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "before_product_design_state_version" INTEGER NOT NULL,
  "after_product_design_state_version" INTEGER,
  "before_snapshot" JSONB NOT NULL,
  "after_snapshot" JSONB NOT NULL,
  "diff" JSONB NOT NULL,
  "risk_panel" JSONB NOT NULL,
  "patch_plan" JSONB NOT NULL,
  "operations" JSONB NOT NULL,
  "message" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "patch_previews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "decision_traces" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT,
  "selected_strategy" TEXT,
  "scores" JSONB NOT NULL,
  "objections" JSONB NOT NULL,
  "input" JSONB NOT NULL,
  "output" JSONB NOT NULL,
  "generated_by_run_id" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "decision_traces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "system_graphs" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "nodes" JSONB NOT NULL,
  "edges" JSONB NOT NULL,
  "preview_patch_id" TEXT,
  "generated_by_run_id" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "system_graphs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "patch_previews_patch_record_id_key" ON "patch_previews"("patch_record_id");
CREATE INDEX "patch_previews_project_id_idx" ON "patch_previews"("project_id");
CREATE INDEX "patch_previews_patch_record_id_idx" ON "patch_previews"("patch_record_id");
CREATE INDEX "patch_previews_status_idx" ON "patch_previews"("status");
CREATE INDEX "patch_previews_created_at_idx" ON "patch_previews"("created_at");

CREATE INDEX "decision_traces_project_id_idx" ON "decision_traces"("project_id");
CREATE INDEX "decision_traces_source_type_idx" ON "decision_traces"("source_type");
CREATE INDEX "decision_traces_source_id_idx" ON "decision_traces"("source_id");
CREATE INDEX "decision_traces_selected_strategy_idx" ON "decision_traces"("selected_strategy");
CREATE INDEX "decision_traces_generated_by_run_id_idx" ON "decision_traces"("generated_by_run_id");
CREATE INDEX "decision_traces_created_at_idx" ON "decision_traces"("created_at");

CREATE INDEX "system_graphs_project_id_idx" ON "system_graphs"("project_id");
CREATE INDEX "system_graphs_version_idx" ON "system_graphs"("version");
CREATE INDEX "system_graphs_status_idx" ON "system_graphs"("status");
CREATE INDEX "system_graphs_preview_patch_id_idx" ON "system_graphs"("preview_patch_id");
CREATE INDEX "system_graphs_generated_by_run_id_idx" ON "system_graphs"("generated_by_run_id");
CREATE INDEX "system_graphs_created_at_idx" ON "system_graphs"("created_at");

ALTER TABLE "patch_previews"
ADD CONSTRAINT "patch_previews_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patch_previews"
ADD CONSTRAINT "patch_previews_patch_record_id_fkey"
FOREIGN KEY ("patch_record_id") REFERENCES "patch_records"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "decision_traces"
ADD CONSTRAINT "decision_traces_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_graphs"
ADD CONSTRAINT "system_graphs_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
