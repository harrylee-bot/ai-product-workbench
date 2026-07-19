#!/bin/sh
set -eu

APP_DIR=${WORKBENCH_APP_DIR:-/opt/workbench}
ENV_FILE=${WORKBENCH_ENV_FILE:-$APP_DIR/deploy/workbench.env}
COMPOSE_FILE=${WORKBENCH_COMPOSE_FILE:-$APP_DIR/deploy/workbench-compose.yml}
CADDY_FILE=${WORKBENCH_CADDY_FILE:-$APP_DIR/deploy/workbench-production.Caddyfile}
ORIGIN_MANIFEST_SCRIPT=${WORKBENCH_ORIGIN_MANIFEST_SCRIPT:-$APP_DIR/scripts/workbench-origin-manifest.mjs}

fail() {
  printf '%s\n' "workbench production preflight: $*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || fail "missing $COMPOSE_FILE"
[ -f "$CADDY_FILE" ] || fail "missing $CADDY_FILE"
[ -f "$ORIGIN_MANIFEST_SCRIPT" ] || fail "missing $ORIGIN_MANIFEST_SCRIPT"
[ -r "$APP_DIR/knowledge-vault/README.md" ] || fail "knowledge-vault is missing"

env_value() {
  key=$1
  count=$(grep -c "^${key}=" "$ENV_FILE" || true)
  [ "$count" -eq 1 ] || fail "$key must occur exactly once in $ENV_FILE"
  sed -n "s/^${key}=//p" "$ENV_FILE"
}

require_env() {
  value=$(env_value "$1")
  [ -n "$value" ] || fail "$1 is empty"
  case "$value" in
    *REPLACE_WITH_*) fail "$1 still contains a placeholder" ;;
  esac
  printf '%s' "$value"
}

require_env WORKBENCH_WEB_ORIGIN >/dev/null
require_env WORKBENCH_PREVIEW_ORIGIN >/dev/null
require_env WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL >/dev/null
require_env WORKBENCH_OIDC_PROVIDER_ISSUER >/dev/null
require_env WORKBENCH_IDENTITY_HOSTNAME >/dev/null
canvas_tool_url=$(require_env WORKBENCH_CANVAS_TOOL_URL)
canvas_visual_url=$(require_env WORKBENCH_CANVAS_VISUAL_URL)
database_url=$(require_env WORKBENCH_DATABASE_URL)
public_registration=$(require_env WORKBENCH_PUBLIC_REGISTRATION_ENABLED)
auth_ip_header=$(require_env WORKBENCH_AUTH_CLIENT_IP_HEADER)
cdn_edge_cidrs=$(require_env WORKBENCH_CDN_EDGE_CIDRS)
cdn_edge_cidrs_source=$(require_env WORKBENCH_CDN_EDGE_CIDRS_SOURCE)
cdn_origin_auth_secret=$(require_env WORKBENCH_CDN_ORIGIN_AUTH_SECRET)
tokenizer_dir=$(require_env WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR)
image_inventory=$(require_env WORKBENCH_IMAGE_INVENTORY_PATH)
source_commit=$(require_env WORKBENCH_SOURCE_COMMIT)
scan_mode=$(require_env WORKBENCH_FILE_SCAN_MODE)
postgres_image=$(require_env WORKBENCH_POSTGRES_IMAGE)
nginx_image=$(require_env WORKBENCH_NGINX_IMAGE)
compose_profiles=${WORKBENCH_COMPOSE_PROFILES:-${COMPOSE_PROFILES:-}}

case "$canvas_tool_url" in
  https://*/api/v1/runtime/canvas/tools/execute) ;;
  *) fail "WORKBENCH_CANVAS_TOOL_URL must be the public HTTPS Canvas execution endpoint" ;;
esac
canvas_origin=${canvas_tool_url%/api/v1/runtime/canvas/tools/execute}
[ "$canvas_visual_url" = "$canvas_origin/api/v1/runtime/canvas/visuals" ] \
  || fail "WORKBENCH_CANVAS_VISUAL_URL must share the Canvas tool origin and use the visual capability base path"

case "$compose_profiles" in
  "") ;;
  *) fail "production preflight must not enable local Compose profiles: $compose_profiles" ;;
