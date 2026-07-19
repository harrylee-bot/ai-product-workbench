#!/bin/sh
set -eu

APP_DIR=${WORKBENCH_APP_DIR:-/opt/workbench}
ENV_FILE=${WORKBENCH_ENV_FILE:-$APP_DIR/deploy/workbench.env}
CADDY_FILE=${WORKBENCH_CADDY_FILE:-$APP_DIR/deploy/workbench-production.Caddyfile}
if [ -n "${WORKBENCH_PREFLIGHT_SCRIPT:-}" ]; then
  PREFLIGHT_SCRIPT="$WORKBENCH_PREFLIGHT_SCRIPT"
elif printf '%s' "$CADDY_FILE" | grep -Fq 'workbench-server-validation.Caddyfile'; then
  PREFLIGHT_SCRIPT="$APP_DIR/deploy/workbench-server-preflight.sh"
else
  PREFLIGHT_SCRIPT="$APP_DIR/deploy/workbench-production-preflight.sh"
fi
CADDY_INSTALL_FILE=/etc/caddy/Caddyfile
CADDY_RUNTIME_ENV_FILE=/etc/caddy/workbench-auth-proxy.env
CADDY_DROP_IN_DIR=/etc/systemd/system/caddy.service.d
CADDY_DROP_IN_TEMPLATE=${WORKBENCH_CADDY_DROP_IN_TEMPLATE:-$APP_DIR/deploy/caddy-workbench.service.d/override.conf}
CADDY_SERVICE=${WORKBENCH_CADDY_SERVICE:-caddy}
ORIGIN_MANIFEST_SCRIPT=${WORKBENCH_ORIGIN_MANIFEST_SCRIPT:-$APP_DIR/scripts/workbench-origin-manifest.mjs}

fail() {
  printf '%s\n' "workbench caddy reload: $*" >&2
  exit 1
}

env_value() {
  key=$1
  count=$(grep -c "^${key}=" "$ENV_FILE" || true)
  [ "$count" -eq 1 ] || fail "$key must occur exactly once in $ENV_FILE"
  sed -n "s/^${key}=//p" "$ENV_FILE"
}

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$CADDY_FILE" ] || fail "missing $CADDY_FILE"
[ -f "$PREFLIGHT_SCRIPT" ] || fail "missing $PREFLIGHT_SCRIPT"
[ -f "$CADDY_DROP_IN_TEMPLATE" ] || fail "missing $CADDY_DROP_IN_TEMPLATE"
[ -f "$ORIGIN_MANIFEST_SCRIPT" ] || fail "missing $ORIGIN_MANIFEST_SCRIPT"
[ "$(id -u)" -eq 0 ] || fail "run this installer as root"
command -v caddy >/dev/null 2>&1 || fail "caddy is missing"
command -v install >/dev/null 2>&1 || fail "install is missing"
command -v systemctl >/dev/null 2>&1 || fail "systemctl is missing"

WORKBENCH_APP_DIR="$APP_DIR" \
WORKBENCH_ENV_FILE="$ENV_FILE" \
WORKBENCH_CADDY_FILE="$CADDY_FILE" \
  sh "$PREFLIGHT_SCRIPT"

cdn_edge_cidrs=$(env_value WORKBENCH_CDN_EDGE_CIDRS)
cdn_origin_auth_secret=$(env_value WORKBENCH_CDN_ORIGIN_AUTH_SECRET)
web_origin=$(env_value WORKBENCH_WEB_ORIGIN)
[ -n "$cdn_edge_cidrs" ] || fail "WORKBENCH_CDN_EDGE_CIDRS is empty"
[ -n "$cdn_origin_auth_secret" ] || fail "WORKBENCH_CDN_ORIGIN_AUTH_SECRET is empty"
[ -n "$web_origin" ] || fail "WORKBENCH_WEB_ORIGIN is empty"

origin_env_tmp=$(mktemp)
trap 'rm -f "$origin_env_tmp"' EXIT HUP INT TERM
node "$ORIGIN_MANIFEST_SCRIPT" --env-file "$ENV_FILE" --format caddy-env >"$origin_env_tmp" \
  || fail "public origin manifest is invalid"
. "$origin_env_tmp"
web_hostname=$WORKBENCH_WEB_HOSTNAME
preview_hostname=$WORKBENCH_PREVIEW_HOSTNAME
s3_hostname=$WORKBENCH_S3_HOSTNAME
identity_hostname=$WORKBENCH_IDENTITY_HOSTNAME

WORKBENCH_CDN_EDGE_CIDRS="$cdn_edge_cidrs" \
WORKBENCH_CDN_ORIGIN_AUTH_SECRET="$cdn_origin_auth_secret" \
WORKBENCH_WEB_HOSTNAME="$web_hostname" \
WORKBENCH_PREVIEW_HOSTNAME="$preview_hostname" \
WORKBENCH_S3_HOSTNAME="$s3_hostname" \
WORKBENCH_IDENTITY_HOSTNAME="$identity_hostname" \
  caddy validate --adapter caddyfile --config "$CADDY_FILE" >/dev/null

runtime_env_tmp=$(mktemp)
trap 'rm -f "$runtime_env_tmp" "$origin_env_tmp"' EXIT HUP INT TERM
umask 077
{
  printf 'WORKBENCH_CDN_EDGE_CIDRS="%s"\n' "$cdn_edge_cidrs"
  printf 'WORKBENCH_CDN_ORIGIN_AUTH_SECRET=%s\n' "$cdn_origin_auth_secret"
  printf 'WORKBENCH_WEB_HOSTNAME=%s\n' "$web_hostname"
  printf 'WORKBENCH_PREVIEW_HOSTNAME=%s\n' "$preview_hostname"
  printf 'WORKBENCH_S3_HOSTNAME=%s\n' "$s3_hostname"
  printf 'WORKBENCH_IDENTITY_HOSTNAME=%s\n' "$identity_hostname"
} >"$runtime_env_tmp"

install -d -m 0755 "$(dirname "$CADDY_INSTALL_FILE")" "$CADDY_DROP_IN_DIR"
install -m 0600 "$runtime_env_tmp" "$CADDY_RUNTIME_ENV_FILE"
install -m 0644 "$CADDY_FILE" "$CADDY_INSTALL_FILE"
install -m 0644 "$CADDY_DROP_IN_TEMPLATE" "$CADDY_DROP_IN_DIR/override.conf"
systemctl daemon-reload
systemctl reload "$CADDY_SERVICE"

printf '%s\n' "workbench caddy reload: installed persistent auth proxy configuration"
