#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
ENV_FILE="${WORKBENCH_ENV_FILE:-${APP_DIR}/deploy/workbench.env}"
COMPOSE_FILE="${WORKBENCH_COMPOSE_FILE:-${APP_DIR}/deploy/workbench-compose.yml}"
COMPOSE_OVERLAY="${WORKBENCH_COMPOSE_OVERLAY:-}"
COMPOSE_PROFILES="${WORKBENCH_COMPOSE_PROFILES:-}"
DEERFLOW_COMPOSE_FILE="${WORKBENCH_DEERFLOW_COMPOSE_FILE:-${APP_DIR}/deploy/deerflow-runtime-compose.yml}"
DEERFLOW_PREFLIGHT_SCRIPT="${WORKBENCH_DEERFLOW_PREFLIGHT_SCRIPT:-${APP_DIR}/deploy/deerflow-production-preflight.sh}"
MANAGE_DEERFLOW_RUNTIME="${WORKBENCH_MANAGE_DEERFLOW_RUNTIME:-1}"
IMAGE_MODE="${WORKBENCH_DEPLOY_IMAGE_MODE:-pinned}"
if [ -n "${WORKBENCH_PREFLIGHT_SCRIPT:-}" ]; then
  PREFLIGHT_SCRIPT="$WORKBENCH_PREFLIGHT_SCRIPT"
elif [ "$IMAGE_MODE" = "build" ]; then
  PREFLIGHT_SCRIPT="$APP_DIR/deploy/workbench-server-preflight.sh"
else
  PREFLIGHT_SCRIPT="$APP_DIR/deploy/workbench-production-preflight.sh"
fi
DEPLOY_TARGET="${DEPLOY_TARGET:-all}"
case "$DEPLOY_TARGET" in
  stop | rollback) SKIP_PREFLIGHT=1 ;;
  *) SKIP_PREFLIGHT=0 ;;
esac
HEALTH_TIMEOUT_SECONDS="${WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS:-300}"
LOCK_FILE="${WORKBENCH_DEPLOY_LOCK_FILE:-/tmp/workbench-deploy.lock}"
ROLLBACK_ON_FAILURE="${WORKBENCH_DEPLOY_ROLLBACK_ON_FAILURE:-1}"
ROLLBACK_ENV_FILE="${WORKBENCH_ROLLBACK_ENV_FILE:-}"
ROLLBACK_COMPOSE_FILE="${WORKBENCH_ROLLBACK_COMPOSE_FILE:-$COMPOSE_FILE}"

deployment_mutated=0
clean_host=0
existing_workbench_services=""
existing_deerflow_services=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is missing: $1" >&2
    exit 69
  fi
}

wait_for_services() {
  local service
  for service in "$@"; do
    wait_for_service "$service"
  done
}

wait_for_service() {
  local service="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local container_id=""
  local status=""

  while [ "$SECONDS" -lt "$deadline" ]; do
    container_id="$("${COMPOSE[@]}" ps -q "$service")"
    if [ -n "$container_id" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      case "$status" in
        healthy | running)
          echo "Service ready: $service ($status)"
          return 0
          ;;
        unhealthy | exited | dead)
          echo "Service failed before readiness: $service ($status)" >&2
          "${COMPOSE[@]}" logs --tail 100 "$service" >&2 || true
          return 1
          ;;
      esac
    fi
    sleep 2
  done

  echo "Service readiness timed out: $service (last status: ${status:-missing})" >&2
  "${COMPOSE[@]}" logs --tail 100 "$service" >&2 || true
  return 1
}

