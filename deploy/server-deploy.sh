#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ai-product-workbench}"
APP_HOST="${APP_HOST:-8.130.160.177}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ai_workbench}"
JWT_SECRET="${JWT_SECRET:-dev-ai-product-workbench-secret-change-before-production}"
JWT_EXPIRES_IN="${JWT_EXPIRES_IN:-7d}"
MODEL_GATEWAY_ENCRYPTION_KEY="${MODEL_GATEWAY_ENCRYPTION_KEY:-}"
DEFAULT_MODEL_PROVIDER_NAME="${DEFAULT_MODEL_PROVIDER_NAME:-}"
DEFAULT_MODEL_BASE_URL="${DEFAULT_MODEL_BASE_URL:-}"
DEFAULT_MODEL_API_KEY="${DEFAULT_MODEL_API_KEY:-}"
DEFAULT_MODEL_NAME="${DEFAULT_MODEL_NAME:-}"
KNOWLEDGE_APP_PORT="${KNOWLEDGE_APP_PORT:-3001}"
SILVERBULLET_IMAGE="${SILVERBULLET_IMAGE:-ghcr.io/silverbulletmd/silverbullet:v2}"
SILVERBULLET_USER="${SILVERBULLET_USER:-}"
SILVERBULLET_PASSWORD="${SILVERBULLET_PASSWORD:-}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"

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

docker rm -f ai-product-workbench-web ai-product-workbench-api >/dev/null 2>&1 || true

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
  --build-arg NEXT_PUBLIC_API_BASE_URL="http://${APP_HOST}:4000/api" \
  --build-arg NEXT_PUBLIC_KNOWLEDGE_APP_URL="http://${APP_HOST}:${KNOWLEDGE_APP_PORT}" \
  -f apps/web/Dockerfile \
  -t ai-product-workbench-web:latest .

docker run -d \
  --name ai-product-workbench-api \
  --restart unless-stopped \
  --network ai-product-workbench \
  -p 4000:4000 \
  -e DATABASE_URL="postgresql://ai_workbench:${POSTGRES_PASSWORD}@ai-product-workbench-postgres:5432/ai_product_workbench?schema=public" \
  -e JWT_SECRET="$JWT_SECRET" \
  -e JWT_EXPIRES_IN="$JWT_EXPIRES_IN" \
  -e MODEL_GATEWAY_ENCRYPTION_KEY="$MODEL_GATEWAY_ENCRYPTION_KEY" \
  -e KNOWLEDGE_VAULT_ROOT=/app/apps/api/storage/knowledge-vault \
  -e DEFAULT_MODEL_PROVIDER_NAME="$DEFAULT_MODEL_PROVIDER_NAME" \
  -e DEFAULT_MODEL_BASE_URL="$DEFAULT_MODEL_BASE_URL" \
  -e DEFAULT_MODEL_API_KEY="$DEFAULT_MODEL_API_KEY" \
  -e DEFAULT_MODEL_NAME="$DEFAULT_MODEL_NAME" \
  -e API_PORT=4000 \
  -e WEB_ORIGIN="http://${APP_HOST}:3000" \
  -e FILE_UPLOAD_ROOT=/app/apps/api/storage/uploads \
  -v ai-product-workbench-storage:/app/apps/api/storage \
  ai-product-workbench-api:latest

docker run -d \
  --name ai-product-workbench-web \
  --restart unless-stopped \
  --network ai-product-workbench \
  -p 3000:3000 \
  -e NEXT_PUBLIC_API_BASE_URL="http://${APP_HOST}:4000/api" \
  -e NEXT_PUBLIC_KNOWLEDGE_APP_URL="http://${APP_HOST}:${KNOWLEDGE_APP_PORT}" \
  ai-product-workbench-web:latest

STORAGE_MOUNT="$(docker volume inspect ai-product-workbench-storage -f '{{ .Mountpoint }}')"
mkdir -p "${STORAGE_MOUNT}/knowledge-vault"

docker rm -f ai-product-knowledge >/dev/null 2>&1 || true
SILVERBULLET_ENV_ARGS=()
if [ -n "$SILVERBULLET_USER" ] && [ -n "$SILVERBULLET_PASSWORD" ]; then
  SILVERBULLET_ENV_ARGS=(-e "SB_USER=${SILVERBULLET_USER}:${SILVERBULLET_PASSWORD}")
fi

docker run -d \
  --name ai-product-knowledge \
  --restart unless-stopped \
  --network ai-product-workbench \
  -p "${KNOWLEDGE_APP_PORT}:3000" \
  "${SILVERBULLET_ENV_ARGS[@]}" \
  -v "${STORAGE_MOUNT}/knowledge-vault:/space" \
  "$SILVERBULLET_IMAGE"

wait_for_http "http://127.0.0.1:4000/api/system/health" "API"
wait_for_http "http://127.0.0.1:3000/login" "Web"
wait_for_http "http://127.0.0.1:${KNOWLEDGE_APP_PORT}/" "Knowledge app"

echo "Deployed:"
echo "  Web: http://${APP_HOST}:3000/login"
echo "  API: http://${APP_HOST}:4000/api/system/health"
echo "  Knowledge: http://${APP_HOST}:${KNOWLEDGE_APP_PORT}"
