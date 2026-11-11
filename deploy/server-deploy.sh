#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
ENV_FILE="${WORKBENCH_ENV_FILE:-${APP_DIR}/deploy/workbench.env}"
COMPOSE_FILE="${WORKBENCH_COMPOSE_FILE:-${APP_DIR}/deploy/workbench-compose.yml}"
DEERFLOW_COMPOSE_FILE="${WORKBENCH_DEERFLOW_COMPOSE_FILE:-${APP_DIR}/deploy/deerflow-runtime-compose.yml}"
DEERFLOW_PREFLIGHT_SCRIPT="${WORKBENCH_DEERFLOW_PREFLIGHT_SCRIPT:-${APP_DIR}/deploy/deerflow-production-preflight.sh}"
DEERFLOW_RUNTIME_UID=65532
DEERFLOW_RUNTIME_GID=65532
MANAGE_DEERFLOW_RUNTIME="${WORKBENCH_MANAGE_DEERFLOW_RUNTIME:-1}"
PREFLIGHT_SCRIPT="$APP_DIR/deploy/workbench-production-preflight.sh"
DEPLOY_TARGET="${DEPLOY_TARGET:-all}"
case "$DEPLOY_TARGET" in
  stop) SKIP_PREFLIGHT=1 ;;
  *) SKIP_PREFLIGHT=0 ;;
esac
HEALTH_TIMEOUT_SECONDS="${WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS:-300}"
LOCK_FILE="${WORKBENCH_DEPLOY_LOCK_FILE:-/tmp/workbench-deploy.lock}"
CLEANUP_ON_FAILURE="${WORKBENCH_DEPLOY_CLEANUP_ON_FAILURE:-1}"
ALLOW_RUNTIME_QUEUE_RECREATE="${WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE:-0}"
RUNTIME_QUEUE_STOP_TIMEOUT_SECONDS="${WORKBENCH_RUNTIME_QUEUE_STOP_TIMEOUT_SECONDS:-45}"
RUNTIME_QUEUE_PARTICIPANTS=(
  workbench-api
  workbench-worker
  workbench-file-worker
  workbench-import-worker
  workbench-export-worker
)

# Compose interpolation must use the per-invocation authorization. A value left
# in an env file is intentionally unable to authorize a later policy rebuild.
export WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE="$ALLOW_RUNTIME_QUEUE_RECREATE"

deployment_mutated=0
clean_host=0
existing_workbench_services=""
existing_deerflow_services=""
runtime_queue_cutover_started=0
runtime_queue_reconciled=0

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

cleanup_partial_deployment() {
  local status="$1"
  [ "$CLEANUP_ON_FAILURE" = "1" ] || return 0
  [ "$deployment_mutated" = "1" ] || return 0
  [ "$clean_host" = "1" ] || {
    echo "Deployment failed after an existing stack was detected; the active stack was left untouched." >&2
    return 0
  }
  echo "Deployment failed on a clean host; removing partially started services." >&2
  "${COMPOSE[@]}" down >/dev/null 2>&1 || true
  if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
    WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" down >/dev/null 2>&1 || true
  fi
  return "$status"
}

on_deploy_error() {
  local status=$?
  trap - ERR
  if [ "$runtime_queue_cutover_started" = "1" ] && [ "$runtime_queue_reconciled" = "0" ] && [ "$clean_host" = "0" ]; then
    echo "Runtime queue reconciliation failed closed; queue producers and consumers remain stopped." >&2
  fi
  cleanup_partial_deployment "$status" || true
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

assert_deployment_contract() {
  case "$CLEANUP_ON_FAILURE" in
    0 | 1) ;;
    *) echo "WORKBENCH_DEPLOY_CLEANUP_ON_FAILURE must be 0 or 1" >&2; exit 64 ;;
  esac
  case "$ALLOW_RUNTIME_QUEUE_RECREATE" in
    0 | 1) ;;
    *) echo "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE must be 0 or 1" >&2; exit 64 ;;
  esac
  if [ "$ALLOW_RUNTIME_QUEUE_RECREATE" = "1" ]; then
    case "$DEPLOY_TARGET" in
      all | migrate) ;;
      *)
        echo "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=1 requires DEPLOY_TARGET=all or migrate" >&2
        exit 64
        ;;
    esac
  fi
}

ensure_deerflow_image() {
  [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ] || return 0
  local image_ref
  image_ref="$(env_value WORKBENCH_DEERFLOW_IMAGE_REF)"
  if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
    docker pull "$image_ref"
  fi
}

