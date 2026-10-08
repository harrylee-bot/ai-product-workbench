#!/bin/sh
set -eu

# Render a gateway variant without copying or changing the standard S3 topology.
# --render-only is also useful when mounting a generated config into a recovery
# deployment. No credentials are read or written by this script.
bucket=${WORKBENCH_S3_BUCKET:?WORKBENCH_S3_BUCKET is required}
base=${WORKBENCH_LOCAL_STORAGE_BASE_NGINX_CONFIG:-/etc/nginx/nginx.conf}
template=${WORKBENCH_LOCAL_STORAGE_NGINX_TEMPLATE:-/etc/workbench/workbench-local-storage-nginx.conf.template}
output=${WORKBENCH_LOCAL_STORAGE_NGINX_OUTPUT:-/tmp/workbench-local-storage/nginx.conf}

if ! printf '%s\n' "$bucket" | LC_ALL=C grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'; then
  printf '%s\n' 'WORKBENCH_S3_BUCKET must be a safe 3-63 character S3 bucket name' >&2
  exit 64
fi
case "$bucket" in
  *..*|*.-*|*-.*)
    printf '%s\n' 'WORKBENCH_S3_BUCKET has an invalid DNS label' >&2
    exit 64
    ;;
esac
if [ "$base" = "$output" ] || [ "$template" = "$output" ]; then
  printf '%s\n' 'the rendered configuration must have a separate output path' >&2
  exit 64
fi
case "${1:-}" in
  ""|--render-only) ;;
  *) printf '%s\n' 'usage: workbench-local-storage-nginx.sh [--render-only]' >&2; exit 64 ;;
esac

[ -f "$base" ] && [ -f "$template" ] || {
  printf '%s\n' 'the base gateway config and storage route template must be files' >&2
  exit 66
}
listeners=$(awk '/^[ \t]*listen[ \t]+8080[ \t]*;[ \t]*$/ { n++ } END { print n+0 }' "$base")
if [ "$listeners" -ne 1 ]; then
  printf '%s\n' 'expected exactly one plain gateway listen 8080 directive' >&2
  exit 65
fi
if grep -Fq '/staging/files/' "$base"; then
  printf '%s\n' 'the base gateway config already contains a storage upload route' >&2
  exit 65
fi

mkdir -p "$(dirname "$output")"
route=$(mktemp "${output}.route.XXXXXX")
rendered=$(mktemp "${output}.config.XXXXXX")
trap 'rm -f "$route" "$rendered"' EXIT HUP INT TERM
export WORKBENCH_S3_BUCKET
envsubst '${WORKBENCH_S3_BUCKET}' < "$template" > "$route"
awk -v route="$route" '
  { print }
  /^[ \t]*listen[ \t]+8080[ \t]*;[ \t]*$/ {
    while ((getline line < route) > 0) print line
    close(route)
  }
' "$base" > "$rendered"
mv "$rendered" "$output"
rm -f "$route"
trap - EXIT HUP INT TERM

if [ "${1:-}" = --render-only ]; then
  exit 0
fi
nginx -t -c "$output"
exec nginx -c "$output" -g 'daemon off;'
