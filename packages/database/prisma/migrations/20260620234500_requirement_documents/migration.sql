-- CreateEnum
CREATE TYPE "RequirementDocumentStatus" AS ENUM ('draft', 'generating', 'ready', 'failed', 'confirmed');

-- CreateTable
CREATE TABLE "requirement_documents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "product_design_state_id" TEXT NOT NULL,
    "product_design_state_version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "RequirementDocumentStatus" NOT NULL DEFAULT 'draft',
    "sections" JSONB NOT NULL,
    "assumptions" JSONB,
    "knowledge_refs" JSONB,
    "pending_questions" JSONB,
    "validation_notes" JSONB,
    "generated_by_run_id" TEXT,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requirement_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "requirement_documents_project_id_idx" ON "requirement_documents"("project_id");

-- CreateIndex
CREATE INDEX "requirement_documents_product_design_state_id_idx" ON "requirement_documents"("product_design_state_id");

-- CreateIndex
CREATE INDEX "requirement_documents_status_idx" ON "requirement_documents"("status");

-- CreateIndex
CREATE INDEX "requirement_documents_updated_at_idx" ON "requirement_documents"("updated_at");

-- CreateIndex
CREATE INDEX "requirement_document_versions_document_id_idx" ON "requirement_document_versions"("document_id");

-- CreateIndex
CREATE INDEX "requirement_document_versions_project_id_idx" ON "requirement_document_versions"("project_id");

-- CreateIndex
CREATE INDEX "requirement_document_versions_version_idx" ON "requirement_document_versions"("version");

-- AddForeignKey
ALTER TABLE "requirement_documents" ADD CONSTRAINT "requirement_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_documents" ADD CONSTRAINT "requirement_documents_product_design_state_id_fkey" FOREIGN KEY ("product_design_state_id") REFERENCES "product_design_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_document_versions" ADD CONSTRAINT "requirement_document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "requirement_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_document_versions" ADD CONSTRAINT "requirement_document_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
