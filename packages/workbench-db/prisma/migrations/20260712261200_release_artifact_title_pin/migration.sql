-- Artifact titles are mutable presentation state. A Release must capture the
-- title used by previews and remixes instead of reading the live Artifact row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "release_artifact_versions") THEN
    RAISE EXCEPTION 'MIGRATION_RELEASE_ARTIFACT_TITLES_NOT_BACKFILLABLE' USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "release_artifact_versions"
ADD COLUMN "title" TEXT NOT NULL,
ADD COLUMN "kind" "ArtifactKind" NOT NULL,
ADD CONSTRAINT "release_artifact_versions_title_check"
CHECK (length("title") BETWEEN 1 AND 240);

CREATE FUNCTION "guard_release_artifact_snapshot_fields"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_title TEXT;
  current_kind "ArtifactKind";
BEGIN
  SELECT artifact."title", artifact."kind"
  INTO current_title, current_kind
  FROM "artifacts" AS artifact
  WHERE artifact."id" = NEW."artifact_id"
    AND artifact."project_id" = NEW."project_id"
  FOR SHARE;

  IF current_title IS DISTINCT FROM NEW."title"
    OR current_kind IS DISTINCT FROM NEW."kind"
  THEN
    RAISE EXCEPTION 'RELEASE_ARTIFACT_SNAPSHOT_FIELDS_STALE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "release_artifact_versions_snapshot_guard"
BEFORE INSERT ON "release_artifact_versions"
FOR EACH ROW EXECUTE FUNCTION "guard_release_artifact_snapshot_fields"();