esac
case "$public_registration" in
  true | false) ;;
  *) fail "WORKBENCH_PUBLIC_REGISTRATION_ENABLED must be true or false" ;;
esac
[ "$auth_ip_header" = "x-workbench-client-ip" ] || fail "WORKBENCH_AUTH_CLIENT_IP_HEADER must be x-workbench-client-ip"
[ "$scan_mode" = "clamav" ] || fail "production uploads require WORKBENCH_FILE_SCAN_MODE=clamav"
printf '%s' "$database_url" | grep -Eq '@postgres([:/?]|$)' || fail "WORKBENCH_DATABASE_URL must address the Compose postgres service"
printf '%s' "$source_commit" | grep -Eq '^[0-9a-f]{40}$' || fail "WORKBENCH_SOURCE_COMMIT must be a lowercase Git commit"
printf '%s' "$postgres_image" | grep -Eq '@sha256:[a-f0-9]{64}$' || fail "WORKBENCH_POSTGRES_IMAGE must be an immutable digest reference"
printf '%s' "$nginx_image" | grep -Eq '@sha256:[a-f0-9]{64}$' || fail "WORKBENCH_NGINX_IMAGE must be an immutable digest reference"
case " $cdn_edge_cidrs " in
  *" 0.0.0.0/0 "* | *" ::/0 "*) fail "WORKBENCH_CDN_EDGE_CIDRS must not trust the public Internet" ;;
esac
for cidr in $cdn_edge_cidrs; do
  printf '%s' "$cidr" | grep -Eq '^[0-9A-Fa-f:.]+/[0-9]{1,3}$' || fail "WORKBENCH_CDN_EDGE_CIDRS contains an invalid CIDR token"
done
case "$cdn_edge_cidrs_source" in https://*) ;; *) fail "WORKBENCH_CDN_EDGE_CIDRS_SOURCE must be an HTTPS reference" ;; esac
case "$cdn_origin_auth_secret" in
  *[!A-Za-z0-9_-]*) fail "WORKBENCH_CDN_ORIGIN_AUTH_SECRET must be base64url" ;;
esac
[ "${#cdn_origin_auth_secret}" -ge 43 ] || fail "WORKBENCH_CDN_ORIGIN_AUTH_SECRET must contain at least 32 random bytes"

origin_env=$(mktemp)
trap 'rm -f "$origin_env"' EXIT HUP INT TERM
node "$ORIGIN_MANIFEST_SCRIPT" --env-file "$ENV_FILE" --format caddy-env >"$origin_env" \
  || fail "public origin manifest is invalid"
. "$origin_env"
[ "$WORKBENCH_WEB_HOSTNAME" != "$WORKBENCH_PREVIEW_HOSTNAME" ] || fail "Preview must use a distinct hostname"

[ -f "$image_inventory" ] || fail "missing signed production image manifest: $image_inventory"
node "$APP_DIR/scripts/production-image-inventory.mjs" \
  --manifest "$image_inventory" \
  --expected-commit "$source_commit" \
  --env-file "$ENV_FILE"

[ -r "$tokenizer_dir/tokenizer.json" ] || fail "tokenizer.json is missing"
[ -r "$tokenizer_dir/tokenizer_config.json" ] || fail "tokenizer_config.json is missing"

command -v caddy >/dev/null 2>&1 || fail "caddy is missing"
WORKBENCH_CDN_EDGE_CIDRS="$cdn_edge_cidrs" \
WORKBENCH_CDN_ORIGIN_AUTH_SECRET="$cdn_origin_auth_secret" \
WORKBENCH_WEB_HOSTNAME="$WORKBENCH_WEB_HOSTNAME" \
WORKBENCH_PREVIEW_HOSTNAME="$WORKBENCH_PREVIEW_HOSTNAME" \
WORKBENCH_S3_HOSTNAME="$WORKBENCH_S3_HOSTNAME" \
WORKBENCH_IDENTITY_HOSTNAME="$WORKBENCH_IDENTITY_HOSTNAME" \
  caddy validate --adapter caddyfile --config "$CADDY_FILE" >/dev/null

docker compose \
  --project-directory "$APP_DIR/deploy" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  config --quiet

printf '%s\n' "workbench production preflight: ok"
