#!/usr/bin/env bash
set -euo pipefail

if [ -n "${DATABASE_URL:-}" ]; then
  npx prisma migrate deploy --schema /app/packages/database/prisma/schema.prisma
  npx prisma db seed --schema /app/packages/database/prisma/schema.prisma
fi

exec node /app/apps/api/dist/main.js