prepare_deerflow_runtime() {
  local base_config effective_config runtime_home internal_network host_port existing_id current_id
  base_config="$(env_value WORKBENCH_DEERFLOW_BASE_CONFIG_PATH)"
  effective_config="$(env_value DEER_FLOW_CONFIG_PATH)"
  runtime_home="$(env_value DEER_FLOW_HOME)"
  internal_network="$(env_value WORKBENCH_INTERNAL_NETWORK_NAME)"
  host_port="$(env_value WORKBENCH_DEERFLOW_HOST_PORT)"

  mkdir -p "$runtime_home" "$(dirname "$effective_config")"
  node "$APP_DIR/scripts/merge-deerflow-config.mjs" \
    --base "$base_config" \
    --fragment "$APP_DIR/integrations/deerflow/runtime-tools/config.fragment.yaml" \
    --output "$effective_config"
  chown -R "$DEERFLOW_RUNTIME_UID:$DEERFLOW_RUNTIME_GID" "$runtime_home"
  chmod 0700 "$runtime_home"
  chown "$DEERFLOW_RUNTIME_UID:$DEERFLOW_RUNTIME_GID" "$effective_config"
  chmod 0600 "$effective_config"

  docker network inspect "$internal_network" >/dev/null 2>&1 \
    || { echo "Workbench internal network was not created: $internal_network" >&2; return 1; }
  WORKBENCH_APP_DIR="$APP_DIR" \
    WORKBENCH_ENV_FILE="$ENV_FILE" \
    WORKBENCH_DEERFLOW_COMPOSE_FILE="$DEERFLOW_COMPOSE_FILE" \
    "$DEERFLOW_PREFLIGHT_SCRIPT"
  current_id="$("${DEERFLOW_COMPOSE[@]}" ps -q deerflow 2>/dev/null || true)"
  existing_id="$(docker ps --filter "publish=$host_port" --no-trunc --format '{{.ID}}' | head -n 1)"
  if [ -n "$existing_id" ] && [ "$existing_id" != "$current_id" ]; then
    echo "DeerFlow host port $host_port is already occupied by container $existing_id; stop the old runtime before cutover." >&2
    return 1
  fi
  WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" up -d --no-build --force-recreate deerflow
  wait_for_deerflow
}

require_command docker
assert_deployment_contract
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
case "$MANAGE_DEERFLOW_RUNTIME" in
  0 | 1) ;;
  *) echo "WORKBENCH_MANAGE_DEERFLOW_RUNTIME must be 0 or 1" >&2; exit 64 ;;
esac
if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
  [ -f "$DEERFLOW_COMPOSE_FILE" ] || { echo "DeerFlow Compose file is missing: $DEERFLOW_COMPOSE_FILE" >&2; exit 66; }
  [ -x "$DEERFLOW_PREFLIGHT_SCRIPT" ] || { echo "DeerFlow preflight is missing or not executable: $DEERFLOW_PREFLIGHT_SCRIPT" >&2; exit 66; }
fi
if [ "$SKIP_PREFLIGHT" = "0" ] && [ -n "$PREFLIGHT_SCRIPT" ] && [ ! -x "$PREFLIGHT_SCRIPT" ]; then
  echo "Workbench preflight is missing or not executable: $PREFLIGHT_SCRIPT" >&2
  exit 66
