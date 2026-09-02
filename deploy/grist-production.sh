#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT_PATH="$ROOT_DIR/deploy/grist-production.sh"
COMPOSE_FILE="$ROOT_DIR/deploy/grist-production-compose.yml"
DATA_DIR=${GRIST_DATA_DIR:-/var/lib/workbench/grist}
ENV_FILE=${GRIST_ENV_FILE:-"$DATA_DIR/grist.env"}
BASE_IMAGE=gristlabs/grist-oss@sha256:b87ec1c3b62ca99f872611a9aa71ca33ee5fef9f40e0921e0beed878e5083473
IMAGE=${GRIST_IMAGE:-workbench-grist:1.7.17-owner-tools}
PUBLIC_ORIGIN=${GRIST_PUBLIC_ORIGIN:-https://requirements.aionbench.com}
WORKBENCH_ORIGIN=${WORKBENCH_ORIGIN:-https://aionbench.com}
OWNER_EMAIL=${GRIST_OWNER_EMAIL:-workbench-admin@aionbench.com}
OWNER_NAME=${GRIST_OWNER_NAME:-Workbench Admin}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

remove_env_key() {
  key=$1
  temp_file="$ENV_FILE.tmp"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$ENV_FILE" >"$temp_file"
  mv "$temp_file" "$ENV_FILE"
}

set_env_value() {
  key=$1
  value=$2
  remove_env_key "$key"
  printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
}

ensure_locales() {
  missing=false
  for locale_file in en.client.json en.server.json zh_Hans.client.json zh_Hans.server.json; do
    [ -f "$DATA_DIR/locales/$locale_file" ] || missing=true
  done
  [ "$missing" = true ] || return 0

  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
  locale_container=$(docker create "$IMAGE")
  trap 'docker rm -f "$locale_container" >/dev/null 2>&1 || true' EXIT INT TERM
  rm -f "$DATA_DIR/locales"/*.json
  for locale_file in en.client.json en.server.json zh_Hans.client.json zh_Hans.server.json; do
    docker cp "$locale_container:/grist/static/locales/$locale_file" \
      "$DATA_DIR/locales/$locale_file"
  done
  docker rm "$locale_container" >/dev/null
  trap - EXIT INT TERM
}

ensure_grist_image() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 && return 0
  docker build \
    --build-arg "GRIST_BASE_IMAGE=$BASE_IMAGE" \
    --file "$ROOT_DIR/deploy/grist-owner-tools.Dockerfile" \
    --tag "$IMAGE" \
    "$ROOT_DIR"
}

apply_locale_overrides() {
  command -v node >/dev/null 2>&1 || {
    printf '%s\n' "node is required to prepare Grist locales" >&2
    exit 69
  }
  node "$ROOT_DIR/deploy/grist-locales.mjs" apply \
    "$DATA_DIR/locales/en.client.json" \
    "$DATA_DIR/locales/zh_Hans.client.json" \
    "$ROOT_DIR/deploy/grist-zh-hans-overrides.json" \
    "$DATA_DIR/locales/zh_Hans.client.json"
}

prepare() {
  command -v docker >/dev/null 2>&1 || {
    printf '%s\n' "docker is required" >&2
    exit 69
  }
  ensure_grist_image
  mkdir -p "$DATA_DIR/persist" "$DATA_DIR/locales" "$DATA_DIR/backups"
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    : >"$ENV_FILE"
    set_env_value GRIST_BOOT_KEY "$(openssl rand -hex 32)"
    set_env_value WORKBENCH_GRIST_SSO_SECRET "$(openssl rand -hex 32)"
  fi
  set_env_value GRIST_DATA_DIR "$DATA_DIR"
  set_env_value GRIST_IMAGE "$IMAGE"
  set_env_value GRIST_PUBLIC_ORIGIN "$PUBLIC_ORIGIN"
  set_env_value WORKBENCH_ORIGIN "$WORKBENCH_ORIGIN"
  set_env_value GRIST_OWNER_EMAIL "$OWNER_EMAIL"
  set_env_value GRIST_OWNER_NAME "$OWNER_NAME"
  chmod 600 "$ENV_FILE"
  ensure_locales
  apply_locale_overrides
}

wait_until_ready() {
  attempt=0
  while [ "$attempt" -lt 90 ]; do
    status=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8484/status 2>/dev/null || true)
    case "$status" in
      2??|3??) return 0 ;;
    esac
    attempt=$((attempt + 1))
    sleep 1
  done
  printf '%s\n' "Grist did not become ready" >&2
  compose logs --tail 100 >&2
  return 1
}

start() {
  prepare
  compose up -d --build
  wait_until_ready
  printf 'Grist is ready at %s\n' "$PUBLIC_ORIGIN"
}

stop() {
  [ -f "$ENV_FILE" ] || return 0
  compose stop
}

provision() {
  start
  GRIST_CONTROL_SCRIPT="$SCRIPT_PATH" \
  GRIST_LOCAL_DATA_DIR="$DATA_DIR" \
  GRIST_LOCAL_URL="$PUBLIC_ORIGIN" \
  GRIST_OWNER_EMAIL="$OWNER_EMAIL" \
  GRIST_OWNER_NAME="$OWNER_NAME" \
    node --no-warnings=ExperimentalWarning \
      "$ROOT_DIR/deploy/grist-provision-requirement-pool.mjs"
}

case "${1:-start}" in
  prepare) prepare ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  provision) provision ;;
  status) compose ps ;;
  logs) compose logs --tail 200 --follow ;;
  *)
    printf 'usage: %s {prepare|start|stop|restart|provision|status|logs}\n' "$0" >&2
    exit 64
    ;;
esac
