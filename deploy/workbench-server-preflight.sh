#!/bin/sh
set -eu

APP_DIR=${WORKBENCH_APP_DIR:-/opt/workbench}
ENV_FILE=${WORKBENCH_ENV_FILE:-$APP_DIR/deploy/workbench.env}
COMPOSE_FILE=${WORKBENCH_COMPOSE_FILE:-$APP_DIR/deploy/workbench-compose.yml}
OVERLAY_FILE=${WORKBENCH_OVERLAY_FILE:-$APP_DIR/deploy/workbench-server-validation-compose.yml}
DEX_CONFIG=${WORKBENCH_DEX_CONFIG:-$APP_DIR/deploy/workbench-dex-config.yaml}
CADDY_FILE=${WORKBENCH_CADDY_FILE:-$APP_DIR/deploy/workbench-server-validation.Caddyfile}
ORIGIN_MANIFEST_SCRIPT=${WORKBENCH_ORIGIN_MANIFEST_SCRIPT:-$APP_DIR/scripts/workbench-origin-manifest.mjs}

fail() {
  printf '%s\n' "workbench preflight: $*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || fail "missing $COMPOSE_FILE"
[ -f "$OVERLAY_FILE" ] || fail "missing $OVERLAY_FILE"
[ -f "$DEX_CONFIG" ] || fail "missing $DEX_CONFIG"
[ "$DEX_CONFIG" = "$APP_DIR/deploy/workbench-dex-config.yaml" ] \
  || fail "Dex check path must match the Compose bind mount"
[ -f "$CADDY_FILE" ] || fail "missing $CADDY_FILE"
[ -f "$ORIGIN_MANIFEST_SCRIPT" ] || fail "missing $ORIGIN_MANIFEST_SCRIPT"
[ -r "$APP_DIR/knowledge-vault/README.md" ] || fail "knowledge-vault is missing"

if grep -Fq 'REPLACE_WITH_' "$ENV_FILE" "$DEX_CONFIG"; then
  fail "placeholder values remain in deployment configuration"
fi

env_value() {
  key=$1
  count=$(grep -c "^${key}=" "$ENV_FILE" || true)
  [ "$count" -eq 1 ] || fail "$key must occur exactly once in $ENV_FILE"
  sed -n "s/^${key}=//p" "$ENV_FILE"
}

require_env() {
  value=$(env_value "$1")
  [ -n "$value" ] || fail "$1 is empty"
  printf '%s' "$value"
}

strip_yaml_scalar() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//'
}

web_origin=$(require_env WORKBENCH_WEB_ORIGIN)
preview_origin=$(require_env WORKBENCH_PREVIEW_ORIGIN)
oidc_issuer=$(require_env WORKBENCH_OIDC_PROVIDER_ISSUER)
oidc_client_id=$(require_env WORKBENCH_OIDC_CLIENT_ID)
oidc_client_secret=$(require_env WORKBENCH_OIDC_CLIENT_SECRET)
identity_hostname=$(require_env WORKBENCH_IDENTITY_HOSTNAME)
canvas_tool_url=$(require_env WORKBENCH_CANVAS_TOOL_URL)
canvas_visual_url=$(require_env WORKBENCH_CANVAS_VISUAL_URL)
tokenizer_dir=$(require_env WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR)
s3_internal=$(require_env WORKBENCH_S3_INTERNAL_ENDPOINT)
s3_browser=$(require_env WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL)
local_s3_port=$(require_env WORKBENCH_LOCAL_S3_PORT)
clamav_host=$(require_env WORKBENCH_CLAMAV_HOST)
file_clamav_stream_max_bytes=$(require_env WORKBENCH_CLAMAV_STREAM_MAX_BYTES)
import_clamav_stream_max_bytes=$(require_env WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES)
scan_mode=$(require_env WORKBENCH_FILE_SCAN_MODE)
import_url_max_bytes=$(require_env WORKBENCH_IMPORT_MAX_URL_BYTES)
import_github_max_bytes=$(require_env WORKBENCH_IMPORT_MAX_GITHUB_BYTES)
import_figma_max_bytes=$(require_env WORKBENCH_IMPORT_MAX_FIGMA_BYTES)
require_env WORKBENCH_IMPORT_S3_ACCESS_KEY_ID >/dev/null
require_env WORKBENCH_IMPORT_S3_SECRET_ACCESS_KEY >/dev/null
docling_url=$(require_env WORKBENCH_DOCLING_URL)
auth_client_ip_header=$(require_env WORKBENCH_AUTH_CLIENT_IP_HEADER)
public_registration_enabled=$(require_env WORKBENCH_PUBLIC_REGISTRATION_ENABLED)
cdn_edge_cidrs=$(require_env WORKBENCH_CDN_EDGE_CIDRS)
cdn_edge_cidrs_source=$(require_env WORKBENCH_CDN_EDGE_CIDRS_SOURCE)
cdn_origin_auth_secret=$(require_env WORKBENCH_CDN_ORIGIN_AUTH_SECRET)

