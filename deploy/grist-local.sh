#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_DIR=${GRIST_LOCAL_DATA_DIR:-"$ROOT_DIR/storage/grist"}
PERSIST_DIR="$DATA_DIR/persist"
LOCALES_DIR="$DATA_DIR/locales"
ENV_FILE="$DATA_DIR/grist.env"
GATEWAY_PID_FILE="$DATA_DIR/gateway.pid"
GATEWAY_LOG_FILE="$DATA_DIR/gateway.log"
CONTAINER_NAME=${GRIST_LOCAL_CONTAINER_NAME:-ai-product-workbench-grist}
HOST=${GRIST_LOCAL_HOST:-127.0.0.1}
PORT=${GRIST_LOCAL_PORT:-8484}
UPSTREAM_PORT=${GRIST_LOCAL_UPSTREAM_PORT:-8485}
PUBLIC_URL=${GRIST_LOCAL_URL:-http://localhost:$PORT}
UPSTREAM_URL="http://$HOST:$UPSTREAM_PORT"
WORKBENCH_ORIGIN=${WORKBENCH_ORIGIN:-http://localhost:3000}
IMAGE=${GRIST_LOCAL_IMAGE:-gristlabs/grist-oss@sha256:b87ec1c3b62ca99f872611a9aa71ca33ee5fef9f40e0921e0beed878e5083473}

require_docker() {
  command -v docker >/dev/null 2>&1 || {
    printf '%s\n' "docker is required" >&2
    exit 69
  }
  docker info >/dev/null 2>&1 || {
    printf '%s\n' "docker is not running; start Colima or Docker Desktop" >&2
    exit 69
  }
}

ensure_environment() {
  mkdir -p "$PERSIST_DIR" "$LOCALES_DIR"
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    boot_key=$(openssl rand -hex 32)
    {
      printf 'GRIST_BOOT_KEY=%s\n' "$boot_key"
      printf 'GRIST_SANDBOX_FLAVOR=pyodide\n'
      printf 'GRIST_IN_SERVICE=true\n'
    } >"$ENV_FILE"
  fi
  remove_env_key GRIST_DEFAULT_EMAIL
  set_env_value APP_HOME_URL "$PUBLIC_URL"
  set_env_value GRIST_DEFAULT_LOCALE zh-CN
  set_env_value GRIST_LOCALES_DIR /grist/custom-locales
  set_env_value GRIST_FORWARD_AUTH_HEADER X-Workbench-Email
  set_env_value GRIST_FORWARD_AUTH_LOGIN_PATH /auth/login
  set_env_value GRIST_FORWARD_AUTH_LOGOUT_PATH /auth/logout
  set_env_value GRIST_HIDE_UI_ELEMENTS automations,sendToDrive
  chmod 600 "$ENV_FILE"
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

ensure_image() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
}

ensure_locales() {
  missing=false
  for locale_file in en.client.json en.server.json zh_Hans.client.json zh_Hans.server.json; do
    if [ ! -f "$LOCALES_DIR/$locale_file" ]; then
      missing=true
    fi
  done
  if [ "$missing" = false ]; then
    return
  fi

  ensure_image
  locale_container=$(docker create "$IMAGE")
  trap 'docker rm -f "$locale_container" >/dev/null 2>&1 || true' EXIT INT TERM
  rm -f "$LOCALES_DIR"/*.json
  for locale_file in en.client.json en.server.json zh_Hans.client.json zh_Hans.server.json; do
    docker cp "$locale_container:/grist/static/locales/$locale_file" "$LOCALES_DIR/$locale_file"
  done
  docker rm "$locale_container" >/dev/null
  trap - EXIT INT TERM
}

apply_locale_overrides() {
  command -v node >/dev/null 2>&1 || {
    printf '%s\n' "node is required to prepare Grist locales" >&2
    exit 69
  }
  node "$ROOT_DIR/deploy/grist-locales.mjs" apply \
    "$LOCALES_DIR/en.client.json" \
    "$LOCALES_DIR/zh_Hans.client.json" \
    "$ROOT_DIR/deploy/grist-zh-hans-overrides.json" \
    "$LOCALES_DIR/zh_Hans.client.json"
}

container_exists() {
  docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1
}

container_running() {
  [ "$(docker container inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" = "true" ]
}

wait_until_ready() {
  url=$1
  service=$2
  host_header=${3:-}
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if [ -n "$host_header" ]; then
      ready=$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: $host_header" "$url/" 2>/dev/null || true)
    else
      ready=$(curl -sS -o /dev/null -w '%{http_code}' "$url/" 2>/dev/null || true)
    fi
    case "$ready" in
      2??|3??)
      printf '%s is ready at %s\n' "$service" "$url"
      return 0
      ;;
    esac
    attempt=$((attempt + 1))
    sleep 1
  done
  printf '%s\n' "$service did not become ready; inspect logs with: $0 logs" >&2
  return 1
}

gateway_running() {
  [ -f "$GATEWAY_PID_FILE" ] || return 1
  gateway_pid=$(cat "$GATEWAY_PID_FILE")
  kill -0 "$gateway_pid" >/dev/null 2>&1
}

start_gateway() {
  if gateway_running; then
    return
  fi
  rm -f "$GATEWAY_PID_FILE"
  if [ ! -d "$ROOT_DIR/node_modules/http-proxy" ]; then
    printf '%s\n' "Gateway dependencies are missing; run: npm install" >&2
    exit 69
  fi
  nohup "$0" gateway >>"$GATEWAY_LOG_FILE" 2>&1 &
  printf '%s\n' "$!" >"$GATEWAY_PID_FILE"
}

run_gateway() {
  if [ ! -d "$ROOT_DIR/node_modules/http-proxy" ]; then
    printf '%s\n' "Gateway dependencies are missing; run: npm install" >&2
    exit 69
  fi
  printf '%s\n' "$$" >"$GATEWAY_PID_FILE"
  GRIST_GATEWAY_HOST="$HOST" \
  GRIST_GATEWAY_PORT="$PORT" \
  GRIST_UPSTREAM="$UPSTREAM_URL" \
  WORKBENCH_ORIGIN="$WORKBENCH_ORIGIN" \
    exec node "$ROOT_DIR/apps/grist-auth-gateway/src/server.mjs"
}

stop_gateway() {
  if gateway_running; then
    gateway_pid=$(cat "$GATEWAY_PID_FILE")
    kill "$gateway_pid"
    attempt=0
    while kill -0 "$gateway_pid" >/dev/null 2>&1 && [ "$attempt" -lt 20 ]; do
      attempt=$((attempt + 1))
      sleep 0.1
    done
  fi
  rm -f "$GATEWAY_PID_FILE"
}

start() {
  require_docker
  ensure_environment
  ensure_locales
  apply_locale_overrides
  if container_running; then
    start_gateway
    wait_until_ready "$PUBLIC_URL" "Grist gateway"
    return
  fi
  if container_exists; then
    docker start "$CONTAINER_NAME" >/dev/null
  else
    ensure_image
    docker run --detach \
      --name "$CONTAINER_NAME" \
      --restart unless-stopped \
      --label com.ai-product-workbench.service=grist \
      --env-file "$ENV_FILE" \
      --publish "$HOST:$UPSTREAM_PORT:8484" \
      --volume "$PERSIST_DIR:/persist" \
      --volume "$LOCALES_DIR:/grist/custom-locales:ro" \
      "$IMAGE" >/dev/null
  fi
  public_host=$(printf '%s' "$PUBLIC_URL" | sed -E 's#^[a-z]+://([^/]+).*$#\1#')
  wait_until_ready "$UPSTREAM_URL" "Grist" "$public_host"
  start_gateway
  wait_until_ready "$PUBLIC_URL" "Grist gateway"
}

stop() {
  require_docker
  stop_gateway
  if container_exists; then
    docker stop "$CONTAINER_NAME" >/dev/null
    printf '%s\n' "Grist stopped"
  else
    printf '%s\n' "Grist container does not exist"
  fi
}

status() {
  require_docker
  if container_exists; then
    docker container inspect "$CONTAINER_NAME" \
      --format 'name={{.Name}} status={{.State.Status}} image={{.Config.Image}} started={{.State.StartedAt}}'
    docker port "$CONTAINER_NAME" 2>/dev/null || true
  else
    printf '%s\n' "Grist container does not exist"
  fi
  if gateway_running; then
    printf 'gateway=running pid=%s url=%s workbench=%s\n' \
      "$(cat "$GATEWAY_PID_FILE")" "$PUBLIC_URL" "$WORKBENCH_ORIGIN"
  else
    printf '%s\n' "gateway=stopped"
  fi
}

logs() {
  require_docker
  docker logs --tail 200 --follow "$CONTAINER_NAME"
}

gateway_logs() {
  touch "$GATEWAY_LOG_FILE"
  tail -n 200 -f "$GATEWAY_LOG_FILE"
}

recreate() {
  require_docker
  stop_gateway
  if container_exists; then
    docker rm --force "$CONTAINER_NAME" >/dev/null
  fi
  start
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  recreate) recreate ;;
  status) status ;;
  logs) logs ;;
  gateway-logs) gateway_logs ;;
  gateway) run_gateway ;;
  *)
    printf 'usage: %s {start|stop|restart|recreate|status|logs|gateway-logs|gateway}\n' "$0" >&2
    exit 64
    ;;
esac
