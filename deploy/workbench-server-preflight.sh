#!/bin/sh
set -eu

APP_DIR=${WORKBENCH_APP_DIR:-/opt/workbench}
ENV_FILE=${WORKBENCH_ENV_FILE:-$APP_DIR/deploy/workbench.env}
COMPOSE_FILE=${WORKBENCH_COMPOSE_FILE:-$APP_DIR/deploy/workbench-compose.yml}
OVERLAY_FILE=${WORKBENCH_OVERLAY_FILE:-$APP_DIR/deploy/workbench-server-validation-compose.yml}
DEX_CONFIG=${WORKBENCH_DEX_CONFIG:-$APP_DIR/deploy/workbench-dex-config.yaml}
CADDY_FILE=${WORKBENCH_CADDY_FILE:-$APP_DIR/deploy/workbench-server-validation.Caddyfile}
ORIGIN_MANIFEST_SCRIPT=${WORKBENCH_ORIGIN_MANIFEST_SCRIPT:-$APP_DIR/scripts/workbench-origin-manifest.mjs}
ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT=${WORKBENCH_ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT:-$APP_DIR/deploy/edge/workbench-origin-wireguard-preflight.sh}
ORIGIN_WIREGUARD_CONFIG=${WORKBENCH_ORIGIN_WIREGUARD_CONFIG:-/etc/wireguard/wg0.conf}

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
[ -f "$ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT" ] || fail "missing $ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT"
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

validate_private_ipv4() {
  name=$1
  value=$2
  printf '%s' "$value" | awk -F. '
    NF != 4 { exit 1 }
    { for (octet = 1; octet <= 4; octet += 1) {
        if ($octet !~ /^[0-9]+$/ || $octet < 0 || $octet > 255) exit 1
      }
    }
  ' || fail "$name must be a canonical private IPv4 address"
  case "$value" in
    10.* | 192.168.*) ;;
    172.*)
      second=${value#172.}
      second=${second%%.*}
      [ "$second" -ge 16 ] && [ "$second" -le 31 ] \
        || fail "$name must be an RFC1918 IPv4 address"
      ;;
    *) fail "$name must be an RFC1918 IPv4 address" ;;
  esac
}

strip_yaml_scalar() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//'
}

web_origin=$(require_env WORKBENCH_WEB_ORIGIN)
preview_origin=$(require_env WORKBENCH_PREVIEW_ORIGIN)
enterprise_sso_enabled=$(require_env WORKBENCH_ENTERPRISE_SSO_ENABLED)
oidc_issuer=$(require_env WORKBENCH_OIDC_PROVIDER_ISSUER)
oidc_client_id=$(require_env WORKBENCH_OIDC_CLIENT_ID)
oidc_client_secret=$(require_env WORKBENCH_OIDC_CLIENT_SECRET)
identity_hostname=$(require_env WORKBENCH_IDENTITY_HOSTNAME)
canvas_tool_url=$(require_env WORKBENCH_CANVAS_TOOL_URL)
canvas_visual_url=$(require_env WORKBENCH_CANVAS_VISUAL_URL)
tokenizer_dir=$(require_env WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR)
s3_internal=$(require_env WORKBENCH_S3_INTERNAL_ENDPOINT)
s3_browser=$(require_env WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL)
s3_conditional_create_mode=$(require_env WORKBENCH_S3_CONDITIONAL_CREATE_MODE)
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
edge_wireguard_ip=$(require_env WORKBENCH_EDGE_WIREGUARD_IP)
origin_wireguard_ip=$(require_env WORKBENCH_ORIGIN_WIREGUARD_IP)
origin_http_port=$(require_env WORKBENCH_ORIGIN_HTTP_PORT)
edge_origin_auth_secret=$(require_env WORKBENCH_EDGE_ORIGIN_AUTH_SECRET)

[ "$enterprise_sso_enabled" = "true" ] \
  || fail "server validation requires WORKBENCH_ENTERPRISE_SSO_ENABLED=true for the local Dex profile"

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
[ "$s3_conditional_create_mode" = "s3-if-none-match" ] \
  || fail "local validation requires WORKBENCH_S3_CONDITIONAL_CREATE_MODE=s3-if-none-match"
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
validate_private_ipv4 WORKBENCH_EDGE_WIREGUARD_IP "$edge_wireguard_ip"
validate_private_ipv4 WORKBENCH_ORIGIN_WIREGUARD_IP "$origin_wireguard_ip"
[ "$edge_wireguard_ip" != "$origin_wireguard_ip" ] \
  || fail "Edge and origin WireGuard IPs must differ"
