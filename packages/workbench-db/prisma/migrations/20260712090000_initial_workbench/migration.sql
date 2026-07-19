-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "workbench";

-- Database extensions are provisioned by infrastructure before the
-- least-privilege application migrator runs. See
-- deploy/workbench-postgres-extensions.sql.

-- CreateEnum
CREATE TYPE "PrincipalStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "ThreadEntryRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "ThreadEntryKind" AS ENUM ('message', 'activity', 'approval');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'waiting_input', 'cancelling', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'submitted', 'expired');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('prd', 'prototype', 'image', 'code', 'document', 'data');

-- CreateEnum
CREATE TYPE "ArtifactVersionStatus" AS ENUM ('staging', 'ready', 'rejected');

-- CreateEnum
CREATE TYPE "BlobStatus" AS ENUM ('pending', 'ready', 'quarantined', 'deleted');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('uploading', 'processing', 'ready', 'failed', 'quarantined', 'deleted');

-- CreateEnum
CREATE TYPE "ShareScope" AS ENUM ('view', 'remix');

-- CreateEnum
CREATE TYPE "ShareStatus" AS ENUM ('active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "KnowledgeReleaseStatus" AS ENUM ('building', 'ready', 'failed', 'retired');

-- CreateEnum
CREATE TYPE "KnowledgeSourceKind" AS ENUM ('vault_markdown', 'storage_asset', 'project_upload');

-- CreateEnum
CREATE TYPE "KnowledgeRoute" AS ENUM ('production', 'source_lookup', 'excluded', 'quarantine');

-- CreateTable
CREATE TABLE "principals" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "status" "PrincipalStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "workspace_id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id","principal_id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "threads" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "entry_sequence" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread_entries" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" "ThreadEntryRole" NOT NULL,
    "kind" "ThreadEntryKind" NOT NULL DEFAULT 'message',
    "content" JSONB NOT NULL,
    "produced_by_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "knowledge_release_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "model_id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "event_sequence" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_detail" TEXT,
    "output_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_bindings" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runtime_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "trace_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_drafts" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "content" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_approvals" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "response" JSONB,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blobs" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "status" "BlobStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_assets" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "blob_id" TEXT,
    "uploaded_by_id" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'uploading',
    "failure_code" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "title" TEXT NOT NULL,
    "current_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_versions" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "status" "ArtifactVersionStatus" NOT NULL DEFAULT 'staging',
    "content" JSONB,
    "content_blob_id" TEXT,
    "checksum" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "created_by_run_id" TEXT,
    "knowledge_release_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boards" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "viewport" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_nodes" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "position" JSONB NOT NULL,
    "size" JSONB,
    "artifact_id" TEXT,
    "artifact_version_id" TEXT,
    "data" JSONB NOT NULL,

    CONSTRAINT "board_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_edges" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "edge_key" TEXT NOT NULL,
    "source_node_key" TEXT NOT NULL,
    "target_node_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "board_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_grants" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scope" "ShareScope" NOT NULL DEFAULT 'view',
    "status" "ShareStatus" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "artifact_version_id" TEXT,
    "format" TEXT NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'queued',
    "options" JSONB NOT NULL,
    "output_blob_id" TEXT,
    "failure_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_releases" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "workspace_id" TEXT,
    "version" INTEGER NOT NULL,
    "status" "KnowledgeReleaseStatus" NOT NULL DEFAULT 'building',
    "manifest_sha256" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "knowledge_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "source_kind" "KnowledgeSourceKind" NOT NULL,
    "source_path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "route" "KnowledgeRoute" NOT NULL,
    "source_blob_id" TEXT,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "heading_path" JSONB NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "embedding_model" TEXT,
    "embedding" public.vector(1536),
    "search_vector" tsvector,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "principals_email_idx" ON "principals"("email");

-- CreateIndex
CREATE UNIQUE INDEX "principals_issuer_subject_key" ON "principals"("issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_created_by_id_idx" ON "workspaces"("created_by_id");

-- CreateIndex
CREATE INDEX "workspace_members_principal_id_idx" ON "workspace_members"("principal_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_status_updated_at_idx" ON "projects"("workspace_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "projects_created_by_id_idx" ON "projects"("created_by_id");

-- CreateIndex
CREATE INDEX "threads_project_id_updated_at_idx" ON "threads"("project_id", "updated_at");

-- CreateIndex
CREATE INDEX "thread_entries_produced_by_run_id_idx" ON "thread_entries"("produced_by_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "thread_entries_thread_id_sequence_key" ON "thread_entries"("thread_id", "sequence");

-- CreateIndex
CREATE INDEX "runs_project_id_created_at_idx" ON "runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "runs_thread_id_status_idx" ON "runs"("thread_id", "status");

-- CreateIndex
CREATE INDEX "runs_created_by_id_idx" ON "runs"("created_by_id");

-- CreateIndex
CREATE INDEX "runs_knowledge_release_id_idx" ON "runs"("knowledge_release_id");

-- CreateIndex
CREATE INDEX "runs_trace_id_idx" ON "runs"("trace_id");

-- CreateIndex
CREATE UNIQUE INDEX "runs_thread_id_idempotency_key_key" ON "runs"("thread_id", "idempotency_key");

CREATE UNIQUE INDEX "runs_request_id_key" ON "runs"("request_id");

CREATE UNIQUE INDEX "runs_output_entry_id_key" ON "runs"("output_entry_id");

-- A thread has one execution owner at a time. Terminal runs do not block a new run.
CREATE UNIQUE INDEX "runs_one_active_per_thread_idx"
ON "runs"("thread_id")
WHERE "status" IN ('queued', 'running', 'waiting_input', 'cancelling');

CREATE UNIQUE INDEX "runtime_bindings_thread_id_key" ON "runtime_bindings"("thread_id");

CREATE UNIQUE INDEX "runtime_bindings_adapter_external_thread_id_key" ON "runtime_bindings"("adapter", "external_thread_id");

-- CreateIndex
CREATE INDEX "run_events_run_id_occurred_at_idx" ON "run_events"("run_id", "occurred_at");

-- CreateIndex
CREATE INDEX "run_events_type_idx" ON "run_events"("type");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_run_id_sequence_key" ON "run_events"("run_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "run_drafts_run_id_key" ON "run_drafts"("run_id");

-- CreateIndex
CREATE INDEX "run_approvals_run_id_status_idx" ON "run_approvals"("run_id", "status");

-- CreateIndex
CREATE INDEX "run_approvals_decided_by_id_idx" ON "run_approvals"("decided_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_approvals_run_id_key_key" ON "run_approvals"("run_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "blobs_sha256_key" ON "blobs"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "blobs_storage_key_key" ON "blobs"("storage_key");

-- CreateIndex
CREATE INDEX "blobs_status_idx" ON "blobs"("status");

-- CreateIndex
CREATE INDEX "file_assets_project_id_status_created_at_idx" ON "file_assets"("project_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "file_assets_blob_id_idx" ON "file_assets"("blob_id");

-- CreateIndex
CREATE INDEX "file_assets_uploaded_by_id_idx" ON "file_assets"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "artifacts_project_id_kind_updated_at_idx" ON "artifacts"("project_id", "kind", "updated_at");

-- CreateIndex
CREATE INDEX "artifacts_current_version_id_idx" ON "artifacts"("current_version_id");

-- CreateIndex
CREATE INDEX "artifact_versions_content_blob_id_idx" ON "artifact_versions"("content_blob_id");

-- CreateIndex
CREATE INDEX "artifact_versions_created_by_run_id_idx" ON "artifact_versions"("created_by_run_id");

-- CreateIndex
CREATE INDEX "artifact_versions_knowledge_release_id_idx" ON "artifact_versions"("knowledge_release_id");

-- CreateIndex
CREATE INDEX "artifact_versions_status_idx" ON "artifact_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_versions_artifact_id_version_key" ON "artifact_versions"("artifact_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "boards_project_id_key" ON "boards"("project_id");

-- CreateIndex
CREATE INDEX "board_nodes_artifact_id_idx" ON "board_nodes"("artifact_id");

-- CreateIndex
CREATE INDEX "board_nodes_artifact_version_id_idx" ON "board_nodes"("artifact_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_nodes_board_id_node_key_key" ON "board_nodes"("board_id", "node_key");

-- CreateIndex
CREATE INDEX "board_edges_board_id_source_node_key_idx" ON "board_edges"("board_id", "source_node_key");

-- CreateIndex
CREATE INDEX "board_edges_board_id_target_node_key_idx" ON "board_edges"("board_id", "target_node_key");

-- CreateIndex
CREATE UNIQUE INDEX "board_edges_board_id_edge_key_key" ON "board_edges"("board_id", "edge_key");

-- CreateIndex
CREATE UNIQUE INDEX "share_grants_token_hash_key" ON "share_grants"("token_hash");

-- CreateIndex
CREATE INDEX "share_grants_project_id_status_idx" ON "share_grants"("project_id", "status");

-- CreateIndex
CREATE INDEX "share_grants_created_by_id_idx" ON "share_grants"("created_by_id");

-- CreateIndex
CREATE INDEX "share_grants_expires_at_idx" ON "share_grants"("expires_at");

-- CreateIndex
CREATE INDEX "export_jobs_project_id_created_at_idx" ON "export_jobs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "export_jobs_artifact_version_id_idx" ON "export_jobs"("artifact_version_id");

-- CreateIndex
CREATE INDEX "export_jobs_output_blob_id_idx" ON "export_jobs"("output_blob_id");

-- CreateIndex
CREATE INDEX "export_jobs_status_idx" ON "export_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_releases_key_key" ON "knowledge_releases"("key");

-- CreateIndex
CREATE INDEX "knowledge_releases_workspace_id_status_version_idx" ON "knowledge_releases"("workspace_id", "status", "version");

-- CreateIndex
CREATE INDEX "knowledge_documents_release_id_route_idx" ON "knowledge_documents"("release_id", "route");

-- CreateIndex
CREATE INDEX "knowledge_documents_source_blob_id_idx" ON "knowledge_documents"("source_blob_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_release_id_source_path_key" ON "knowledge_documents"("release_id", "source_path");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_document_id_sequence_key" ON "knowledge_chunks"("document_id", "sequence");

CREATE INDEX "knowledge_chunks_search_vector_idx"
ON "knowledge_chunks" USING GIN ("search_vector");

CREATE INDEX "knowledge_chunks_embedding_hnsw_idx"
ON "knowledge_chunks" USING hnsw ("embedding" public.vector_cosine_ops)
WHERE "embedding" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_entries" ADD CONSTRAINT "thread_entries_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_entries" ADD CONSTRAINT "thread_entries_produced_by_run_id_fkey" FOREIGN KEY ("produced_by_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_knowledge_release_id_fkey" FOREIGN KEY ("knowledge_release_id") REFERENCES "knowledge_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_output_entry_id_fkey" FOREIGN KEY ("output_entry_id") REFERENCES "thread_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_drafts" ADD CONSTRAINT "run_drafts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_blob_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "blobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "artifact_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_content_blob_id_fkey" FOREIGN KEY ("content_blob_id") REFERENCES "blobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_knowledge_release_id_fkey" FOREIGN KEY ("knowledge_release_id") REFERENCES "knowledge_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boards" ADD CONSTRAINT "boards_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_nodes" ADD CONSTRAINT "board_nodes_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_nodes" ADD CONSTRAINT "board_nodes_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_nodes" ADD CONSTRAINT "board_nodes_artifact_version_id_fkey" FOREIGN KEY ("artifact_version_id") REFERENCES "artifact_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_edges" ADD CONSTRAINT "board_edges_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_artifact_version_id_fkey" FOREIGN KEY ("artifact_version_id") REFERENCES "artifact_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_output_blob_id_fkey" FOREIGN KEY ("output_blob_id") REFERENCES "blobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_releases" ADD CONSTRAINT "knowledge_releases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "knowledge_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_blob_id_fkey" FOREIGN KEY ("source_blob_id") REFERENCES "blobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
