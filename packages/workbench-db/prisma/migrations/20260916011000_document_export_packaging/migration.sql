BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The new check admits every existing format/packaging combination unchanged.
-- Replacing it atomically leaves all row guards enabled.
ALTER TABLE "export_jobs"
DROP CONSTRAINT "export_jobs_format_packaging_check",
ADD CONSTRAINT "export_jobs_format_packaging_check"
CHECK (
  ("format" = 'html' AND "packaging" IN ('single_file', 'zip'))
  OR ("format" IN ('docx', 'pdf') AND "packaging" = 'single_file')
  OR ("format" IN ('react', 'figma', 'mcp') AND "packaging" = 'zip')
);

COMMIT;
