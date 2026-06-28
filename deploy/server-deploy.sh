#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ai-product-workbench}"

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

APP_HOST="${APP_HOST:-8.130.160.177}"
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
DEFAULT_MODEL_NAME="${DEFAULT_MODEL_NAME:-gpt-5.5}"
KNOWLEDGE_APP_PORT="${KNOWLEDGE_APP_PORT:-3001}"
KNOWLEDGE_APP_PUBLIC_URL="${KNOWLEDGE_APP_PUBLIC_URL:-http://${APP_HOST}:${KNOWLEDGE_APP_PORT}}"
WEB_ORIGIN="${WEB_ORIGIN:-$APP_PUBLIC_URL}"
QUARTZ_REF="${QUARTZ_REF:-v5}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"
QUARTZ_BASE_URL="${KNOWLEDGE_APP_PUBLIC_URL#http://}"
QUARTZ_BASE_URL="${QUARTZ_BASE_URL#https://}"
DEERFLOW_ENABLED="${DEERFLOW_ENABLED:-false}"
DEERFLOW_LANGGRAPH_URL="${DEERFLOW_LANGGRAPH_URL:-http://host.docker.internal:2024}"
DEERFLOW_GATEWAY_URL="${DEERFLOW_GATEWAY_URL:-http://host.docker.internal:8001}"
DEERFLOW_ASSISTANT_ID="${DEERFLOW_ASSISTANT_ID:-lead_agent}"
DEERFLOW_AGENT_NAME="${DEERFLOW_AGENT_NAME:-}"
DEERFLOW_STREAM_MODE="${DEERFLOW_STREAM_MODE:-messages,values}"
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

fail_if_weak "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD"
fail_if_weak "JWT_SECRET" "$JWT_SECRET"
fail_if_weak "MODEL_GATEWAY_ENCRYPTION_KEY" "$MODEL_GATEWAY_ENCRYPTION_KEY"

if [ "${DEERFLOW_ENABLED}" != "true" ]; then
  echo "WARNING: DEERFLOW_ENABLED 非 true，自然语言→PRD→原型链路将不可用（仅返回停用文案）。" >&2
fi

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
fi

docker rm -f ai-product-workbench-web ai-product-workbench-api ai-product-knowledge >/dev/null 2>&1 || true

if ! docker ps -a --format '{{.Names}}' | grep -qx ai-product-workbench-postgres; then
  docker run -d \
    --name ai-product-workbench-postgres \
    --restart unless-stopped \
    --network ai-product-workbench \
    -e POSTGRES_DB=ai_product_workbench \
    -e POSTGRES_USER=ai_workbench \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    -v ai-product-workbench-postgres:/var/lib/postgresql/data \
    "$POSTGRES_IMAGE"
elif ! docker ps --format '{{.Names}}' | grep -qx ai-product-workbench-postgres; then
  docker start ai-product-workbench-postgres >/dev/null
fi

until docker exec ai-product-workbench-postgres pg_isready -U ai_workbench -d ai_product_workbench >/dev/null 2>&1; do
  sleep 2
done

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

docker build \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  -f apps/api/Dockerfile \
  -t ai-product-workbench-api:latest .
docker build \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg NEXT_PUBLIC_API_BASE_URL="$API_PUBLIC_BASE_URL" \
  --build-arg NEXT_PUBLIC_KNOWLEDGE_APP_URL="$KNOWLEDGE_APP_PUBLIC_URL" \
  -f apps/web/Dockerfile \
  -t ai-product-workbench-web:latest .
docker build \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg QUARTZ_REF="$QUARTZ_REF" \
  -f apps/knowledge/Dockerfile \
  -t ai-product-knowledge:latest .

