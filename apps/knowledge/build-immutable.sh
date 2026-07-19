#!/usr/bin/env sh
set -eu

CONTENT_ROOT=/tmp/quartz-content
OUTPUT_ROOT=/tmp/quartz-public
FINALIZER=/usr/local/lib/knowledge-finalize-output.mjs

rm -rf "$CONTENT_ROOT" "$OUTPUT_ROOT"
node /usr/local/lib/knowledge-configure-immutable.mjs /opt/quartz/quartz.config.yaml
node "$FINALIZER" prepare /seed-vault "$CONTENT_ROOT"

if [ ! -f "$CONTENT_ROOT/index.md" ]; then
  cp "$CONTENT_ROOT/README.md" "$CONTENT_ROOT/index.md"
fi

node "$FINALIZER" run /opt/quartz \
  npx quartz build \
  --directory "$CONTENT_ROOT" \
  --output "$OUTPUT_ROOT" \
  --concurrency "${QUARTZ_CONCURRENCY:-2}"
node "$FINALIZER" "$OUTPUT_ROOT" "${QUARTZ_BASE_URL:?QUARTZ_BASE_URL is required}"
printf 'ok\n' > "$OUTPUT_ROOT/__health"
chmod -R a=rX,u+w "$OUTPUT_ROOT"
