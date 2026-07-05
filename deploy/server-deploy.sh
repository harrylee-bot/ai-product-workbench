#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ai-product-workbench}"
DEPLOY_TARGET="${DEPLOY_TARGET:-all}"

if [ -f "${APP_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${APP_DIR}/.env"
  set +a
fi

DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/ai-product-workbench-deploy.lock}"
if [ "${DEPLOY_LOCK_DISABLED:-0}" != "1" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$DEPLOY_LOCK_FILE"
  if ! flock -n 9; then
    echo "Another deployment is already running. Lock: ${DEPLOY_LOCK_FILE}" >&2
    exit 75
  fi
fi

# The production host does not install Docker buildx. Keep Compose on the
# classic builder by default so every deploy does not emit a misleading Bake
# warning. Operators can still opt in with COMPOSE_BAKE=true after installing
# buildx.
COMPOSE_BAKE="${COMPOSE_BAKE:-false}"

APP_HOST="${APP_HOST:-}"
if [ -z "$APP_HOST" ]; then
  echo "APP_HOST is required. Example: APP_HOST=example.com bash deploy/server-deploy.sh" >&2
  exit 64
fi
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
APP_PUBLIC_URL="${APP_PUBLIC_URL:-http://${APP_HOST}:3000}"
API_PUBLIC_BASE_URL="${API_PUBLIC_BASE_URL:-http://${APP_HOST}:4000/api}"
if [[ "$APP_PUBLIC_URL" == https://* ]]; then
  DEFAULT_FORCE_HTTPS=true
  DEFAULT_AUTH_COOKIE_SECURE=true
else
  DEFAULT_FORCE_HTTPS=false
  DEFAULT_AUTH_COOKIE_SECURE=false
fi
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
JWT_SECRET="${JWT_SECRET:-}"
JWT_EXPIRES_IN="${JWT_EXPIRES_IN:-7d}"
AUTH_COOKIE_SECURE="${AUTH_COOKIE_SECURE:-$DEFAULT_AUTH_COOKIE_SECURE}"
AUTH_COOKIE_SAME_SITE="${AUTH_COOKIE_SAME_SITE:-lax}"
FORCE_HTTPS="${FORCE_HTTPS:-$DEFAULT_FORCE_HTTPS}"
MODEL_GATEWAY_ENCRYPTION_KEY="${MODEL_GATEWAY_ENCRYPTION_KEY:-}"
MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER="${MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER:-true}"
MODEL_GATEWAY_HIDE_DISABLED_PROVIDERS="${MODEL_GATEWAY_HIDE_DISABLED_PROVIDERS:-true}"
DEFAULT_MODEL_PROVIDER_NAME="${DEFAULT_MODEL_PROVIDER_NAME:-datatoken}"
DEFAULT_MODEL_BASE_URL="${DEFAULT_MODEL_BASE_URL:-https://datatoken.shop}"
DEFAULT_MODEL_API_KEY="${DEFAULT_MODEL_API_KEY:-}"
DEFAULT_MODEL_NAME="${DEFAULT_MODEL_NAME:-}"
KNOWLEDGE_APP_PORT="${KNOWLEDGE_APP_PORT:-3001}"
KNOWLEDGE_APP_PUBLIC_URL="${KNOWLEDGE_APP_PUBLIC_URL:-http://${APP_HOST}:${KNOWLEDGE_APP_PORT}}"
WEB_ORIGIN="${WEB_ORIGIN:-$APP_PUBLIC_URL}"
QUARTZ_REF="${QUARTZ_REF:-v5.0.0}"
QUARTZ_COMMIT="${QUARTZ_COMMIT:-ab346fa66a895e12d63a308e70ce330ba795822a}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"
QUARTZ_BASE_URL="${KNOWLEDGE_APP_PUBLIC_URL#http://}"
QUARTZ_BASE_URL="${QUARTZ_BASE_URL#https://}"
DEERFLOW_ENABLED="${DEERFLOW_ENABLED:-false}"
DEERFLOW_GATEWAY_URL="${DEERFLOW_GATEWAY_URL:-http://host.docker.internal:8001}"
DEERFLOW_LANGGRAPH_URL="${DEERFLOW_LANGGRAPH_URL:-${DEERFLOW_GATEWAY_URL}/api}"
DEERFLOW_ASSISTANT_ID="${DEERFLOW_ASSISTANT_ID:-lead_agent}"
DEERFLOW_AGENT_NAME="${DEERFLOW_AGENT_NAME:-}"
DEERFLOW_MODEL_NAME="${DEERFLOW_MODEL_NAME:-}"
DEERFLOW_STREAM_MODE="${DEERFLOW_STREAM_MODE:-messages,values}"
DEERFLOW_INTERNAL_AUTH_TOKEN="${DEERFLOW_INTERNAL_AUTH_TOKEN:-}"
DEERFLOW_PLAN_MODE="${DEERFLOW_PLAN_MODE:-true}"
DEERFLOW_THINKING_ENABLED="${DEERFLOW_THINKING_ENABLED:-true}"
DEERFLOW_SUBAGENT_ENABLED="${DEERFLOW_SUBAGENT_ENABLED:-true}"
DEERFLOW_MAX_CONCURRENT_SUBAGENTS="${DEERFLOW_MAX_CONCURRENT_SUBAGENTS:-3}"
DEERFLOW_TIMEOUT_MS="${DEERFLOW_TIMEOUT_MS:-600000}"
DEERFLOW_UPLOADS_ENABLED="${DEERFLOW_UPLOADS_ENABLED:-true}"
DEERFLOW_ARTIFACT_MAX_INLINE_BYTES="${DEERFLOW_ARTIFACT_MAX_INLINE_BYTES:-2000000}"

# ===== 启动期密钥 fail-fast：拒绝以弱默认/空密钥部署生产 =====
WEAK_SECRET_MARKERS="replace-with|change-me|change-before-production|dev-ai-product-workbench|ai_workbench"

is_weak_secret() {
  local value="$1"
  if [ -z "$value" ]; then return 0; fi
  if echo "$value" | grep -qiE "$WEAK_SECRET_MARKERS"; then return 0; fi
  return 1
}

fail_if_weak() {
  local name="$1"
  local value="$2"
  if is_weak_secret "$value"; then
    echo "ERROR: ${name} 未设置或为弱默认值。请在 ${APP_DIR}/.env 中配置强随机值后再部署。" >&2
    echo "  生成 JWT_SECRET / MODEL_GATEWAY_ENCRYPTION_KEY 示例：openssl rand -base64 32" >&2
    exit 1
  fi
}

case "$DEPLOY_TARGET" in
  all | api)
    fail_if_weak "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD"
    fail_if_weak "JWT_SECRET" "$JWT_SECRET"
    fail_if_weak "MODEL_GATEWAY_ENCRYPTION_KEY" "$MODEL_GATEWAY_ENCRYPTION_KEY"

    if [ "${DEERFLOW_ENABLED}" != "true" ]; then
      echo "WARNING: DEERFLOW_ENABLED 非 true，自然语言→PRD→原型链路将不可用（仅返回停用文案）。" >&2
    fi
    ;;
  postgres)
    fail_if_weak "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD"
    ;;
  web | knowledge)
    ;;
  *)
    echo "ERROR: DEPLOY_TARGET must be one of: all, web, api, knowledge, postgres" >&2
    exit 2
    ;;
