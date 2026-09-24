BEGIN;

-- Commit the enum additions before the next migration references the values.
ALTER TYPE "ExportFormat" ADD VALUE IF NOT EXISTS 'docx';
ALTER TYPE "ExportFormat" ADD VALUE IF NOT EXISTS 'pdf';

COMMIT;