wait_for_deerflow() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local container_id=""
  local status=""

  while [ "$SECONDS" -lt "$deadline" ]; do
    container_id="$("${DEERFLOW_COMPOSE[@]}" ps -q deerflow)"
    if [ -n "$container_id" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      case "$status" in
        healthy)
          echo "Service ready: deerflow ($status)"
          return 0
          ;;
        unhealthy | exited | dead)
          echo "Service failed before readiness: deerflow ($status)" >&2
          "${DEERFLOW_COMPOSE[@]}" logs --tail 100 deerflow >&2 || true
          return 1
          ;;
      esac
    fi
    sleep 2
  done

  echo "Service readiness timed out: deerflow (last status: ${status:-missing})" >&2
  "${DEERFLOW_COMPOSE[@]}" logs --tail 100 deerflow >&2 || true
  return 1
}

rollback_clean_host() {
  local status="$1"
  [ "$ROLLBACK_ON_FAILURE" = "1" ] || return 0
  [ "$clean_host" = "1" ] || {
    echo "Deployment failed after an existing stack was detected; automatic rollback is disabled. Re-run with WORKBENCH_ROLLBACK_ENV_FILE set to the last signed candidate." >&2
    return 0
  }
  [ "$deployment_mutated" = "1" ] || return 0
  echo "Deployment failed on a clean host; removing partially started services." >&2
  "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
    WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
  return "$status"
}

on_deploy_error() {
  local status=$?
  trap - ERR
  rollback_clean_host "$status" || true
  exit "$status"
}

env_file_value() {
  local file="$1"
  local key="$2"
  local count
  count="$(grep -c "^${key}=" "$file" || true)"
  if [ "$count" -ne 1 ]; then
    echo "$key must occur exactly once in $file" >&2
    exit 65
  fi
  sed -n "s/^${key}=//p" "$file"
}

env_value() {
  env_file_value "$ENV_FILE" "$1"
}

rollback_env_value() {
  env_file_value "$ROLLBACK_ENV_FILE" "$1" | sed -e 's/^"//' -e 's/"$//'
}

assert_image_mode() {
  case "$IMAGE_MODE" in
    pinned | build) ;;
    *) echo "WORKBENCH_DEPLOY_IMAGE_MODE must be pinned or build" >&2; exit 64 ;;
  esac
  case "$ROLLBACK_ON_FAILURE" in
    0 | 1) ;;
    *) echo "WORKBENCH_DEPLOY_ROLLBACK_ON_FAILURE must be 0 or 1" >&2; exit 64 ;;
  esac
}

prepare_deerflow_runtime() {
  local base_config effective_config runtime_home image_ref internal_network host_port existing_id current_id
  base_config="$(env_value WORKBENCH_DEERFLOW_BASE_CONFIG_PATH)"
  effective_config="$(env_value DEER_FLOW_CONFIG_PATH)"
  runtime_home="$(env_value DEER_FLOW_HOME)"
  image_ref="$(env_value WORKBENCH_DEERFLOW_IMAGE_REF)"
  internal_network="$(env_value WORKBENCH_INTERNAL_NETWORK_NAME)"
  host_port="$(env_value WORKBENCH_DEERFLOW_HOST_PORT)"

  mkdir -p "$runtime_home" "$(dirname "$effective_config")"
  node "$APP_DIR/scripts/merge-deerflow-config.mjs" \
    --base "$base_config" \
    --fragment "$APP_DIR/integrations/deerflow/runtime-tools/config.fragment.yaml" \
    --output "$effective_config"

  if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
    docker pull "$image_ref"
  fi
  docker network inspect "$internal_network" >/dev/null 2>&1 \
    || { echo "Workbench internal network was not created: $internal_network" >&2; return 1; }
  WORKBENCH_APP_DIR="$APP_DIR" \
    WORKBENCH_ENV_FILE="$ENV_FILE" \
    WORKBENCH_DEERFLOW_COMPOSE_FILE="$DEERFLOW_COMPOSE_FILE" \
    "$DEERFLOW_PREFLIGHT_SCRIPT"
  current_id="$("${DEERFLOW_COMPOSE[@]}" ps -q deerflow 2>/dev/null || true)"
  existing_id="$(docker ps --filter "publish=$host_port" --format '{{.ID}}' | head -n 1)"
  if [ -n "$existing_id" ] && [ "$existing_id" != "$current_id" ]; then
    echo "DeerFlow host port $host_port is already occupied by container $existing_id; stop the old runtime before cutover." >&2
    return 1
  fi
  WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" up -d --no-build --force-recreate deerflow
  wait_for_deerflow
}

