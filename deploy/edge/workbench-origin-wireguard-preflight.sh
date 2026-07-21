#!/bin/sh
set -eu

ENV_FILE=${WORKBENCH_ENV_FILE:-/etc/workbench/release/workbench.env}
WIREGUARD_CONFIG=${WORKBENCH_ORIGIN_WIREGUARD_CONFIG:-/etc/wireguard/wg0.conf}

fail() {
  printf '%s\n' "workbench origin WireGuard preflight: $*" >&2
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

validate_wireguard_key() {
  name=$1
  value=$2
  printf '%s' "$value" | grep -Eq '^[A-Za-z0-9+/]{43}=$' \
    || fail "$name must be a canonical 32-byte WireGuard base64 key"
}

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -r "$WIREGUARD_CONFIG" ] || fail "missing readable $WIREGUARD_CONFIG"

[ "$(grep -Ec '^[[:space:]]*\[Interface\][[:space:]]*$' "$WIREGUARD_CONFIG")" -eq 1 ] \
  || fail "Origin WireGuard config must contain exactly one interface"

edge_wireguard_ip=$(require_env WORKBENCH_EDGE_WIREGUARD_IP)
origin_wireguard_ip=$(require_env WORKBENCH_ORIGIN_WIREGUARD_IP)
edge_endpoint=$(require_env WORKBENCH_EDGE_WIREGUARD_ENDPOINT)
private_key=$(sed -n 's/^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*//p' "$WIREGUARD_CONFIG" | sed 's/[[:space:]]*$//')
peer_public_key=$(sed -n 's/^[[:space:]]*PublicKey[[:space:]]*=[[:space:]]*//p' "$WIREGUARD_CONFIG" | sed 's/[[:space:]]*$//')
peer_endpoint=$(sed -n 's/^[[:space:]]*Endpoint[[:space:]]*=[[:space:]]*//p' "$WIREGUARD_CONFIG" | sed 's/[[:space:]]*$//')

validate_wireguard_key WireGuard.PrivateKey "$private_key"
validate_wireguard_key WireGuard.Peer.PublicKey "$peer_public_key"
[ "$peer_endpoint" = "$edge_endpoint" ] \
  || fail "WireGuard peer Endpoint must match WORKBENCH_EDGE_WIREGUARD_ENDPOINT"
printf '%s' "$edge_endpoint" | grep -Eq '^[A-Za-z0-9.-]+:51820$' \
  || fail "WORKBENCH_EDGE_WIREGUARD_ENDPOINT must use port 51820"

[ "$(grep -Ec '^[[:space:]]*\[Peer\][[:space:]]*$' "$WIREGUARD_CONFIG")" -eq 1 ] \
  || fail "Origin WireGuard config must contain exactly one Edge peer"
grep -Eq "^[[:space:]]*Address[[:space:]]*=[[:space:]]*${origin_wireguard_ip}/[0-9]+[[:space:]]*$" "$WIREGUARD_CONFIG" \
  || fail "WireGuard interface address does not match WORKBENCH_ORIGIN_WIREGUARD_IP"

allowed_ips_count=$(grep -Ec '^[[:space:]]*AllowedIPs[[:space:]]*=' "$WIREGUARD_CONFIG")
[ "$allowed_ips_count" -eq 1 ] \
  || fail "Origin WireGuard config must contain exactly one AllowedIPs entry"
allowed_ips=$(sed -n 's/^[[:space:]]*AllowedIPs[[:space:]]*=[[:space:]]*//p' "$WIREGUARD_CONFIG" | sed 's/[[:space:]]*$//')
if grep -Eq 'AllowedIPs[[:space:]]*=.*(0\.0\.0\.0/0|::/0)' "$WIREGUARD_CONFIG"; then
  fail "Origin WireGuard peer must not route the public Internet"
fi
[ "$allowed_ips" = "${edge_wireguard_ip}/32" ] \
  || fail "Origin WireGuard peer AllowedIPs must equal the Edge /32"

printf '%s\n' "workbench origin WireGuard preflight: ok"
