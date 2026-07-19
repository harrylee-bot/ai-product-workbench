#!/usr/bin/env sh
set -eu

if [ -z "${WORKBENCH_DATABASE_URL:-}" ]; then
  echo "WORKBENCH_DATABASE_URL is required" >&2
  exit 1
fi

node scripts/assert-workbench-postgres-extensions.mjs --check
npm --workspace @workbench/workbench-db run migrate:deploy
exec node scripts/reconcile-workbench-runtime-queues.mjs
