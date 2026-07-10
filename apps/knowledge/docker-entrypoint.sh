#!/usr/bin/env bash
set -euo pipefail

CONTENT_DIR="${QUARTZ_CONTENT_DIR:-/vault}"
OUTPUT_DIR="${QUARTZ_OUTPUT_DIR:-/usr/share/nginx/html}"
BUILD_CONTENT_DIR="${QUARTZ_BUILD_CONTENT_DIR:-/tmp/quartz-content}"
CONFIG_PATH="/opt/quartz/quartz.config.yaml"

mkdir -p "$CONTENT_DIR" "$OUTPUT_DIR"

if ! find "$CONTENT_DIR" -mindepth 1 -maxdepth 1 | grep -q .; then
  cp -a /seed-vault/. "$CONTENT_DIR"/
fi

rm -rf "$BUILD_CONTENT_DIR" "$OUTPUT_DIR"/*
mkdir -p "$BUILD_CONTENT_DIR" "$OUTPUT_DIR"
cp -a "$CONTENT_DIR"/. "$BUILD_CONTENT_DIR"/

if [ ! -f "$BUILD_CONTENT_DIR/index.md" ]; then
  if [ -f "$BUILD_CONTENT_DIR/README.md" ]; then
    cp "$BUILD_CONTENT_DIR/README.md" "$BUILD_CONTENT_DIR/index.md"
  else
    printf '# AI Product OS 知识库\n\n请在 Markdown Vault 中维护知识内容。\n' > "$BUILD_CONTENT_DIR/index.md"
  fi
fi

if [ -n "${QUARTZ_BASE_URL:-}" ]; then
  escaped_base_url="$(printf '%s\n' "$QUARTZ_BASE_URL" | sed 's/[\/&]/\\&/g')"
  sed -i "s#^  baseUrl:.*#  baseUrl: ${escaped_base_url}#" "$CONFIG_PATH"
fi

if [ -n "${KNOWLEDGE_WEB_URL:-}" ]; then
  knowledge_web_url="${KNOWLEDGE_WEB_URL%/}"
  escaped_web_url="$(printf '%s\n' "$knowledge_web_url" | sed 's/[\/&]/\\&/g')"
  escaped_admin_url="$(printf '%s\n' "${knowledge_web_url}/admin/knowledge/vault" | sed 's/[\/&]/\\&/g')"
  sed -i "s#^        业务系统:.*#        业务系统: ${escaped_web_url}#" "$CONFIG_PATH"
  sed -i "s#^        知识维护:.*#        知识维护: ${escaped_admin_url}#" "$CONFIG_PATH"
fi

cd /opt/quartz
npx quartz build \
  --directory "$BUILD_CONTENT_DIR" \
  --output "$OUTPUT_DIR" \
  --concurrency "${QUARTZ_CONCURRENCY:-2}"

node /usr/local/lib/knowledge-finalize-output.mjs "$OUTPUT_DIR" "${QUARTZ_BASE_URL:-}"

printf 'ok\n' > "$OUTPUT_DIR/__health"

exec nginx -g "daemon off;"