docker run -d \
  --name ai-product-workbench-api \
  --restart unless-stopped \
  --network ai-product-workbench \
  -p 4000:4000 \
  -e DATABASE_URL="postgresql://ai_workbench:${POSTGRES_PASSWORD}@ai-product-workbench-postgres:5432/ai_product_workbench?schema=public" \
  -e JWT_SECRET="$JWT_SECRET" \
  -e JWT_EXPIRES_IN="$JWT_EXPIRES_IN" \
  -e AUTH_COOKIE_SECURE="$AUTH_COOKIE_SECURE" \
  -e AUTH_COOKIE_SAME_SITE="$AUTH_COOKIE_SAME_SITE" \
  -e FORCE_HTTPS="$FORCE_HTTPS" \
  -e MODEL_GATEWAY_ENCRYPTION_KEY="$MODEL_GATEWAY_ENCRYPTION_KEY" \
  -e MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER="$MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER" \
  -e MODEL_GATEWAY_HIDE_DISABLED_PROVIDERS="$MODEL_GATEWAY_HIDE_DISABLED_PROVIDERS" \
  -e KNOWLEDGE_VAULT_ROOT=/app/apps/api/storage/knowledge-vault \
  -e DEFAULT_MODEL_PROVIDER_NAME="$DEFAULT_MODEL_PROVIDER_NAME" \
  -e DEFAULT_MODEL_BASE_URL="$DEFAULT_MODEL_BASE_URL" \
  -e DEFAULT_MODEL_API_KEY="$DEFAULT_MODEL_API_KEY" \
  -e DEFAULT_MODEL_NAME="$DEFAULT_MODEL_NAME" \
  -e API_PORT=4000 \
  -e WEB_ORIGIN="$WEB_ORIGIN" \
  -e FILE_UPLOAD_ROOT=/app/apps/api/storage/uploads \
  -e DEERFLOW_ENABLED="$DEERFLOW_ENABLED" \
  -e DEERFLOW_LANGGRAPH_URL="$DEERFLOW_LANGGRAPH_URL" \
  -e DEERFLOW_GATEWAY_URL="$DEERFLOW_GATEWAY_URL" \
  -e DEERFLOW_ASSISTANT_ID="$DEERFLOW_ASSISTANT_ID" \
  -e DEERFLOW_AGENT_NAME="$DEERFLOW_AGENT_NAME" \
  -e DEERFLOW_STREAM_MODE="$DEERFLOW_STREAM_MODE" \
  -e DEERFLOW_PLAN_MODE="$DEERFLOW_PLAN_MODE" \
  -e DEERFLOW_THINKING_ENABLED="$DEERFLOW_THINKING_ENABLED" \
  -e DEERFLOW_SUBAGENT_ENABLED="$DEERFLOW_SUBAGENT_ENABLED" \
  -e DEERFLOW_MAX_CONCURRENT_SUBAGENTS="$DEERFLOW_MAX_CONCURRENT_SUBAGENTS" \
  -e DEERFLOW_TIMEOUT_MS="$DEERFLOW_TIMEOUT_MS" \
  -e DEERFLOW_UPLOADS_ENABLED="$DEERFLOW_UPLOADS_ENABLED" \
  -e DEERFLOW_ARTIFACT_MAX_INLINE_BYTES="$DEERFLOW_ARTIFACT_MAX_INLINE_BYTES" \
  --add-host host.docker.internal:host-gateway \
  -v ai-product-workbench-storage:/app/apps/api/storage \
  ai-product-workbench-api:latest

docker run -d \
  --name ai-product-workbench-web \
  --restart unless-stopped \
  --network ai-product-workbench \
  -p 3000:3000 \
  -e NEXT_PUBLIC_API_BASE_URL="$API_PUBLIC_BASE_URL" \
  -e NEXT_PUBLIC_KNOWLEDGE_APP_URL="$KNOWLEDGE_APP_PUBLIC_URL" \
  ai-product-workbench-web:latest

STORAGE_MOUNT="$(docker volume inspect ai-product-workbench-storage -f '{{ .Mountpoint }}')"
mkdir -p "${STORAGE_MOUNT}/knowledge-vault"

docker run -d \
  --name ai-product-knowledge \
  --restart unless-stopped \
  --network ai-product-workbench \
  -p "${KNOWLEDGE_APP_PORT}:3000" \
  -e QUARTZ_BASE_URL="$QUARTZ_BASE_URL" \
  -e QUARTZ_CONTENT_DIR=/storage/knowledge-vault \
  -e QUARTZ_CONCURRENCY="${QUARTZ_CONCURRENCY:-2}" \
  -v ai-product-workbench-storage:/storage \
  ai-product-knowledge:latest

wait_for_http "http://127.0.0.1:4000/api/system/health" "API"
wait_for_http "http://127.0.0.1:3000/login" "Web"
wait_for_http "http://127.0.0.1:${KNOWLEDGE_APP_PORT}/__health" "Knowledge app"

echo "Deployed:"
echo "  Web: ${APP_PUBLIC_URL}/login"
echo "  API: ${API_PUBLIC_BASE_URL%/}/system/health"
echo "  Knowledge: ${KNOWLEDGE_APP_PUBLIC_URL}"
