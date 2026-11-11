#!/bin/sh
set -eu

APP_DIR=${WORKBENCH_APP_DIR:-/opt/workbench}
ENV_FILE=${WORKBENCH_ENV_FILE:-$APP_DIR/deploy/workbench.env}
COMPOSE_FILE=${WORKBENCH_COMPOSE_FILE:-$APP_DIR/deploy/workbench-compose.yml}
CADDY_FILE=${WORKBENCH_CADDY_FILE:-$APP_DIR/deploy/workbench-production.Caddyfile}
ORIGIN_MANIFEST_SCRIPT=${WORKBENCH_ORIGIN_MANIFEST_SCRIPT:-$APP_DIR/scripts/workbench-origin-manifest.mjs}
DATABASE_ROLE_CONTRACT_SCRIPT=${WORKBENCH_DATABASE_ROLE_CONTRACT_SCRIPT:-$APP_DIR/scripts/assert-workbench-database-role-contract.mjs}
ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT=${WORKBENCH_ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT:-$APP_DIR/deploy/edge/workbench-origin-wireguard-preflight.sh}
ORIGIN_WIREGUARD_CONFIG=${WORKBENCH_ORIGIN_WIREGUARD_CONFIG:-/etc/wireguard/wg0.conf}
fail() {
  printf '%s\n' "workbench production preflight: $*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || fail "missing $COMPOSE_FILE"
[ -f "$CADDY_FILE" ] || fail "missing $CADDY_FILE"
[ -f "$ORIGIN_MANIFEST_SCRIPT" ] || fail "missing $ORIGIN_MANIFEST_SCRIPT"
[ -f "$DATABASE_ROLE_CONTRACT_SCRIPT" ] || fail "missing $DATABASE_ROLE_CONTRACT_SCRIPT"
[ -f "$ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT" ] || fail "missing $ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT"
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

require_env WORKBENCH_WEB_ORIGIN >/dev/null
require_env WORKBENCH_PREVIEW_ORIGIN >/dev/null
require_env WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL >/dev/null
s3_internal_endpoint=$(require_env WORKBENCH_S3_INTERNAL_ENDPOINT)
s3_egress_upstream_host=$(require_env WORKBENCH_S3_EGRESS_UPSTREAM_HOST)
s3_bucket=$(require_env WORKBENCH_S3_BUCKET)
s3_conditional_create_mode=$(require_env WORKBENCH_S3_CONDITIONAL_CREATE_MODE)
enterprise_sso_enabled=$(require_env WORKBENCH_ENTERPRISE_SSO_ENABLED)
canvas_tool_url=$(require_env WORKBENCH_CANVAS_TOOL_URL)
canvas_visual_url=$(require_env WORKBENCH_CANVAS_VISUAL_URL)
database_url=$(require_env WORKBENCH_DATABASE_URL)
require_env WORKBENCH_POSTGRES_ADMIN_URL >/dev/null
require_env WORKBENCH_MIGRATOR_DATABASE_URL >/dev/null
require_env WORKBENCH_POSTGRES_USER >/dev/null
require_env WORKBENCH_POSTGRES_MIGRATOR_USER >/dev/null
require_env WORKBENCH_POSTGRES_MIGRATOR_PASSWORD >/dev/null
require_env WORKBENCH_POSTGRES_RUNTIME_USER >/dev/null
require_env WORKBENCH_POSTGRES_RUNTIME_PASSWORD >/dev/null
public_registration=$(require_env WORKBENCH_PUBLIC_REGISTRATION_ENABLED)
runtime_provider_state_mode=$(require_env WORKBENCH_RUNTIME_PROVIDER_STATE_MODE)
auth_ip_header=$(require_env WORKBENCH_AUTH_CLIENT_IP_HEADER)
edge_wireguard_ip=$(require_env WORKBENCH_EDGE_WIREGUARD_IP)
origin_wireguard_ip=$(require_env WORKBENCH_ORIGIN_WIREGUARD_IP)
origin_http_port=$(require_env WORKBENCH_ORIGIN_HTTP_PORT)
edge_origin_auth_secret=$(require_env WORKBENCH_EDGE_ORIGIN_AUTH_SECRET)
tokenizer_dir=$(require_env WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR)
source_commit=$(require_env WORKBENCH_SOURCE_COMMIT)
scan_mode=$(require_env WORKBENCH_FILE_SCAN_MODE)
postgres_image=$(require_env WORKBENCH_POSTGRES_IMAGE)
nginx_image=$(require_env WORKBENCH_NGINX_IMAGE)
node_image=$(require_env WORKBENCH_NODE_IMAGE)
compose_profiles=${WORKBENCH_COMPOSE_PROFILES:-${COMPOSE_PROFILES:-}}

node -e '
  const [endpointValue, upstreamHost, bucket] = process.argv.slice(1);
  const endpoint = new URL(endpointValue);
  const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  const bucketName = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u;
  if (endpoint.protocol !== "https:" || endpoint.pathname !== "/" || endpoint.port
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) process.exit(1);
  if (!hostname.test(upstreamHost) || endpoint.hostname !== upstreamHost) process.exit(1);
  if (!bucketName.test(bucket)) process.exit(1);
' "$s3_internal_endpoint" "$s3_egress_upstream_host" "$s3_bucket" >/dev/null 2>&1 \
  || fail "S3 internal endpoint, egress upstream host, or bucket is not a canonical restricted tunnel target"

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
[ "$runtime_provider_state_mode" = "projection-required" ] \
  || fail "WORKBENCH_RUNTIME_PROVIDER_STATE_MODE must be projection-required in production"
case "$s3_conditional_create_mode" in
  s3-if-none-match | oss-forbid-overwrite) ;;
  *) fail "WORKBENCH_S3_CONDITIONAL_CREATE_MODE must be s3-if-none-match or oss-forbid-overwrite" ;;
