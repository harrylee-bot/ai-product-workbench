ALTER TYPE "PrototypeExportStatus" ADD VALUE 'cancelling';

-- Cancellation acceptance fences publication immediately; only executor
-- cleanup acknowledges completion and sets finished_at.
ALTER TABLE prototype_exports ADD CONSTRAINT prototype_exports_cancelling_check
CHECK (status::text <> 'cancelling' OR (
  finished_at IS NULL AND artifact_key IS NULL AND artifact_sha256 IS NULL
  AND byte_size IS NULL AND media_type IS NULL
));