printf '%s' "$origin_http_port" | grep -Eq '^[1-9][0-9]{3,4}$' \
  || fail "WORKBENCH_ORIGIN_HTTP_PORT must be an unprivileged TCP port"
[ "$origin_http_port" -ge 1024 ] && [ "$origin_http_port" -le 65535 ] \
  || fail "WORKBENCH_ORIGIN_HTTP_PORT must be between 1024 and 65535"
case "$edge_origin_auth_secret" in
  *[!A-Za-z0-9_-]*) fail "WORKBENCH_EDGE_ORIGIN_AUTH_SECRET must be base64url" ;;
esac
[ "${#edge_origin_auth_secret}" -ge 43 ] \
  || fail "WORKBENCH_EDGE_ORIGIN_AUTH_SECRET must contain at least 32 random bytes"
WORKBENCH_ENV_FILE="$ENV_FILE" \
WORKBENCH_ORIGIN_WIREGUARD_CONFIG="$ORIGIN_WIREGUARD_CONFIG" \
  sh "$ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT"

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

grep -Fq 'http://{$WORKBENCH_WEB_HOSTNAME}:{$WORKBENCH_ORIGIN_HTTP_PORT} {' "$CADDY_FILE" || fail "main origin hostname placeholder missing from Caddy"
grep -Fq 'http://{$WORKBENCH_PREVIEW_HOSTNAME}:{$WORKBENCH_ORIGIN_HTTP_PORT} {' "$CADDY_FILE" || fail "Preview origin hostname placeholder missing from Caddy"
grep -Fq '{$WORKBENCH_S3_HOSTNAME} {' "$CADDY_FILE" || fail "S3 hostname placeholder missing from Caddy"
grep -Fq '{$WORKBENCH_IDENTITY_HOSTNAME} {' "$CADDY_FILE" || fail "Identity hostname placeholder missing from Caddy"
grep -Fq 'reverse_proxy 127.0.0.1:4180' "$CADDY_FILE" || fail "main gateway missing from Caddy"
grep -Fq 'reverse_proxy 127.0.0.1:4190' "$CADDY_FILE" || fail "Preview gateway missing from Caddy"
grep -Fq 'reverse_proxy 127.0.0.1:9100' "$CADDY_FILE" || fail "S3 gateway missing from Caddy"
grep -Fq 'reverse_proxy 127.0.0.1:5556' "$CADDY_FILE" || fail "OIDC gateway missing from Caddy"
[ "$(grep -Fc 'bind {$WORKBENCH_ORIGIN_WIREGUARD_IP}' "$CADDY_FILE")" -eq 2 ] \
  || fail "Web and Preview must both bind only the origin WireGuard address"
[ "$(grep -Fc 'remote_ip {$WORKBENCH_EDGE_WIREGUARD_IP}' "$CADDY_FILE")" -eq 2 ] \
  || fail "Web and Preview must both source-allowlist the WireGuard Edge peer"
[ "$(grep -Fc 'header X-Workbench-Edge-Auth {$WORKBENCH_EDGE_ORIGIN_AUTH_SECRET}' "$CADDY_FILE")" -eq 2 ] \
  || fail "Web and Preview must both authenticate the Edge"
grep -Fq 'header_up X-Workbench-Client-IP {http.request.header.X-Workbench-Edge-Client-IP}' "$CADDY_FILE" \
  || fail "Caddy must overwrite the canonical client IP header"
[ "$(grep -Fc 'respond 403' "$CADDY_FILE")" -eq 2 ] \
  || fail "Web and Preview must both reject requests outside the authenticated Edge handler"
grep -Fq 'header_up -Cookie' "$CADDY_FILE" \
  || fail "Preview origin requests must not receive Web cookies"
grep -Fq 'header_down -Set-Cookie' "$CADDY_FILE" \
  || fail "Preview origin responses must not set cookies"

[ -r "${tokenizer_dir}/tokenizer.json" ] \
  || fail "tokenizer.json is missing"
[ -r "${tokenizer_dir}/tokenizer_config.json" ] \
  || fail "tokenizer_config.json is missing"

command -v caddy >/dev/null 2>&1 || fail "caddy is missing"
WORKBENCH_EDGE_WIREGUARD_IP="$edge_wireguard_ip" \
WORKBENCH_ORIGIN_WIREGUARD_IP="$origin_wireguard_ip" \
WORKBENCH_ORIGIN_HTTP_PORT="$origin_http_port" \
WORKBENCH_EDGE_ORIGIN_AUTH_SECRET="$edge_origin_auth_secret" \
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
