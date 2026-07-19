CREATE TYPE "ArtifactVersionReaction" AS ENUM ('like', 'dislike');

CREATE TABLE "artifact_version_preferences" (
  "principal_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "artifact_version_id" TEXT NOT NULL,
  "screen_id" TEXT NOT NULL DEFAULT '',
  "favorite" BOOLEAN NOT NULL DEFAULT false,
  "reaction" "ArtifactVersionReaction",
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "artifact_version_preferences_pkey"
    PRIMARY KEY ("principal_id", "artifact_version_id", "screen_id"),
  CONSTRAINT "artifact_version_preferences_revision_positive_check"
    CHECK ("revision" > 0),
  CONSTRAINT "artifact_version_preferences_screen_id_length_check"
    CHECK (char_length("screen_id") <= 128)
);

CREATE INDEX "artifact_version_preferences_version_scope_idx"
  ON "artifact_version_preferences"("artifact_version_id", "artifact_id", "project_id");

CREATE INDEX "artifact_version_preferences_favorites_idx"
  ON "artifact_version_preferences"("principal_id", "favorite", "updated_at");

ALTER TABLE "artifact_version_preferences"
  ADD CONSTRAINT "artifact_version_preferences_principal_fkey"
  FOREIGN KEY ("principal_id") REFERENCES "principals"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "artifact_version_preferences_version_fkey"
  FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id")
  REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
