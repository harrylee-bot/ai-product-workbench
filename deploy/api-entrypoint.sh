#!/usr/bin/env bash
set -euo pipefail

sync_bundled_knowledge_vault() {
  local source_root="/app/knowledge-vault"
  local target_root="${KNOWLEDGE_VAULT_ROOT:-}"

  if [ -z "$target_root" ] || [ ! -d "$source_root" ] || [ "$source_root" = "$target_root" ]; then
    return 0
  fi

  mkdir -p "$target_root"
  cp -a "$source_root/." "$target_root/"
  echo "Bundled knowledge vault synchronized to ${target_root}"
}

sync_bundled_knowledge_vault

if [ -n "${DATABASE_URL:-}" ]; then
  npx prisma migrate deploy --schema /app/packages/db/prisma/schema.prisma
  npm run db:seed --prefix /app
  node /app/scripts/assert-no-legacy-schema.mjs
fi

exec node /app/apps/api/dist/main.js