fi
if ! [[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 64
fi
if ! [[ "$RUNTIME_QUEUE_STOP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "WORKBENCH_RUNTIME_QUEUE_STOP_TIMEOUT_SECONDS must be a positive integer" >&2
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
DEERFLOW_COMPOSE=(docker compose --project-directory "$APP_DIR/deploy" --env-file "$ENV_FILE" -f "$DEERFLOW_COMPOSE_FILE")

cd "$APP_DIR"
existing_workbench_services="$("${COMPOSE[@]}" ps -q 2>/dev/null || true)"
existing_deerflow_services="$("${DEERFLOW_COMPOSE[@]}" ps -q deerflow 2>/dev/null || true)"
if [ -z "$existing_workbench_services" ] && [ -z "$existing_deerflow_services" ]; then
  clean_host=1
fi
trap on_deploy_error ERR

compose_up() {
  "${COMPOSE[@]}" up -d --no-build "$@"
}

prepare_direct_images() {
  # Finish bounded native AMD64 builds before stopping any live queue participants.
  source "$SCRIPT_DIR/workbench-build-resources.sh"
  direct_build_images "$@"
  # Locally built images have a stable RepoDigest but no registry tag digest.
  # Bind the runtime worker to that immutable digest before Compose starts it.
  local worker_ref worker_digest temp_env
  worker_ref="$(env_value WORKBENCH_RUNTIME_WORKER_IMAGE_REF)"
  worker_digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$worker_ref" 2>/dev/null || true)"
  [ -n "$worker_digest" ] || {
    echo "Direct build did not produce a RepoDigest for WORKBENCH_RUNTIME_WORKER_IMAGE_REF=$worker_ref" >&2
    return 1
  }
  temp_env="$(mktemp "${ENV_FILE}.direct.XXXXXX")"
  awk -v replacement="WORKBENCH_RUNTIME_WORKER_IMAGE_REF=${worker_digest}" '
    BEGIN { replaced = 0 }
    /^WORKBENCH_RUNTIME_WORKER_IMAGE_REF=/ {
      if (!replaced) print replacement
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print replacement }
  ' "$ENV_FILE" > "$temp_env"
  chmod 600 "$temp_env"
  mv "$temp_env" "$ENV_FILE"
}

compose_up_force_recreate() {
  # Nginx resolves Docker service names when it starts. Recreate the public
  # gateway after an upstream rollout so it cannot retain a removed container
  # IP in its resolved upstream.
  "${COMPOSE[@]}" up -d --no-build --force-recreate "$@"
}

stop_runtime_queue_participants() {
  local service running_ids
  runtime_queue_cutover_started=1
  echo "Stopping Runtime queue producers and consumers before reconciliation."
  "${COMPOSE[@]}" stop \
    --timeout "$RUNTIME_QUEUE_STOP_TIMEOUT_SECONDS" \
    "${RUNTIME_QUEUE_PARTICIPANTS[@]}"

  for service in "${RUNTIME_QUEUE_PARTICIPANTS[@]}"; do
    running_ids="$("${COMPOSE[@]}" ps -q "$service")"
    if [ -n "$running_ids" ]; then
      echo "Runtime queue participant did not stop: $service" >&2
      return 1
    fi
  done
}

run_runtime_queue_migrator() {
  echo "Reconciling database migrations and Runtime queue policies while participants are stopped."
  "${COMPOSE[@]}" run --rm --no-deps migrate
  runtime_queue_reconciled=1
}

prepare_runtime_queue_cutover() {
  stop_runtime_queue_participants
  "${COMPOSE[@]}" up -d --no-build postgres
  wait_for_services postgres
  run_runtime_queue_migrator
}

if [ "$SKIP_PREFLIGHT" = "0" ] && [ -n "$PREFLIGHT_SCRIPT" ]; then
  WORKBENCH_APP_DIR="$APP_DIR" \
    WORKBENCH_ENV_FILE="$ENV_FILE" \
  WORKBENCH_COMPOSE_FILE="$COMPOSE_FILE" \
    "$PREFLIGHT_SCRIPT"
fi
if [ "$SKIP_PREFLIGHT" = "0" ]; then
  "${COMPOSE[@]}" config --quiet
fi

case "$DEPLOY_TARGET" in
  all)
    prepare_direct_images
    ensure_deerflow_image
    deployment_mutated=1
    prepare_runtime_queue_cutover
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      prepare_deerflow_runtime
    fi
    compose_up
    wait_for_services \
      object-storage-egress \
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
    prepare_direct_images workbench-api
    deployment_mutated=1
    compose_up workbench-api
    wait_for_services workbench-api
    compose_up_force_recreate gateway
    wait_for_services gateway
    ;;
  web)
    prepare_direct_images workbench-web knowledge
    deployment_mutated=1
    compose_up workbench-web knowledge
    wait_for_services workbench-web knowledge
    compose_up_force_recreate gateway
    wait_for_services gateway
    ;;
  runtime-worker)
    prepare_direct_images workbench-worker
    ensure_deerflow_image
    deployment_mutated=1
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      "${COMPOSE[@]}" up -d --no-build postgres
      wait_for_services postgres
      prepare_deerflow_runtime
    fi
    compose_up workbench-worker
    wait_for_services workbench-worker
    ;;
  deerflow-runtime)
    [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ] \
      || { echo "deerflow-runtime target requires WORKBENCH_MANAGE_DEERFLOW_RUNTIME=1" >&2; exit 64; }
    ensure_deerflow_image
    deployment_mutated=1
    "${COMPOSE[@]}" up -d --no-build postgres
    wait_for_services postgres
    prepare_deerflow_runtime
    ;;
  stop)
    trap - ERR
    "${COMPOSE[@]}" down
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" down
    fi
    ;;
  file-worker)
    prepare_direct_images workbench-file-worker
    deployment_mutated=1
    compose_up workbench-file-worker
    wait_for_services workbench-file-worker
    ;;
  import-worker)
    prepare_direct_images workbench-import-worker
    deployment_mutated=1
    compose_up workbench-import-worker
    wait_for_services workbench-import-worker
    ;;
  export-worker)
    prepare_direct_images workbench-export-worker
    deployment_mutated=1
    compose_up workbench-export-worker
    wait_for_services workbench-export-worker
    ;;
  preview)
    prepare_direct_images workbench-preview preview-gateway
    deployment_mutated=1
    compose_up workbench-preview preview-gateway
    wait_for_services workbench-preview preview-gateway
    compose_up_force_recreate preview-gateway
    wait_for_services preview-gateway
    ;;
  knowledge)
    prepare_direct_images knowledge
    deployment_mutated=1
    compose_up knowledge
    wait_for_services knowledge
    compose_up_force_recreate gateway
    wait_for_services gateway
    ;;
  migrate)
    prepare_direct_images migrate
    prepare_runtime_queue_cutover
    ;;
  *)
    echo "DEPLOY_TARGET must be one of: all, api, web, runtime-worker, deerflow-runtime, file-worker, import-worker, export-worker, preview, knowledge, migrate, stop" >&2
    exit 64
    ;;
esac

echo "产品工作台部署完成，目标: $DEPLOY_TARGET"