case "$canvas_tool_url" in
  https://*/api/v1/runtime/canvas/tools/execute) ;;
  *) fail "WORKBENCH_CANVAS_TOOL_URL must be the public HTTPS Canvas execution endpoint" ;;
esac
canvas_origin=${canvas_tool_url%/api/v1/runtime/canvas/tools/execute}
[ "$canvas_visual_url" = "$canvas_origin/api/v1/runtime/canvas/visuals" ] \
  || fail "WORKBENCH_CANVAS_VISUAL_URL must share the Canvas tool origin and use the visual capability base path"

origin_env=$(mktemp)
trap 'rm -f "$origin_env"' EXIT HUP INT TERM
node "$ORIGIN_MANIFEST_SCRIPT" --env-file "$ENV_FILE" --format caddy-env >"$origin_env" \
  || fail "public origin manifest is invalid"
# The generator emits only canonical DNS hostnames with fixed variable names.
. "$origin_env"
web_hostname=$WORKBENCH_WEB_HOSTNAME
preview_hostname=$WORKBENCH_PREVIEW_HOSTNAME
s3_hostname=$WORKBENCH_S3_HOSTNAME
identity_hostname=$WORKBENCH_IDENTITY_HOSTNAME

[ "$s3_internal" = "http://object-storage:9000" ] || fail "validation S3 internal endpoint mismatch"
[ "$local_s3_port" = "9100" ] || fail "validation S3 port must be 9100"
[ "$clamav_host" = "clamav" ] || fail "validation ClamAV host must be clamav"
[ "$scan_mode" = "clamav" ] || fail "server validation requires WORKBENCH_FILE_SCAN_MODE=clamav"
for value in "$file_clamav_stream_max_bytes" "$import_clamav_stream_max_bytes" "$import_url_max_bytes" "$import_github_max_bytes" "$import_figma_max_bytes"; do
  printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$' \
    || fail "ClamAV and Import Source byte limits must be positive integers"
done
[ "$file_clamav_stream_max_bytes" -eq 26214400 ] \
  || fail "validation File Worker ClamAV stream limit must be 26214400"
[ "$import_clamav_stream_max_bytes" -eq 52428800 ] \
  || fail "validation Import Worker ClamAV stream limit must be 52428800"
[ "$import_url_max_bytes" -le "$import_clamav_stream_max_bytes" ] \
  || fail "WORKBENCH_IMPORT_MAX_URL_BYTES exceeds the Import Worker ClamAV stream limit"
[ "$import_github_max_bytes" -le "$import_clamav_stream_max_bytes" ] \
  || fail "WORKBENCH_IMPORT_MAX_GITHUB_BYTES exceeds the Import Worker ClamAV stream limit"
[ "$import_figma_max_bytes" -le "$import_clamav_stream_max_bytes" ] \
  || fail "WORKBENCH_IMPORT_MAX_FIGMA_BYTES exceeds the Import Worker ClamAV stream limit"
[ "$docling_url" = "http://docling:5001" ] || fail "validation Docling URL mismatch"
[ "$auth_client_ip_header" = "x-workbench-client-ip" ] \
  || fail "WORKBENCH_AUTH_CLIENT_IP_HEADER must be x-workbench-client-ip"
case "$public_registration_enabled" in
  true | false) ;;
  *) fail "WORKBENCH_PUBLIC_REGISTRATION_ENABLED must be true or false" ;;
esac
case " $cdn_edge_cidrs " in
  *" 0.0.0.0/0 "* | *" ::/0 "*) fail "WORKBENCH_CDN_EDGE_CIDRS must not trust the public Internet" ;;
esac
for cidr in $cdn_edge_cidrs; do
  printf '%s' "$cidr" | grep -Eq '^[0-9A-Fa-f:.]+/[0-9]{1,3}$' \
    || fail "WORKBENCH_CDN_EDGE_CIDRS contains an invalid CIDR token"
done
case "$cdn_edge_cidrs_source" in
  https://*) ;;
  *) fail "WORKBENCH_CDN_EDGE_CIDRS_SOURCE must be an auditable HTTPS provider reference" ;;
esac
case "$cdn_origin_auth_secret" in
  *[!A-Za-z0-9_-]*) fail "WORKBENCH_CDN_ORIGIN_AUTH_SECRET must be base64url" ;;
esac
[ "${#cdn_origin_auth_secret}" -ge 43 ] \
  || fail "WORKBENCH_CDN_ORIGIN_AUTH_SECRET must contain at least 32 random bytes"

