#!/bin/sh
set -eu

APP_DIR=${WORKBENCH_APP_DIR:-/opt/workbench}
ENV_FILE=${WORKBENCH_ENV_FILE:-$APP_DIR/deploy/workbench.env}
CADDY_FILE=${WORKBENCH_CADDY_FILE:-$APP_DIR/deploy/workbench-production.Caddyfile}
PREFLIGHT_SCRIPT="$APP_DIR/deploy/workbench-production-preflight.sh"
CADDY_INSTALL_FILE=/etc/caddy/Caddyfile
CADDY_RUNTIME_ENV_FILE=/etc/caddy/workbench-origin-edge.env
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

edge_wireguard_ip=$(env_value WORKBENCH_EDGE_WIREGUARD_IP)
origin_wireguard_ip=$(env_value WORKBENCH_ORIGIN_WIREGUARD_IP)
origin_http_port=$(env_value WORKBENCH_ORIGIN_HTTP_PORT)
edge_origin_auth_secret=$(env_value WORKBENCH_EDGE_ORIGIN_AUTH_SECRET)
web_origin=$(env_value WORKBENCH_WEB_ORIGIN)
[ -n "$edge_wireguard_ip" ] || fail "WORKBENCH_EDGE_WIREGUARD_IP is empty"
[ -n "$origin_wireguard_ip" ] || fail "WORKBENCH_ORIGIN_WIREGUARD_IP is empty"
[ -n "$origin_http_port" ] || fail "WORKBENCH_ORIGIN_HTTP_PORT is empty"
[ -n "$edge_origin_auth_secret" ] || fail "WORKBENCH_EDGE_ORIGIN_AUTH_SECRET is empty"
[ -n "$web_origin" ] || fail "WORKBENCH_WEB_ORIGIN is empty"

origin_env_tmp=$(mktemp)
trap 'rm -f "$origin_env_tmp"' EXIT HUP INT TERM
node "$ORIGIN_MANIFEST_SCRIPT" --env-file "$ENV_FILE" --format caddy-env >"$origin_env_tmp" \
  || fail "public origin manifest is invalid"
. "$origin_env_tmp"
web_hostname=$WORKBENCH_WEB_HOSTNAME
preview_hostname=$WORKBENCH_PREVIEW_HOSTNAME

WORKBENCH_EDGE_WIREGUARD_IP="$edge_wireguard_ip" \
WORKBENCH_ORIGIN_WIREGUARD_IP="$origin_wireguard_ip" \
WORKBENCH_ORIGIN_HTTP_PORT="$origin_http_port" \
WORKBENCH_EDGE_ORIGIN_AUTH_SECRET="$edge_origin_auth_secret" \
WORKBENCH_WEB_HOSTNAME="$web_hostname" \
WORKBENCH_PREVIEW_HOSTNAME="$preview_hostname" \
  caddy validate --adapter caddyfile --config "$CADDY_FILE" >/dev/null

runtime_env_tmp=$(mktemp)
trap 'rm -f "$runtime_env_tmp" "$origin_env_tmp"' EXIT HUP INT TERM
umask 077
{
  printf 'WORKBENCH_EDGE_WIREGUARD_IP=%s\n' "$edge_wireguard_ip"
  printf 'WORKBENCH_ORIGIN_WIREGUARD_IP=%s\n' "$origin_wireguard_ip"
  printf 'WORKBENCH_ORIGIN_HTTP_PORT=%s\n' "$origin_http_port"
  printf 'WORKBENCH_EDGE_ORIGIN_AUTH_SECRET=%s\n' "$edge_origin_auth_secret"
  printf 'WORKBENCH_WEB_HOSTNAME=%s\n' "$web_hostname"
  printf 'WORKBENCH_PREVIEW_HOSTNAME=%s\n' "$preview_hostname"
} >"$runtime_env_tmp"

install -d -m 0755 "$(dirname "$CADDY_INSTALL_FILE")" "$CADDY_DROP_IN_DIR"
install -m 0600 "$runtime_env_tmp" "$CADDY_RUNTIME_ENV_FILE"
install -m 0644 "$CADDY_FILE" "$CADDY_INSTALL_FILE"
install -m 0644 "$CADDY_DROP_IN_TEMPLATE" "$CADDY_DROP_IN_DIR/override.conf"
systemctl daemon-reload
systemctl reload "$CADDY_SERVICE"

printf '%s\n' "workbench caddy reload: installed persistent WireGuard Edge origin configuration"
