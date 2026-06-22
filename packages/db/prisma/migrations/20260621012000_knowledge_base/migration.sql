-- CreateEnum
CREATE TYPE "KnowledgeType" AS ENUM ('strong_rule', 'default_rule', 'reference_case', 'design_pattern', 'prd_writing_rule', 'prototype_rule', 'business_concept');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('draft', 'active', 'disabled', 'archived');

-- CreateEnum
CREATE TYPE "KnowledgeScope" AS ENUM ('global', 'project');

-- CreateEnum
CREATE TYPE "KnowledgePriority" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "KnowledgeSource" AS ENUM ('manual', 'project_extraction', 'file_extraction', 'prd_confirmation', 'prototype_confirmation');

-- CreateEnum
CREATE TYPE "KnowledgeCandidateSource" AS ENUM ('prd', 'prototype', 'product_design_state', 'conversation', 'uploaded_file');

-- CreateEnum
CREATE TYPE "KnowledgeCandidateStatus" AS ENUM ('pending', 'approved', 'rejected', 'merged');

-- CreateTable
CREATE TABLE "knowledge_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parent_id" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_items" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "type" "KnowledgeType" NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'draft',
    "scope" "KnowledgeScope" NOT NULL DEFAULT 'global',
    "category_id" TEXT,
    "tags" JSONB,
    "priority" "KnowledgePriority" NOT NULL DEFAULT 'medium',
    "source" "KnowledgeSource" NOT NULL,
    "source_project_id" TEXT,
    "source_file_id" TEXT,
    "source_prd_document_id" TEXT,
    "source_prototype_artifact_id" TEXT,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_versions" (
    "id" TEXT NOT NULL,
    "knowledge_item_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "change_summary" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_candidates" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "suggested_type" "KnowledgeType" NOT NULL,
    "suggested_category_id" TEXT,
    "suggested_tags" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" "KnowledgeCandidateSource" NOT NULL,
    "source_ref_id" TEXT,
    "source_path" TEXT,
    "reason" TEXT NOT NULL,
    "status" "KnowledgeCandidateStatus" NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_comment" TEXT,
    "created_by_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_retrieval_logs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT,
    "conversation_id" TEXT,
    "run_id" TEXT,
    "agent_name" TEXT,
    "query" TEXT NOT NULL,
    "task_type" TEXT,
    "matched_knowledge_ids" JSONB NOT NULL,
    "selected_knowledge_ids" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_retrieval_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_categories_parent_id_idx" ON "knowledge_categories"("parent_id");

-- CreateIndex
CREATE INDEX "knowledge_categories_order_idx" ON "knowledge_categories"("order");

-- CreateIndex
CREATE INDEX "knowledge_items_type_idx" ON "knowledge_items"("type");

-- CreateIndex
CREATE INDEX "knowledge_items_status_idx" ON "knowledge_items"("status");

-- CreateIndex
CREATE INDEX "knowledge_items_scope_idx" ON "knowledge_items"("scope");

-- CreateIndex
CREATE INDEX "knowledge_items_category_id_idx" ON "knowledge_items"("category_id");

-- CreateIndex
CREATE INDEX "knowledge_items_created_at_idx" ON "knowledge_items"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_tags_name_key" ON "knowledge_tags"("name");

-- CreateIndex
CREATE INDEX "knowledge_versions_knowledge_item_id_idx" ON "knowledge_versions"("knowledge_item_id");

-- CreateIndex
CREATE INDEX "knowledge_versions_version_idx" ON "knowledge_versions"("version");

-- CreateIndex
CREATE INDEX "knowledge_candidates_project_id_idx" ON "knowledge_candidates"("project_id");

-- CreateIndex
CREATE INDEX "knowledge_candidates_status_idx" ON "knowledge_candidates"("status");

-- CreateIndex
CREATE INDEX "knowledge_candidates_suggested_type_idx" ON "knowledge_candidates"("suggested_type");

-- CreateIndex
CREATE INDEX "knowledge_candidates_created_at_idx" ON "knowledge_candidates"("created_at");

-- CreateIndex
CREATE INDEX "knowledge_retrieval_logs_project_id_idx" ON "knowledge_retrieval_logs"("project_id");

-- CreateIndex
CREATE INDEX "knowledge_retrieval_logs_run_id_idx" ON "knowledge_retrieval_logs"("run_id");

-- CreateIndex
CREATE INDEX "knowledge_retrieval_logs_agent_name_idx" ON "knowledge_retrieval_logs"("agent_name");

-- CreateIndex
CREATE INDEX "knowledge_retrieval_logs_created_at_idx" ON "knowledge_retrieval_logs"("created_at");

-- AddForeignKey
ALTER TABLE "knowledge_categories" ADD CONSTRAINT "knowledge_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "knowledge_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "knowledge_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_knowledge_item_id_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_candidates" ADD CONSTRAINT "knowledge_candidates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