dex_issuer=$(strip_yaml_scalar "$(sed -n 's/^issuer:[[:space:]]*//p' "$DEX_CONFIG")")
dex_client_id=$(strip_yaml_scalar "$(sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' "$DEX_CONFIG" | head -n 1)")
dex_client_secret=$(strip_yaml_scalar "$(sed -n 's/^[[:space:]]*secret:[[:space:]]*//p' "$DEX_CONFIG" | head -n 1)")
dex_redirect=$(strip_yaml_scalar "$(sed -n 's/^[[:space:]]*- \(https:\/\/.*oauth2\/callback\/workbench-oidc\)$/\1/p' "$DEX_CONFIG" | head -n 1)")
dex_password_hash=$(strip_yaml_scalar "$(sed -n 's/^[[:space:]]*hash:[[:space:]]*//p' "$DEX_CONFIG" | head -n 1)")
dex_user_id=$(strip_yaml_scalar "$(sed -n 's/^[[:space:]]*userID:[[:space:]]*//p' "$DEX_CONFIG" | head -n 1)")

[ "$dex_issuer" = "$oidc_issuer" ] || fail "Dex issuer mismatch"
[ "$dex_client_id" = "$oidc_client_id" ] || fail "Dex client id mismatch"
[ "$dex_client_secret" = "$oidc_client_secret" ] || fail "Dex client secret mismatch"
[ "$dex_redirect" = "${web_origin}/api/auth/oauth2/callback/workbench-oidc" ] \
  || fail "Dex redirect URI mismatch"
printf '%s' "$dex_password_hash" | grep -Eq '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' \
  || fail "Dex password hash is not bcrypt"
printf '%s' "$dex_user_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' \
  || fail "Dex userID is not a UUID"

grep -Fq 'www.{$WORKBENCH_WEB_HOSTNAME} {' "$CADDY_FILE" || fail "www redirect hostname placeholder missing from Caddy"
grep -Fq '{$WORKBENCH_WEB_HOSTNAME} {' "$CADDY_FILE" || fail "main hostname placeholder missing from Caddy"
grep -Fq '{$WORKBENCH_PREVIEW_HOSTNAME} {' "$CADDY_FILE" || fail "Preview hostname placeholder missing from Caddy"
grep -Fq '{$WORKBENCH_S3_HOSTNAME} {' "$CADDY_FILE" || fail "S3 hostname placeholder missing from Caddy"
grep -Fq '{$WORKBENCH_IDENTITY_HOSTNAME} {' "$CADDY_FILE" || fail "Identity hostname placeholder missing from Caddy"
grep -Fq 'reverse_proxy 127.0.0.1:4180' "$CADDY_FILE" || fail "main gateway missing from Caddy"
grep -Fq 'reverse_proxy 127.0.0.1:4190' "$CADDY_FILE" || fail "Preview gateway missing from Caddy"
grep -Fq 'reverse_proxy 127.0.0.1:9100' "$CADDY_FILE" || fail "S3 gateway missing from Caddy"
grep -Fq 'reverse_proxy 127.0.0.1:5556' "$CADDY_FILE" || fail "OIDC gateway missing from Caddy"
grep -Fq 'remote_ip {$WORKBENCH_CDN_EDGE_CIDRS}' "$CADDY_FILE" \
  || fail "Caddy must source-allowlist the CDN"
grep -Fq 'header X-Workbench-Origin-Auth {$WORKBENCH_CDN_ORIGIN_AUTH_SECRET}' "$CADDY_FILE" \
  || fail "Caddy must authenticate CDN origin requests"
grep -Fq 'header_up X-Workbench-Client-IP {http.request.header.Ali-Cdn-Real-Ip}' "$CADDY_FILE" \
  || fail "Caddy must overwrite the canonical client IP header"
grep -Fq 'header_up -X-Workbench-Origin-Auth' "$CADDY_FILE" \
  || fail "Caddy must not forward the origin authentication secret"
grep -Fq 'respond 403' "$CADDY_FILE" \
  || fail "Caddy must reject requests outside the authenticated CDN handler"

[ -r "${tokenizer_dir}/tokenizer.json" ] \
  || fail "tokenizer.json is missing"
[ -r "${tokenizer_dir}/tokenizer_config.json" ] \
  || fail "tokenizer_config.json is missing"

command -v caddy >/dev/null 2>&1 || fail "caddy is missing"
WORKBENCH_CDN_EDGE_CIDRS="$cdn_edge_cidrs" \
WORKBENCH_CDN_ORIGIN_AUTH_SECRET="$cdn_origin_auth_secret" \
WORKBENCH_WEB_HOSTNAME="$web_hostname" \
WORKBENCH_PREVIEW_HOSTNAME="$preview_hostname" \
WORKBENCH_S3_HOSTNAME="$s3_hostname" \
WORKBENCH_IDENTITY_HOSTNAME="$identity_hostname" \
  caddy validate --adapter caddyfile --config "$CADDY_FILE" >/dev/null

docker compose \
  --project-directory "$APP_DIR/deploy" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  -f "$OVERLAY_FILE" \
  --profile local-object-storage \
  --profile local-docling \
  config --quiet

printf '%s\n' "workbench preflight: ok"
