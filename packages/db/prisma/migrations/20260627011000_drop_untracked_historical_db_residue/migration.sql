-- Remove historical database residue that is not represented in the current Prisma schema.
-- These objects came from earlier experiments and are not read or written by the DeerFlow-first runtime.

DROP TABLE IF EXISTS "knowledge_embeddings";

ALTER TABLE "prototype_artifacts"
  DROP COLUMN IF EXISTS "open_pencil_document";

ALTER TABLE "conversations"
  DROP COLUMN IF EXISTS "pinned_at";
