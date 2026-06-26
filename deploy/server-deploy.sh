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
APP_PUBLIC_URL="${APP_PUBLIC_URL:-http://${APP_HOST}:3000}"
API_PUBLIC_BASE_URL="${API_PUBLIC_BASE_URL:-http://${APP_HOST}:4000/api}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ai_workbench}"
JWT_SECRET="${JWT_SECRET:-dev-ai-product-workbench-secret-change-before-production}"
JWT_EXPIRES_IN="${JWT_EXPIRES_IN:-7d}"
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

cd "$APP_DIR"

if [ "${SKIP_GIT_PULL:-0}" != "1" ] && [ -d .git ]; then
  git fetch origin main
  git checkout main
  git reset --hard origin/main
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
    if curl --fail --silent "$url" >/dev/null; then
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