esac

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempt

  for attempt in $(seq 1 60); do
    if curl --fail --silent -H "x-forwarded-proto: https" "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done

  echo "${label} did not become ready: ${url}" >&2
  return 1
}

export NODE_IMAGE
export POSTGRES_IMAGE
export POSTGRES_PASSWORD
export JWT_SECRET
export JWT_EXPIRES_IN
export AUTH_COOKIE_SECURE
export AUTH_COOKIE_SAME_SITE
export FORCE_HTTPS
export MODEL_GATEWAY_ENCRYPTION_KEY
export MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER
export MODEL_GATEWAY_HIDE_DISABLED_PROVIDERS
export DEFAULT_MODEL_PROVIDER_NAME
export DEFAULT_MODEL_BASE_URL
export DEFAULT_MODEL_API_KEY
export DEFAULT_MODEL_NAME
export WEB_ORIGIN
export DEERFLOW_ENABLED
export DEERFLOW_LANGGRAPH_URL
export DEERFLOW_GATEWAY_URL
export DEERFLOW_ASSISTANT_ID
export DEERFLOW_AGENT_NAME
export DEERFLOW_MODEL_NAME
export DEERFLOW_STREAM_MODE
export DEERFLOW_INTERNAL_AUTH_TOKEN
export DEERFLOW_PLAN_MODE
export DEERFLOW_THINKING_ENABLED
export DEERFLOW_SUBAGENT_ENABLED
export DEERFLOW_MAX_CONCURRENT_SUBAGENTS
export DEERFLOW_TIMEOUT_MS
export DEERFLOW_UPLOADS_ENABLED
export DEERFLOW_ARTIFACT_MAX_INLINE_BYTES
export KNOWLEDGE_APP_PORT
export QUARTZ_REF
export QUARTZ_COMMIT
export QUARTZ_BASE_URL
export COMPOSE_BAKE
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-$API_PUBLIC_BASE_URL}"
export NEXT_PUBLIC_KNOWLEDGE_APP_URL="${NEXT_PUBLIC_KNOWLEDGE_APP_URL:-$KNOWLEDGE_APP_PUBLIC_URL}"

