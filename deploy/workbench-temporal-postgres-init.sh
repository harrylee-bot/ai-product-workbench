#!/bin/sh
set -eu
# Runs only when the dedicated PostgreSQL volume is empty. The Temporal owner
# cannot administer the cluster, create other databases, or read Workbench data.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv temporal_password WORKBENCH_TEMPORAL_DATABASE_PASSWORD
SELECT format('CREATE ROLE temporal_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'temporal_password') \gexec
CREATE DATABASE temporal OWNER temporal_owner;
CREATE DATABASE temporal_visibility OWNER temporal_owner;
REVOKE ALL ON DATABASE temporal FROM PUBLIC;
REVOKE ALL ON DATABASE temporal_visibility FROM PUBLIC;
SQL
