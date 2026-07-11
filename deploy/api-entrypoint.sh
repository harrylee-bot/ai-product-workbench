#!/usr/bin/env bash
set -euo pipefail

sync_bundled_knowledge_vault() {
  local source_root="/app/knowledge-vault"
  local target_root="${KNOWLEDGE_VAULT_ROOT:-}"
  local staging_root
  local previous_root

  if [ -z "$target_root" ] || [ ! -d "$source_root" ] || [ "$source_root" = "$target_root" ]; then
    return 0
  fi
  if [ -L "$target_root" ] || { [ -e "$target_root" ] && [ ! -d "$target_root" ]; }; then
    echo "Knowledge vault target must be a real directory: $target_root" >&2
    return 1
  fi

  mkdir -p "$(dirname "$target_root")"
  staging_root="${target_root}.next.$$"
  previous_root="${target_root}.previous"
  rm -rf "$staging_root"
  if [ ! -e "$target_root" ] && [ -d "$previous_root" ] && [ ! -L "$previous_root" ]; then
    mv "$previous_root" "$target_root"
  elif [ -e "$previous_root" ]; then
    rm -rf "$previous_root"
  fi
  mkdir -p "$staging_root"
  if [ -d "$target_root" ]; then
    cp -a "$target_root/." "$staging_root/"
  fi
  cp -a "$source_root/." "$staging_root/"
  if [ -e "$target_root" ]; then
    mv "$target_root" "$previous_root"
  fi
  if ! mv "$staging_root" "$target_root"; then
    if [ -e "$previous_root" ] && [ ! -e "$target_root" ]; then
      mv "$previous_root" "$target_root"
    fi
    return 1
  fi
  rm -rf "$previous_root"
  echo "Bundled knowledge vault atomically synchronized to ${target_root}"
}

sync_bundled_knowledge_vault

if [ -n "${DATABASE_URL:-}" ]; then
  npx prisma migrate deploy --schema /app/packages/db/prisma/schema.prisma
  npm run db:seed --prefix /app
  node /app/scripts/assert-no-legacy-schema.mjs
fi

exec node /app/apps/api/dist/main.js
