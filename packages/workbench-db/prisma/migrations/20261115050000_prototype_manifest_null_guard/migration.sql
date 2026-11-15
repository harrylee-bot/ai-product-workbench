BEGIN;
SET LOCAL lock_timeout = '5s';
-- SQL CHECK accepts UNKNOWN; require media type explicitly before equality.
ALTER TABLE prototype_revisions DROP CONSTRAINT prototype_frozen_manifest_complete,
 ADD CONSTRAINT prototype_frozen_manifest_complete CHECK (
   (built_artifact_key IS NULL AND built_artifact_sha256 IS NULL AND built_artifact_byte_size IS NULL AND built_artifact_media_type IS NULL)
   OR (built_artifact_key IS NOT NULL AND length(built_artifact_key) > 0
       AND built_artifact_sha256 IS NOT NULL AND built_artifact_sha256 ~ '^[a-f0-9]{64}$'
       AND built_artifact_byte_size IS NOT NULL AND built_artifact_byte_size > 0
       AND built_artifact_media_type IS NOT NULL AND built_artifact_media_type = 'text/html; charset=utf-8')
 );
COMMIT;
