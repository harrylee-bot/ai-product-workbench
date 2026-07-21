#!/usr/bin/env sh
set -eu

if [ -z "${WORKBENCH_DATABASE_URL:-}" ]; then
  echo "WORKBENCH_DATABASE_URL (migrator URL) is required" >&2
  exit 1
fi

# Bootstrap roles before Prisma creates any application objects. The script is
# intentionally driven by the infrastructure-admin URL; application services
# never receive that credential. Local contract/test runs may omit the split
# URLs and use the single WORKBENCH_DATABASE_URL fallback.
if [ -n "${WORKBENCH_POSTGRES_ADMIN_URL:-}" ] \
  && [ -n "${WORKBENCH_POSTGRES_MIGRATOR_USER:-}" ] \
  && [ -n "${WORKBENCH_POSTGRES_MIGRATOR_PASSWORD:-}" ] \
  && [ -n "${WORKBENCH_POSTGRES_RUNTIME_USER:-}" ] \
  && [ -n "${WORKBENCH_POSTGRES_RUNTIME_PASSWORD:-}" ]; then
  node scripts/provision-workbench-database-roles.mjs --phase=bootstrap
fi

node scripts/assert-workbench-postgres-extensions.mjs --check
npm --workspace @workbench/workbench-db run migrate:deploy
if [ -n "${WORKBENCH_POSTGRES_ADMIN_URL:-}" ] \
  && [ -n "${WORKBENCH_POSTGRES_MIGRATOR_USER:-}" ] \
  && [ -n "${WORKBENCH_POSTGRES_MIGRATOR_PASSWORD:-}" ] \
  && [ -n "${WORKBENCH_POSTGRES_RUNTIME_USER:-}" ] \
  && [ -n "${WORKBENCH_POSTGRES_RUNTIME_PASSWORD:-}" ]; then
  node scripts/provision-workbench-database-roles.mjs --phase=grant
fi
exec node scripts/reconcile-workbench-runtime-queues.mjs
