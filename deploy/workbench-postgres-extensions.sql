\set ON_ERROR_STOP on

-- Run this file as the database infrastructure administrator. Application
-- migration and runtime roles must not receive CREATE EXTENSION.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

SELECT extension.extname, extension.extversion, namespace.nspname AS schema_name
FROM pg_extension AS extension
JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
WHERE extension.extname IN ('vector', 'pg_trgm', 'pgcrypto')
ORDER BY extension.extname;