cd "$APP_DIR"

if [ "${SKIP_GIT_PULL:-0}" != "1" ] && [ -d .git ]; then
  git fetch origin "$DEPLOY_BRANCH"
  git checkout "$DEPLOY_BRANCH"
  git reset --hard "origin/${DEPLOY_BRANCH}"
else
  echo "Using code already present in ${APP_DIR}"
fi

docker network create ai-product-workbench >/dev/null 2>&1 || true
docker volume create ai-product-workbench-postgres >/dev/null
docker volume create ai-product-workbench-storage >/dev/null

if [ "${PRUNE_DOCKER_BEFORE_BUILD:-1}" != "0" ]; then
  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
fi

COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.yml)

ensure_storage_dirs() {
  local storage_mount
  storage_mount="$(docker volume inspect ai-product-workbench-storage -f '{{ .Mountpoint }}')"
  mkdir -p "${storage_mount}/knowledge-vault"
}

wait_for_postgres() {
  local attempt
  for attempt in $(seq 1 60); do
    if "${COMPOSE[@]}" exec -T postgres pg_isready -U ai_workbench -d ai_product_workbench >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "Postgres did not become ready" >&2
  return 1
}

remove_existing_container_outside_compose() {
  local container_name="$1"
  local compose_project

  if ! docker ps -a --format '{{ .Names }}' | grep -qx "$container_name"; then
    return 0
  fi

  compose_project="$(
    docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container_name" 2>/dev/null || true
  )"
  if [ "$compose_project" != "ai-product-workbench" ]; then
    echo "Removing pre-existing container outside current compose project: ${container_name}"
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  fi
}

case "$DEPLOY_TARGET" in
  web)
    "${COMPOSE[@]}" build web
    remove_existing_container_outside_compose ai-product-workbench-web
    "${COMPOSE[@]}" up -d --no-deps web
    wait_for_http "http://127.0.0.1:3000/login" "Web"
    ;;
  api)
    "${COMPOSE[@]}" build api
    remove_existing_container_outside_compose ai-product-workbench-api
    "${COMPOSE[@]}" up -d --no-deps api
    wait_for_http "http://127.0.0.1:4000/api/system/health" "API"
    ;;
  knowledge)
    ensure_storage_dirs
    "${COMPOSE[@]}" build knowledge
    remove_existing_container_outside_compose ai-product-knowledge
    "${COMPOSE[@]}" up -d --no-deps knowledge
    wait_for_http "http://127.0.0.1:${KNOWLEDGE_APP_PORT}/__health" "Knowledge app"
    ;;
  postgres)
    remove_existing_container_outside_compose ai-product-workbench-postgres
    "${COMPOSE[@]}" up -d --no-deps postgres
    wait_for_postgres
    ;;
  all)
    ensure_storage_dirs
    remove_existing_container_outside_compose ai-product-workbench-postgres
    remove_existing_container_outside_compose ai-product-workbench-api
    remove_existing_container_outside_compose ai-product-workbench-web
    remove_existing_container_outside_compose ai-product-knowledge
    "${COMPOSE[@]}" up -d --build
    wait_for_postgres
    wait_for_http "http://127.0.0.1:4000/api/system/health" "API"
    wait_for_http "http://127.0.0.1:3000/login" "Web"
    wait_for_http "http://127.0.0.1:${KNOWLEDGE_APP_PORT}/__health" "Knowledge app"
    ;;
esac

echo "Deployed:"
echo "  Web: ${APP_PUBLIC_URL}/login"
echo "  API: ${API_PUBLIC_BASE_URL%/}/system/health"
echo "  Knowledge: ${KNOWLEDGE_APP_PUBLIC_URL}"

if [ "${PRUNE_DOCKER_AFTER_DEPLOY:-1}" != "0" ]; then
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
fi