require_command docker
assert_image_mode
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose v2 is required" >&2
  exit 69
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Workbench environment file is missing: $ENV_FILE" >&2
  echo "Create it from deploy/workbench.env.example and provide production values." >&2
  exit 66
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Workbench Compose file is missing: $COMPOSE_FILE" >&2
  exit 66
fi
if [ -n "$COMPOSE_OVERLAY" ] && [ ! -f "$COMPOSE_OVERLAY" ]; then
  echo "Workbench Compose overlay is missing: $COMPOSE_OVERLAY" >&2
  exit 66
fi
case "$MANAGE_DEERFLOW_RUNTIME" in
  0 | 1) ;;
  *) echo "WORKBENCH_MANAGE_DEERFLOW_RUNTIME must be 0 or 1" >&2; exit 64 ;;
esac
if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
  [ -f "$DEERFLOW_COMPOSE_FILE" ] || { echo "DeerFlow Compose file is missing: $DEERFLOW_COMPOSE_FILE" >&2; exit 66; }
  [ -x "$DEERFLOW_PREFLIGHT_SCRIPT" ] || { echo "DeerFlow preflight is missing or not executable: $DEERFLOW_PREFLIGHT_SCRIPT" >&2; exit 66; }
fi
if [ "$SKIP_PREFLIGHT" = "0" ] && [ "$IMAGE_MODE" = "pinned" ]; then
  image_inventory_path="$(env_value WORKBENCH_IMAGE_INVENTORY_PATH)"
  image_inventory_bundle_path="$(env_value WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH)"
  cosign_identity="$(env_value WORKBENCH_COSIGN_CERTIFICATE_IDENTITY)"
  cosign_issuer="$(env_value WORKBENCH_COSIGN_OIDC_ISSUER)"
  source_commit="$(env_value WORKBENCH_SOURCE_COMMIT)"
  [ -f "$image_inventory_path" ] || { echo "Signed production image inventory is missing: $image_inventory_path" >&2; exit 66; }
  [ -f "$image_inventory_bundle_path" ] || { echo "Production image inventory signature bundle is missing: $image_inventory_bundle_path" >&2; exit 66; }
  require_command cosign
  node "$APP_DIR/scripts/production-image-inventory.mjs" \
    --manifest "$image_inventory_path" \
    --bundle "$image_inventory_bundle_path" \
    --certificate-identity "$cosign_identity" \
    --certificate-oidc-issuer "$cosign_issuer" \
    --expected-commit "$source_commit" \
    --env-file "$ENV_FILE"
fi
if [ "$SKIP_PREFLIGHT" = "0" ] && [ "$IMAGE_MODE" = "build" ] && [ -z "$COMPOSE_OVERLAY" ]; then
  echo "Workbench validation build requires WORKBENCH_COMPOSE_OVERLAY" >&2
  exit 66
fi
if [ "$SKIP_PREFLIGHT" = "0" ] && [ "$IMAGE_MODE" = "pinned" ] && [ -n "$COMPOSE_OVERLAY" ]; then
  echo "Production pinned deployment must use the base greenfield Compose without a validation overlay" >&2
  exit 66
fi
if [ "$SKIP_PREFLIGHT" = "0" ] && [ -n "$PREFLIGHT_SCRIPT" ] && [ ! -x "$PREFLIGHT_SCRIPT" ]; then
  echo "Workbench preflight is missing or not executable: $PREFLIGHT_SCRIPT" >&2
  exit 66
