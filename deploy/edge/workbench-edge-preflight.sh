#!/bin/sh
set -eu

EDGE_DIR=${WORKBENCH_EDGE_DIR:-/opt/workbench/deploy/edge}
ENV_FILE=${WORKBENCH_EDGE_ENV_FILE:-/etc/workbench/edge/workbench-edge.env}
CADDY_FILE=${WORKBENCH_EDGE_CADDY_FILE:-$EDGE_DIR/workbench-edge.Caddyfile}
WIREGUARD_CONFIG=${WORKBENCH_EDGE_WIREGUARD_CONFIG:-/etc/wireguard/wg0.conf}

fail() {
  printf '%s\n' "workbench edge preflight: $*" >&2
  exit 1
}

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

validate_hostname() {
  name=$1
  value=$2
  printf '%s' "$value" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' \
    || fail "$name must be a canonical lowercase hostname"
  case "$value" in
    *..*) fail "$name must be a canonical lowercase hostname" ;;
  esac
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

validate_wireguard_key() {
  name=$1
  value=$2
  printf '%s' "$value" | grep -Eq '^[A-Za-z0-9+/]{43}=$' \
    || fail "$name must be a canonical 32-byte WireGuard base64 key"
}

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$CADDY_FILE" ] || fail "missing $CADDY_FILE"
[ -r "$WIREGUARD_CONFIG" ] || fail "missing readable $WIREGUARD_CONFIG"

[ "$(grep -Ec '^[[:space:]]*\[Interface\][[:space:]]*$' "$WIREGUARD_CONFIG")" -eq 1 ] \
  || fail "Edge WireGuard config must contain exactly one interface"
[ "$(grep -Ec '^[[:space:]]*\[Peer\][[:space:]]*$' "$WIREGUARD_CONFIG")" -eq 1 ] \
  || fail "Edge WireGuard config must contain exactly one origin peer"

web_hostname=$(require_env WORKBENCH_WEB_HOSTNAME)
preview_hostname=$(require_env WORKBENCH_PREVIEW_HOSTNAME)
edge_wireguard_ip=$(require_env WORKBENCH_EDGE_WIREGUARD_IP)
origin_wireguard_ip=$(require_env WORKBENCH_ORIGIN_WIREGUARD_IP)
origin_http_port=$(require_env WORKBENCH_ORIGIN_HTTP_PORT)
origin_auth_secret=$(require_env WORKBENCH_EDGE_ORIGIN_AUTH_SECRET)
private_key=$(sed -n 's/^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*//p' "$WIREGUARD_CONFIG" | sed 's/[[:space:]]*$//')
peer_public_key=$(sed -n 's/^[[:space:]]*PublicKey[[:space:]]*=[[:space:]]*//p' "$WIREGUARD_CONFIG" | sed 's/[[:space:]]*$//')

validate_hostname WORKBENCH_WEB_HOSTNAME "$web_hostname"
validate_hostname WORKBENCH_PREVIEW_HOSTNAME "$preview_hostname"
[ "$web_hostname" != "$preview_hostname" ] || fail "Web and Preview hostnames must differ"
validate_private_ipv4 WORKBENCH_EDGE_WIREGUARD_IP "$edge_wireguard_ip"
validate_private_ipv4 WORKBENCH_ORIGIN_WIREGUARD_IP "$origin_wireguard_ip"
[ "$edge_wireguard_ip" != "$origin_wireguard_ip" ] || fail "Edge and origin WireGuard IPs must differ"
printf '%s' "$origin_http_port" | grep -Eq '^[1-9][0-9]{3,4}$' \
  || fail "WORKBENCH_ORIGIN_HTTP_PORT must be an unprivileged TCP port"
[ "$origin_http_port" -ge 1024 ] && [ "$origin_http_port" -le 65535 ] \
  || fail "WORKBENCH_ORIGIN_HTTP_PORT must be between 1024 and 65535"
case "$origin_auth_secret" in
  *[!A-Za-z0-9_-]*) fail "WORKBENCH_EDGE_ORIGIN_AUTH_SECRET must be base64url" ;;
esac
[ "${#origin_auth_secret}" -ge 43 ] \
  || fail "WORKBENCH_EDGE_ORIGIN_AUTH_SECRET must contain at least 32 random bytes"
validate_wireguard_key WireGuard.PrivateKey "$private_key"
validate_wireguard_key WireGuard.Peer.PublicKey "$peer_public_key"

listen_port=$(sed -n 's/^[[:space:]]*ListenPort[[:space:]]*=[[:space:]]*//p' "$WIREGUARD_CONFIG" | sed 's/[[:space:]]*$//')
[ "$listen_port" = "51820" ] || fail "Edge WireGuard ListenPort must be 51820"

grep -Eq "^[[:space:]]*Address[[:space:]]*=[[:space:]]*${edge_wireguard_ip}/[0-9]+[[:space:]]*$" "$WIREGUARD_CONFIG" \
  || fail "WireGuard interface address does not match WORKBENCH_EDGE_WIREGUARD_IP"
grep -Eq "^[[:space:]]*AllowedIPs[[:space:]]*=[[:space:]]*${origin_wireguard_ip}/32[[:space:]]*$" "$WIREGUARD_CONFIG" \
  || fail "WireGuard peer must allow only the origin /32"
if grep -Eq 'AllowedIPs[[:space:]]*=.*(0\.0\.0\.0/0|::/0)' "$WIREGUARD_CONFIG"; then
  fail "WireGuard peer must not route the public Internet"
fi

for fragment in \
  '@runEvents path_regexp runEvents ^/api/v1/runs/[^/]+/events$' \
  'flush_interval -1' \
  '@preview path /preview/*' \
  'header_up -Cookie' \
  'header_down -Set-Cookie' \
  'X-Workbench-Edge-Client-IP {http.request.remote.host}' \
  'X-Workbench-Edge-Auth {$WORKBENCH_EDGE_ORIGIN_AUTH_SECRET}'
do
  grep -Fq "$fragment" "$CADDY_FILE" || fail "Edge Caddy contract is missing: $fragment"
done

command -v caddy >/dev/null 2>&1 || fail "caddy is missing"
WORKBENCH_WEB_HOSTNAME="$web_hostname" \
WORKBENCH_PREVIEW_HOSTNAME="$preview_hostname" \
WORKBENCH_EDGE_WIREGUARD_IP="$edge_wireguard_ip" \
WORKBENCH_ORIGIN_WIREGUARD_IP="$origin_wireguard_ip" \
WORKBENCH_ORIGIN_HTTP_PORT="$origin_http_port" \
WORKBENCH_EDGE_ORIGIN_AUTH_SECRET="$origin_auth_secret" \
  caddy validate --adapter caddyfile --config "$CADDY_FILE" >/dev/null

printf '%s\n' "workbench edge preflight: ok"
