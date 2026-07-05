#!/usr/bin/env bash
set -euo pipefail

if [ -n "${DATABASE_URL:-}" ]; then
  npx prisma migrate deploy --schema /app/packages/db/prisma/schema.prisma
  npm run db:seed --prefix /app
  node /app/scripts/assert-no-legacy-schema.mjs
fi

exec node /app/apps/api/dist/main.js
