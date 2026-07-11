-- Version allocation uses max(version) + 1 inside the owning transaction.
-- These guards turn any accidental concurrent duplicate into a retryable
-- conflict instead of silently corrupting rollback history.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "conversation_design_versions"
    GROUP BY "state_id", "version" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate conversation design versions must be reconciled before migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "requirement_document_versions"
    GROUP BY "document_id", "version" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate requirement document versions must be reconciled before migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "prototype_versions"
    GROUP BY "artifact_id", "version" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate prototype versions must be reconciled before migration';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_design_versions_state_id_version_key"
  ON "conversation_design_versions"("state_id", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "requirement_document_versions_document_id_version_key"
  ON "requirement_document_versions"("document_id", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "prototype_versions_artifact_id_version_key"
  ON "prototype_versions"("artifact_id", "version");

COMMIT;