fi
if ! [[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 64
fi

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "Another Workbench deployment owns $LOCK_FILE" >&2
    exit 75
  fi
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
if [ -n "$COMPOSE_OVERLAY" ]; then
  COMPOSE+=(-f "$COMPOSE_OVERLAY")
fi
for profile in $COMPOSE_PROFILES; do
  COMPOSE+=(--profile "$profile")
done
DEERFLOW_COMPOSE=(docker compose --project-directory "$APP_DIR/deploy" --env-file "$ENV_FILE" -f "$DEERFLOW_COMPOSE_FILE")

cd "$APP_DIR"
existing_workbench_services="$("${COMPOSE[@]}" ps -q 2>/dev/null || true)"
existing_deerflow_services="$("${DEERFLOW_COMPOSE[@]}" ps -q deerflow 2>/dev/null || true)"
if [ -z "$existing_workbench_services" ] && [ -z "$existing_deerflow_services" ]; then
  clean_host=1
fi
trap on_deploy_error ERR

if [ "$SKIP_PREFLIGHT" = "0" ] && [ "$IMAGE_MODE" = "pinned" ]; then
  # Pulling an already loaded digest is idempotent; mutable local build tags
  # are never selected by the production path.
  "${COMPOSE[@]}" pull --quiet
fi

compose_up() {
  local -a options=(-d --remove-orphans)
  if [ "$IMAGE_MODE" = "build" ]; then
    options+=(--build)
  else
    options+=(--no-build)
  fi
  "${COMPOSE[@]}" up "${options[@]}" "$@"
}

compose_up_force_recreate() {
  # Nginx resolves Docker service names when it starts. Recreate the public
  # gateway after an upstream rollout so it cannot retain a removed container
  # IP in its resolved upstream.
  "${COMPOSE[@]}" up -d --remove-orphans --no-build --force-recreate "$@"
}

if [ "$SKIP_PREFLIGHT" = "0" ] && [ -n "$PREFLIGHT_SCRIPT" ]; then
  WORKBENCH_APP_DIR="$APP_DIR" \
    WORKBENCH_ENV_FILE="$ENV_FILE" \
  WORKBENCH_COMPOSE_FILE="$COMPOSE_FILE" \
  WORKBENCH_OVERLAY_FILE="$COMPOSE_OVERLAY" \
    WORKBENCH_COMPOSE_PROFILES="$COMPOSE_PROFILES" \
    "$PREFLIGHT_SCRIPT"
fi
if [ "$SKIP_PREFLIGHT" = "0" ]; then
  "${COMPOSE[@]}" config --quiet
fi

case "$DEPLOY_TARGET" in
  all)
    deployment_mutated=1
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      "${COMPOSE[@]}" up -d postgres
      wait_for_services postgres
      prepare_deerflow_runtime
    fi
    compose_up
    if [ -n "$COMPOSE_OVERLAY" ]; then
      wait_for_services oidc object-storage clamav docling
    fi
    wait_for_services \
      workbench-api \
      workbench-web \
      workbench-worker \
      workbench-file-worker \
      workbench-import-worker \
      workbench-export-worker \
      workbench-preview \
      knowledge \
      preview-gateway \
      gateway
    compose_up_force_recreate preview-gateway gateway
    wait_for_services preview-gateway gateway
    ;;
  api)
    deployment_mutated=1
    compose_up workbench-api
    wait_for_services workbench-api
    compose_up_force_recreate gateway
    wait_for_services gateway
    ;;
  web)
    deployment_mutated=1
    compose_up workbench-web knowledge
    wait_for_services workbench-web knowledge
    compose_up_force_recreate gateway
    wait_for_services gateway
    ;;
  runtime-worker)
    deployment_mutated=1
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      "${COMPOSE[@]}" up -d postgres
      wait_for_services postgres
      prepare_deerflow_runtime
    fi
    compose_up workbench-worker
    wait_for_services workbench-worker
    ;;
  deerflow-runtime)
    deployment_mutated=1
    [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ] \
      || { echo "deerflow-runtime target requires WORKBENCH_MANAGE_DEERFLOW_RUNTIME=1" >&2; exit 64; }
    "${COMPOSE[@]}" up -d postgres
    wait_for_services postgres
    prepare_deerflow_runtime
    ;;
  stop)
    trap - ERR
    "${COMPOSE[@]}" down --remove-orphans
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" down --remove-orphans
    fi
    ;;
  rollback)
    trap - ERR
    [ -n "$ROLLBACK_ENV_FILE" ] || { echo "WORKBENCH_ROLLBACK_ENV_FILE is required for rollback" >&2; exit 64; }
    [ -f "$ROLLBACK_ENV_FILE" ] || { echo "Rollback environment file is missing: $ROLLBACK_ENV_FILE" >&2; exit 66; }
    [ -f "$ROLLBACK_COMPOSE_FILE" ] || { echo "Rollback Compose file is missing: $ROLLBACK_COMPOSE_FILE" >&2; exit 66; }
    rollback_source_commit="$(rollback_env_value WORKBENCH_SOURCE_COMMIT)"
    rollback_inventory="$(rollback_env_value WORKBENCH_IMAGE_INVENTORY_PATH)"
    rollback_inventory_bundle="$(rollback_env_value WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH)"
    rollback_cosign_identity="$(rollback_env_value WORKBENCH_COSIGN_CERTIFICATE_IDENTITY)"
    rollback_cosign_issuer="$(rollback_env_value WORKBENCH_COSIGN_OIDC_ISSUER)"
    [ -n "$rollback_source_commit" ] || { echo "Rollback environment is missing WORKBENCH_SOURCE_COMMIT" >&2; exit 65; }
    [ -f "$rollback_inventory" ] || { echo "Rollback image manifest is missing: $rollback_inventory" >&2; exit 66; }
    [ -f "$rollback_inventory_bundle" ] || { echo "Rollback image manifest signature bundle is missing: $rollback_inventory_bundle" >&2; exit 66; }
    require_command cosign
    node "$APP_DIR/scripts/production-image-inventory.mjs" \
      --manifest "$rollback_inventory" \
      --bundle "$rollback_inventory_bundle" \
      --certificate-identity "$rollback_cosign_identity" \
      --certificate-oidc-issuer "$rollback_cosign_issuer" \
      --expected-commit "$rollback_source_commit" \
      --env-file "$ROLLBACK_ENV_FILE"
    "${COMPOSE[@]}" down --remove-orphans
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" down --remove-orphans
    fi
    WORKBENCH_ENV_FILE="$ROLLBACK_ENV_FILE" \
      WORKBENCH_COMPOSE_FILE="$ROLLBACK_COMPOSE_FILE" \
      WORKBENCH_DEPLOY_IMAGE_MODE=pinned \
      DEPLOY_TARGET=all \
      WORKBENCH_DEPLOY_ROLLBACK_ON_FAILURE=0 \
      exec "$0"
    ;;
  file-worker)
    deployment_mutated=1
    compose_up workbench-file-worker
    wait_for_services workbench-file-worker
    ;;
  import-worker)
    deployment_mutated=1
    compose_up workbench-import-worker
    wait_for_services workbench-import-worker
    ;;
  export-worker)
    deployment_mutated=1
    compose_up workbench-export-worker
    wait_for_services workbench-export-worker
    ;;
  preview)
    deployment_mutated=1
    compose_up workbench-preview preview-gateway
    wait_for_services workbench-preview preview-gateway
    compose_up_force_recreate preview-gateway
    wait_for_services preview-gateway
    ;;
  knowledge)
    deployment_mutated=1
    compose_up knowledge
    wait_for_services knowledge
    compose_up_force_recreate gateway
    wait_for_services gateway
    ;;
  migrate)
    "${COMPOSE[@]}" run --rm migrate
    ;;
  *)
    echo "DEPLOY_TARGET must be one of: all, api, web, runtime-worker, deerflow-runtime, file-worker, import-worker, export-worker, preview, knowledge, migrate, stop, rollback" >&2
    exit 64
    ;;
esac

echo "产品工作台部署完成，目标: $DEPLOY_TARGET"
