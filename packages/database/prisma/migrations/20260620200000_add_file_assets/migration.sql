-- CreateEnum
CREATE TYPE "FileStorageProvider" AS ENUM ('local', 's3', 'oss');

-- CreateEnum
CREATE TYPE "FileAssetStatus" AS ENUM ('uploaded', 'parsing', 'parsed', 'parse_failed', 'unsupported', 'deleted');

-- CreateEnum
CREATE TYPE "ParseResultStatus" AS ENUM ('success', 'partial_success', 'failed');

-- CreateEnum
CREATE TYPE "FileParserType" AS ENUM ('plain_text', 'markdown', 'docx', 'pdf', 'image', 'zip', 'axure_html_zip', 'rp_reference', 'unsupported');

-- CreateEnum
CREATE TYPE "FileChunkSourceType" AS ENUM ('text', 'section', 'page', 'image_context', 'axure_page', 'pdf_page');

-- CreateTable
CREATE TABLE "file_assets" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "stored_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storage_provider" "FileStorageProvider" NOT NULL DEFAULT 'local',
    "storage_path" TEXT NOT NULL,
    "public_url" TEXT,
    "status" "FileAssetStatus" NOT NULL DEFAULT 'uploaded',
    "parse_result_id" TEXT,
    "parse_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "file_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_parse_results" (
    "id" TEXT NOT NULL,
    "file_asset_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "ParseResultStatus" NOT NULL,
    "parser_type" "FileParserType" NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "extracted_text" TEXT,
    "word_count" INTEGER,
    "sections" JSONB,
    "pages" JSONB,
    "images" JSONB,
    "visual_contexts" JSONB,
    "axure_info" JSONB,
    "error_message" TEXT,
    "warnings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_parse_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_chunks" (
    "id" TEXT NOT NULL,
    "file_asset_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "token_estimate" INTEGER,
    "source_type" "FileChunkSourceType" NOT NULL,
    "source_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_assets_project_id_idx" ON "file_assets"("project_id");

-- CreateIndex
CREATE INDEX "file_assets_conversation_id_idx" ON "file_assets"("conversation_id");

-- CreateIndex
CREATE INDEX "file_assets_message_id_idx" ON "file_assets"("message_id");

-- CreateIndex
CREATE INDEX "file_assets_uploaded_by_idx" ON "file_assets"("uploaded_by");

-- CreateIndex
CREATE INDEX "file_assets_status_idx" ON "file_assets"("status");

-- CreateIndex
CREATE INDEX "file_assets_created_at_idx" ON "file_assets"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "file_parse_results_file_asset_id_key" ON "file_parse_results"("file_asset_id");

-- CreateIndex
CREATE INDEX "file_parse_results_project_id_idx" ON "file_parse_results"("project_id");

-- CreateIndex
CREATE INDEX "file_parse_results_status_idx" ON "file_parse_results"("status");

-- CreateIndex
CREATE INDEX "file_parse_results_parser_type_idx" ON "file_parse_results"("parser_type");

-- CreateIndex
CREATE INDEX "file_chunks_file_asset_id_idx" ON "file_chunks"("file_asset_id");

-- CreateIndex
CREATE INDEX "file_chunks_project_id_idx" ON "file_chunks"("project_id");

-- CreateIndex
CREATE INDEX "file_chunks_chunk_index_idx" ON "file_chunks"("chunk_index");

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_parse_results" ADD CONSTRAINT "file_parse_results_file_asset_id_fkey" FOREIGN KEY ("file_asset_id") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_asset_id_fkey" FOREIGN KEY ("file_asset_id") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
