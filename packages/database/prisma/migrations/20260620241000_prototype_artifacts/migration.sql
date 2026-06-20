-- CreateEnum
CREATE TYPE "PrototypeTargetDevice" AS ENUM ('desktop', 'mobile', 'both');

-- CreateEnum
CREATE TYPE "PrototypeArtifactStatus" AS ENUM ('generating', 'ready', 'failed');

-- CreateTable
CREATE TABLE "prototype_spec_records" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "product_design_state_id" TEXT NOT NULL,
    "product_design_state_version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "target_device" "PrototypeTargetDevice" NOT NULL DEFAULT 'both',
    "style_guide" JSONB NOT NULL,
    "pages" JSONB NOT NULL,
    "navigation" JSONB NOT NULL,
    "interactions" JSONB NOT NULL,
    "assumptions" JSONB,
    "knowledge_refs" JSONB,
    "generated_by_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prototype_spec_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prototype_artifacts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "prototype_spec_id" TEXT NOT NULL,
    "product_design_state_id" TEXT NOT NULL,
    "product_design_state_version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "PrototypeArtifactStatus" NOT NULL DEFAULT 'generating',
    "html_content" TEXT,
    "entry_file_path" TEXT,
    "preview_url" TEXT,
    "target_device" "PrototypeTargetDevice" NOT NULL DEFAULT 'both',
    "page_count" INTEGER NOT NULL DEFAULT 1,
    "generated_by_run_id" TEXT,
    "error_message" TEXT,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prototype_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prototype_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prototype_spec_snapshot" JSONB NOT NULL,
    "artifact_snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prototype_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prototype_spec_records_project_id_idx" ON "prototype_spec_records"("project_id");

-- CreateIndex
CREATE INDEX "prototype_spec_records_product_design_state_id_idx" ON "prototype_spec_records"("product_design_state_id");

-- CreateIndex
CREATE INDEX "prototype_spec_records_updated_at_idx" ON "prototype_spec_records"("updated_at");

-- CreateIndex
CREATE INDEX "prototype_artifacts_project_id_idx" ON "prototype_artifacts"("project_id");

-- CreateIndex
CREATE INDEX "prototype_artifacts_prototype_spec_id_idx" ON "prototype_artifacts"("prototype_spec_id");

-- CreateIndex
CREATE INDEX "prototype_artifacts_product_design_state_id_idx" ON "prototype_artifacts"("product_design_state_id");

-- CreateIndex
CREATE INDEX "prototype_artifacts_status_idx" ON "prototype_artifacts"("status");

-- CreateIndex
CREATE INDEX "prototype_artifacts_updated_at_idx" ON "prototype_artifacts"("updated_at");

-- CreateIndex
CREATE INDEX "prototype_versions_project_id_idx" ON "prototype_versions"("project_id");

-- CreateIndex
CREATE INDEX "prototype_versions_artifact_id_idx" ON "prototype_versions"("artifact_id");

-- CreateIndex
CREATE INDEX "prototype_versions_version_idx" ON "prototype_versions"("version");

-- AddForeignKey
ALTER TABLE "prototype_spec_records" ADD CONSTRAINT "prototype_spec_records_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prototype_spec_records" ADD CONSTRAINT "prototype_spec_records_product_design_state_id_fkey" FOREIGN KEY ("product_design_state_id") REFERENCES "product_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prototype_artifacts" ADD CONSTRAINT "prototype_artifacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prototype_artifacts" ADD CONSTRAINT "prototype_artifacts_product_design_state_id_fkey" FOREIGN KEY ("product_design_state_id") REFERENCES "product_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prototype_artifacts" ADD CONSTRAINT "prototype_artifacts_prototype_spec_id_fkey" FOREIGN KEY ("prototype_spec_id") REFERENCES "prototype_spec_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prototype_versions" ADD CONSTRAINT "prototype_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prototype_versions" ADD CONSTRAINT "prototype_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "prototype_artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