esac
case "$s3_egress_upstream_host" in
  *.aliyuncs.com)
    [ "$s3_conditional_create_mode" = "oss-forbid-overwrite" ] \
      || fail "Alibaba Cloud OSS requires WORKBENCH_S3_CONDITIONAL_CREATE_MODE=oss-forbid-overwrite"
    ;;
esac
case "$enterprise_sso_enabled" in
  true | false) ;;
  *) fail "WORKBENCH_ENTERPRISE_SSO_ENABLED must be true or false" ;;
esac
[ "$auth_ip_header" = "x-workbench-client-ip" ] || fail "WORKBENCH_AUTH_CLIENT_IP_HEADER must be x-workbench-client-ip"
[ "$scan_mode" = "clamav" ] || fail "production uploads require WORKBENCH_FILE_SCAN_MODE=clamav"
printf '%s' "$database_url" | grep -Eq '@postgres([:/?]|$)' || fail "WORKBENCH_DATABASE_URL must address the Compose postgres service"
node "$DATABASE_ROLE_CONTRACT_SCRIPT" --env-file="$ENV_FILE" \
  || fail "database role separation contract is invalid"
printf '%s' "$source_commit" | grep -Eq '^[0-9a-f]{40}$' || fail "WORKBENCH_SOURCE_COMMIT must be a lowercase Git commit"
printf '%s' "$postgres_image" | grep -Eq '@sha256:[a-f0-9]{64}$' || fail "WORKBENCH_POSTGRES_IMAGE must be an immutable digest reference"
printf '%s' "$nginx_image" | grep -Eq '@sha256:[a-f0-9]{64}$' || fail "WORKBENCH_NGINX_IMAGE must be an immutable digest reference"
printf '%s' "$node_image" | grep -Eq '@sha256:[a-f0-9]{64}$' || fail "WORKBENCH_NODE_IMAGE must be an immutable digest reference"
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

origin_env=$(mktemp)
trap 'rm -f "$origin_env"' EXIT HUP INT TERM
node "$ORIGIN_MANIFEST_SCRIPT" --env-file "$ENV_FILE" --format caddy-env >"$origin_env" \
  || fail "public origin manifest is invalid"
. "$origin_env"
[ "$WORKBENCH_WEB_HOSTNAME" != "$WORKBENCH_PREVIEW_HOSTNAME" ] || fail "Preview must use a distinct hostname"

[ "$(grep -Fc 'bind {$WORKBENCH_ORIGIN_WIREGUARD_IP}' "$CADDY_FILE")" -eq 2 ] \
  || fail "Web and Preview must both bind only the origin WireGuard address"
[ "$(grep -Fc 'remote_ip {$WORKBENCH_EDGE_WIREGUARD_IP}' "$CADDY_FILE")" -eq 2 ] \
  || fail "Web and Preview must both source-allowlist the WireGuard Edge peer"
[ "$(grep -Fc 'header X-Workbench-Edge-Auth {$WORKBENCH_EDGE_ORIGIN_AUTH_SECRET}' "$CADDY_FILE")" -eq 2 ] \
  || fail "Web and Preview must both authenticate the Edge"
[ "$(grep -Fc 'respond 403' "$CADDY_FILE")" -eq 2 ] \
  || fail "Web and Preview must both reject requests outside the authenticated Edge handler"
grep -Fq 'header_up X-Workbench-Client-IP {http.request.header.X-Workbench-Edge-Client-IP}' "$CADDY_FILE" \
  || fail "Web must derive the canonical client IP from the authenticated Edge header"
grep -Fq 'header_up -Cookie' "$CADDY_FILE" \
  || fail "Preview origin requests must not receive Web cookies"
grep -Fq 'header_down -Set-Cookie' "$CADDY_FILE" \
  || fail "Preview origin responses must not set cookies"

[ -r "$tokenizer_dir/tokenizer.json" ] || fail "tokenizer.json is missing"
[ -r "$tokenizer_dir/tokenizer_config.json" ] || fail "tokenizer_config.json is missing"

command -v caddy >/dev/null 2>&1 || fail "caddy is missing"
WORKBENCH_EDGE_WIREGUARD_IP="$edge_wireguard_ip" \
WORKBENCH_ORIGIN_WIREGUARD_IP="$origin_wireguard_ip" \
WORKBENCH_ORIGIN_HTTP_PORT="$origin_http_port" \
WORKBENCH_EDGE_ORIGIN_AUTH_SECRET="$edge_origin_auth_secret" \
WORKBENCH_WEB_HOSTNAME="$WORKBENCH_WEB_HOSTNAME" \
WORKBENCH_PREVIEW_HOSTNAME="$WORKBENCH_PREVIEW_HOSTNAME" \
WORKBENCH_S3_HOSTNAME="$WORKBENCH_S3_HOSTNAME" \
  caddy validate --adapter caddyfile --config "$CADDY_FILE" >/dev/null

docker compose \
  --project-directory "$APP_DIR/deploy" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  config --quiet

printf '%s\n' "workbench production preflight: ok"
