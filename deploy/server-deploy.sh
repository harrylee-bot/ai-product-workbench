#!/bin/bash -p
set -Eeuo pipefail

readonly WORKBENCH_TRUSTED_SYSTEM_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
script_source="${BASH_SOURCE[0]}"
case "$script_source" in
  */*) script_parent="${script_source%/*}" ;;
  *) script_parent=. ;;
esac
SCRIPT_DIR="$(cd -P -- "$script_parent" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
ENV_FILE="${WORKBENCH_ENV_FILE:-${APP_DIR}/deploy/workbench.env}"
COMPOSE_FILE="${WORKBENCH_COMPOSE_FILE:-${APP_DIR}/deploy/workbench-compose.yml}"
COMPOSE_OVERLAY="${WORKBENCH_COMPOSE_OVERLAY:-}"
COMPOSE_PROFILES="${WORKBENCH_COMPOSE_PROFILES:-}"
DEERFLOW_COMPOSE_FILE="${WORKBENCH_DEERFLOW_COMPOSE_FILE:-${APP_DIR}/deploy/deerflow-runtime-compose.yml}"
DEERFLOW_PREFLIGHT_SCRIPT="${WORKBENCH_DEERFLOW_PREFLIGHT_SCRIPT:-${APP_DIR}/deploy/deerflow-production-preflight.sh}"
RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PREPARE_SCRIPT="${WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PREPARE_SCRIPT:-${APP_DIR}/scripts/prepare-runtime-worker-execution-private-key.mjs}"
PRODUCTION_DEPLOYMENT_CONFIG_SCRIPT="${SCRIPT_DIR}/../scripts/assert-production-deployment-config.mjs"
SEALED_RELEASE_ASSERT_SCRIPT="${SCRIPT_DIR}/../scripts/assert-sealed-production-release.mjs"
DEERFLOW_RUNTIME_UID=65532
DEERFLOW_RUNTIME_GID=65532
MANAGE_DEERFLOW_RUNTIME="${WORKBENCH_MANAGE_DEERFLOW_RUNTIME:-1}"
IMAGE_MODE="${WORKBENCH_DEPLOY_IMAGE_MODE:-pinned}"
if [ "$IMAGE_MODE" = "pinned" ]; then
  if [[ "$-" != *p* ]]; then
    echo "Pinned production deployment must execute deploy/server-deploy.sh directly so /bin/bash -p is enforced" >&2
    exit 64
  fi
  PATH="$WORKBENCH_TRUSTED_SYSTEM_PATH"
  export PATH
fi
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
ROLLBACK_APP_DIR="${WORKBENCH_ROLLBACK_APP_DIR:-}"
ALLOW_RUNTIME_QUEUE_RECREATE="${WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE:-0}"
REQUESTED_RELEASE_OWNER_UID="${WORKBENCH_RELEASE_OWNER_UID:-}"
RELEASE_OWNER_UID=0
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

runtime_worker_replicas() {
  local count value
  count="$(grep -c '^WORKBENCH_RUNTIME_WORKER_REPLICAS=' "$ENV_FILE" || true)"
  if [ "$count" -eq 1 ]; then
    value="$(sed -n 's/^WORKBENCH_RUNTIME_WORKER_REPLICAS=//p' "$ENV_FILE")"
  elif [ "$count" -eq 0 ] && [ "$IMAGE_MODE" = "build" ]; then
    value=1
  else
    echo "WORKBENCH_RUNTIME_WORKER_REPLICAS must occur exactly once in $ENV_FILE" >&2
    return 1
  fi
  [[ "$value" =~ ^[1-9][0-9]*$ ]] \
    || { echo "WORKBENCH_RUNTIME_WORKER_REPLICAS must be a positive integer" >&2; return 1; }
  printf '%s' "$value"
}

wait_for_runtime_workers() {
  local expected deadline running ready id status
  expected="$(runtime_worker_replicas)"
  deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    running=0
    ready=0
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      running=$((running + 1))
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      case "$status" in
        healthy | running) ready=$((ready + 1)) ;;
        unhealthy | exited | dead)
          echo "Service failed before readiness: workbench-worker ($id: $status)" >&2
          "${COMPOSE[@]}" logs --tail 100 workbench-worker >&2 || true
          return 1
          ;;
      esac
    done < <("${COMPOSE[@]}" ps -q workbench-worker)
    if [ "$running" -eq "$expected" ] && [ "$ready" -eq "$expected" ]; then
      echo "Service ready: workbench-worker ($ready/$expected replicas)"
      return 0
    fi
    sleep 2
  done
  echo "Service readiness timed out: workbench-worker (expected $expected replicas)" >&2
  "${COMPOSE[@]}" logs --tail 100 workbench-worker >&2 || true
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
  if [ "$runtime_queue_cutover_started" = "1" ] && [ "$runtime_queue_reconciled" = "0" ] && [ "$clean_host" = "0" ]; then
    echo "Runtime queue reconciliation failed closed; queue producers and consumers remain stopped." >&2
  fi
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

assert_sealed_release() {
  local release_root="$1"
  local environment_file="$2"
  local label="$3"
  local owner_uid="$4"
  shift 4
  node "$SEALED_RELEASE_ASSERT_SCRIPT" \
    --release-root "$release_root" \
    --env-file "$environment_file" \
    --owner-uid "$owner_uid" \
    "$@" >/dev/null \
    || { echo "$label candidate is not a sealed production release" >&2; exit 65; }
}

assert_candidate_compose_file() {
  assert_candidate_source_file "$1" "$2" "deploy/workbench-compose.yml" "$3 Compose file"
}

assert_candidate_source_file() {
  local actual="$1"
  local candidate_root="$2"
  local relative_path="$3"
  local label="$4"
  local expected="$candidate_root/$relative_path"
  local actual_canonical expected_canonical
  [ -f "$actual" ] && [ ! -L "$actual" ] \
    || { echo "$label must be a regular non-symlink: $actual" >&2; exit 66; }
  [ -f "$expected" ] && [ ! -L "$expected" ] \
    || { echo "$label is missing or unsafe in the candidate: $expected" >&2; exit 66; }
  actual_canonical="$(cd -P -- "$(dirname -- "$actual")" && printf '%s/%s' "$PWD" "$(basename -- "$actual")")"
  expected_canonical="$(cd -P -- "$(dirname -- "$expected")" && printf '%s/%s' "$PWD" "$(basename -- "$expected")")"
  [ "$actual_canonical" = "$expected_canonical" ] \
    || { echo "$label must be the source-verified candidate file: $expected_canonical" >&2; exit 65; }
}

rollback_env_value() {
  env_file_value "$ROLLBACK_ENV_FILE" "$1"
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
  case "$ALLOW_RUNTIME_QUEUE_RECREATE" in
    0 | 1) ;;
    *) echo "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE must be 0 or 1" >&2; exit 64 ;;
  esac
  if [ "$ALLOW_RUNTIME_QUEUE_RECREATE" = "1" ]; then
    case "$DEPLOY_TARGET" in
      all | migrate | rollback) ;;
      *)
        echo "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=1 requires DEPLOY_TARGET=all, migrate, or rollback" >&2
        exit 64
        ;;
    esac
  fi
  if [ "$DEPLOY_TARGET" = "rollback" ] && [ "$IMAGE_MODE" != "pinned" ]; then
    echo "rollback requires WORKBENCH_DEPLOY_IMAGE_MODE=pinned" >&2
    exit 64
  fi
  if [ "$IMAGE_MODE" = "pinned" ]; then
    case "$DEPLOY_TARGET" in
      all | migrate | stop | rollback) ;;
      *)
        echo "pinned production deployment requires DEPLOY_TARGET=all, migrate, stop, or rollback" >&2
        exit 64
        ;;
    esac
  fi
  if [ "$IMAGE_MODE" = "pinned" ] && [ "$DEPLOY_TARGET" != "stop" ] && [ "$MANAGE_DEERFLOW_RUNTIME" != "1" ]; then
    echo "pinned production deployment requires WORKBENCH_MANAGE_DEERFLOW_RUNTIME=1" >&2
    exit 64
  fi
}

prepare_deerflow_runtime() {
  local base_config effective_config runtime_home image_ref internal_network host_port existing_id current_id
  local expected_base_config_sha256 expected_effective_config_sha256 actual_config_sha256
  base_config="$(env_value WORKBENCH_DEERFLOW_BASE_CONFIG_PATH)"
  expected_base_config_sha256="$(env_value WORKBENCH_DEERFLOW_BASE_CONFIG_SHA256)"
  effective_config="$(env_value DEER_FLOW_CONFIG_PATH)"
  expected_effective_config_sha256="$(env_value WORKBENCH_DEERFLOW_EFFECTIVE_CONFIG_SHA256)"
  runtime_home="$(env_value DEER_FLOW_HOME)"
  image_ref="$(env_value WORKBENCH_DEERFLOW_IMAGE_REF)"
  internal_network="$(env_value WORKBENCH_INTERNAL_NETWORK_NAME)"
  host_port="$(env_value WORKBENCH_DEERFLOW_HOST_PORT)"

  actual_config_sha256="$(sha256sum "$base_config" | awk '{print $1}')"
  [ "$actual_config_sha256" = "$expected_base_config_sha256" ] \
    || { echo "Base DeerFlow config does not match the signed SHA-256" >&2; return 1; }

  mkdir -p "$runtime_home" "$(dirname "$effective_config")"
  node "$APP_DIR/scripts/merge-deerflow-config.mjs" \
    --base "$base_config" \
    --fragment "$APP_DIR/integrations/deerflow/runtime-tools/config.fragment.yaml" \
    --output "$effective_config"
  actual_config_sha256="$(sha256sum "$effective_config" | awk '{print $1}')"
  [ "$actual_config_sha256" = "$expected_effective_config_sha256" ] \
    || { echo "Generated DeerFlow config does not match the signed SHA-256" >&2; return 1; }
  chown -R "$DEERFLOW_RUNTIME_UID:$DEERFLOW_RUNTIME_GID" "$runtime_home"
  chmod 0700 "$runtime_home"
  chown "$DEERFLOW_RUNTIME_UID:$DEERFLOW_RUNTIME_GID" "$effective_config"
  chmod 0600 "$effective_config"
  if [ "$IMAGE_MODE" = "pinned" ]; then
    assert_sealed_release "$APP_DIR" "$ENV_FILE" "Production" "$RELEASE_OWNER_UID" \
      --sealed-file "$DEERFLOW_RUNTIME_UID:$effective_config"
  fi

  if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
    docker pull "$image_ref"
  fi
  docker network inspect "$internal_network" >/dev/null 2>&1 \
    || { echo "Workbench internal network was not created: $internal_network" >&2; return 1; }
  if [ "$IMAGE_MODE" = "pinned" ]; then
    "${PINNED_COMMAND_ENV[@]}" \
      "WORKBENCH_APP_DIR=$APP_DIR" \
      "WORKBENCH_ENV_FILE=$ENV_FILE" \
      "WORKBENCH_DEERFLOW_COMPOSE_FILE=$DEERFLOW_COMPOSE_FILE" \
      "$DEERFLOW_PREFLIGHT_SCRIPT"
  else
    WORKBENCH_APP_DIR="$APP_DIR" \
      WORKBENCH_ENV_FILE="$ENV_FILE" \
      WORKBENCH_DEERFLOW_COMPOSE_FILE="$DEERFLOW_COMPOSE_FILE" \
      "$DEERFLOW_PREFLIGHT_SCRIPT"
  fi
  current_id="$("${DEERFLOW_COMPOSE[@]}" ps -q deerflow 2>/dev/null || true)"
  existing_id="$(docker ps --filter "publish=$host_port" --no-trunc --format '{{.ID}}' | head -n 1)"
  if [ -n "$existing_id" ] && [ "$existing_id" != "$current_id" ]; then
    echo "DeerFlow host port $host_port is already occupied by container $existing_id; stop the old runtime before cutover." >&2
    return 1
  fi
  WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" up -d --no-build --force-recreate deerflow
  wait_for_deerflow
}

prepare_runtime_worker_execution_private_key() {
  local private_key runtime_uid runtime_gid expected_key_id
  [ -f "$RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PREPARE_SCRIPT" ] \
    || { echo "Runtime Worker private-key preparation script is missing: $RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PREPARE_SCRIPT" >&2; exit 66; }
  private_key="$(env_value WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_HOST_PATH)"
  runtime_uid="$(env_value WORKBENCH_RUNTIME_WORKER_UID)"
  runtime_gid="$(env_value WORKBENCH_RUNTIME_WORKER_GID)"
  expected_key_id="$(env_value WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID)"
  node "$RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PREPARE_SCRIPT" \
    --private-key "$private_key" \
    --uid "$runtime_uid" \
    --gid "$runtime_gid" \
    --expected-key-id "$expected_key_id" >/dev/null
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
if [ "$IMAGE_MODE" = "pinned" ] && [ -n "$COMPOSE_OVERLAY" ]; then
  echo "Production pinned deployment must use the base greenfield Compose without a validation overlay" >&2
  exit 66
fi
if [ "$IMAGE_MODE" = "pinned" ] && [ -n "$COMPOSE_PROFILES" ]; then
  echo "Production pinned deployment must not enable Compose profiles" >&2
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
if [ "$IMAGE_MODE" = "pinned" ]; then
  RELEASE_OWNER_UID="$(env_value WORKBENCH_RELEASE_OWNER_UID)"
  if ! [[ "$RELEASE_OWNER_UID" =~ ^(0|[1-9][0-9]{0,9})$ ]]; then
    echo "WORKBENCH_RELEASE_OWNER_UID must be a numeric UID" >&2
    exit 64
  fi
  if [ -n "$REQUESTED_RELEASE_OWNER_UID" ] && [ "$REQUESTED_RELEASE_OWNER_UID" != "$RELEASE_OWNER_UID" ]; then
    echo "Process WORKBENCH_RELEASE_OWNER_UID must match the signed deployment environment" >&2
    exit 65
  fi
  assert_candidate_compose_file "$COMPOSE_FILE" "$APP_DIR" "Production"
  assert_candidate_source_file "$SCRIPT_DIR/server-deploy.sh" "$APP_DIR" "deploy/server-deploy.sh" "Production deploy script"
  assert_candidate_source_file "$SEALED_RELEASE_ASSERT_SCRIPT" "$APP_DIR" \
    "scripts/assert-sealed-production-release.mjs" "Sealed release verifier"
  assert_candidate_source_file "$PRODUCTION_DEPLOYMENT_CONFIG_SCRIPT" "$APP_DIR" \
    "scripts/assert-production-deployment-config.mjs" "Production deployment-config verifier"
  if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
    assert_candidate_source_file "$DEERFLOW_COMPOSE_FILE" "$APP_DIR" \
      "deploy/deerflow-runtime-compose.yml" "DeerFlow Compose file"
  fi
  require_command cosign
  assert_sealed_release "$APP_DIR" "$ENV_FILE" "Production" "$RELEASE_OWNER_UID"
  node "$PRODUCTION_DEPLOYMENT_CONFIG_SCRIPT" \
    --env-file "$ENV_FILE" \
    --repo-root "$APP_DIR" >/dev/null
fi
if [ "$SKIP_PREFLIGHT" = "0" ] && [ "$IMAGE_MODE" = "pinned" ]; then
  assert_candidate_source_file "$PREFLIGHT_SCRIPT" "$APP_DIR" "deploy/workbench-production-preflight.sh" "Production preflight"
  assert_candidate_source_file "$RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PREPARE_SCRIPT" "$APP_DIR" \
    "scripts/prepare-runtime-worker-execution-private-key.mjs" "Runtime Worker private-key preparation script"
  if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
    assert_candidate_source_file "$DEERFLOW_PREFLIGHT_SCRIPT" "$APP_DIR" \
      "deploy/deerflow-production-preflight.sh" "DeerFlow production preflight"
  fi
  prepare_runtime_worker_execution_private_key
  image_inventory_path="$(env_value WORKBENCH_IMAGE_INVENTORY_PATH)"
  image_inventory_bundle_path="$(env_value WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH)"
  cosign_identity="$(env_value WORKBENCH_COSIGN_CERTIFICATE_IDENTITY)"
  cosign_issuer="$(env_value WORKBENCH_COSIGN_OIDC_ISSUER)"
  source_commit="$(env_value WORKBENCH_SOURCE_COMMIT)"
  [ -f "$image_inventory_path" ] || { echo "Signed production image inventory is missing: $image_inventory_path" >&2; exit 66; }
  [ -f "$image_inventory_bundle_path" ] || { echo "Production image inventory signature bundle is missing: $image_inventory_bundle_path" >&2; exit 66; }
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

PINNED_COMMAND_ENV=()
if [ "$IMAGE_MODE" = "pinned" ]; then
  PINNED_COMMAND_ENV=(env -i "PATH=$PATH")
  for name in \
    HOME TMPDIR SSH_AUTH_SOCK XDG_RUNTIME_DIR \
    DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG \
    DOCKER_API_VERSION DOCKER_SSH_COMMAND DOCKER_AUTH_CONFIG; do
    if [ -n "${!name+x}" ]; then
      PINNED_COMMAND_ENV+=("$name=${!name}")
    fi
  done
  COMPOSE=("${PINNED_COMMAND_ENV[@]}" \
    "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=$ALLOW_RUNTIME_QUEUE_RECREATE" \
    docker compose --project-directory "$APP_DIR/deploy" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  DEERFLOW_COMPOSE=("${PINNED_COMMAND_ENV[@]}" \
    "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=$ALLOW_RUNTIME_QUEUE_RECREATE" \
    docker compose --project-directory "$APP_DIR/deploy" --env-file "$ENV_FILE" -f "$DEERFLOW_COMPOSE_FILE")
else
  COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  DEERFLOW_COMPOSE=(docker compose --project-directory "$APP_DIR/deploy" --env-file "$ENV_FILE" -f "$DEERFLOW_COMPOSE_FILE")
fi
if [ -n "$COMPOSE_OVERLAY" ]; then
  COMPOSE+=(-f "$COMPOSE_OVERLAY")
fi
for profile in $COMPOSE_PROFILES; do
  COMPOSE+=(--profile "$profile")
done
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

compose_up_with_runtime_worker_scale() {
  local replicas
  local -a options=(-d --remove-orphans)
  replicas="$(runtime_worker_replicas)"
  if [ "$IMAGE_MODE" = "build" ]; then
    options+=(--build)
  else
    options+=(--no-build)
  fi
  "${COMPOSE[@]}" up "${options[@]}" --scale "workbench-worker=$replicas" "$@"
}

compose_up_force_recreate() {
  # Nginx resolves Docker service names when it starts. Recreate the public
  # gateway after an upstream rollout so it cannot retain a removed container
  # IP in its resolved upstream.
  "${COMPOSE[@]}" up -d --remove-orphans --no-build --force-recreate "$@"
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
  "${COMPOSE[@]}" up -d postgres
  wait_for_services postgres
  run_runtime_queue_migrator
}

if [ "$SKIP_PREFLIGHT" = "0" ] && [ -n "$PREFLIGHT_SCRIPT" ]; then
  if [ "$IMAGE_MODE" = "pinned" ]; then
    "${PINNED_COMMAND_ENV[@]}" \
      "WORKBENCH_APP_DIR=$APP_DIR" \
      "WORKBENCH_ENV_FILE=$ENV_FILE" \
      "WORKBENCH_COMPOSE_FILE=$COMPOSE_FILE" \
      "WORKBENCH_OVERLAY_FILE=$COMPOSE_OVERLAY" \
      "WORKBENCH_COMPOSE_PROFILES=$COMPOSE_PROFILES" \
      "$PREFLIGHT_SCRIPT"
  else
    WORKBENCH_APP_DIR="$APP_DIR" \
      WORKBENCH_ENV_FILE="$ENV_FILE" \
      WORKBENCH_COMPOSE_FILE="$COMPOSE_FILE" \
      WORKBENCH_OVERLAY_FILE="$COMPOSE_OVERLAY" \
      WORKBENCH_COMPOSE_PROFILES="$COMPOSE_PROFILES" \
      "$PREFLIGHT_SCRIPT"
  fi
fi
if [ "$SKIP_PREFLIGHT" = "0" ]; then
  "${COMPOSE[@]}" config --quiet
fi

case "$DEPLOY_TARGET" in
  all)
    deployment_mutated=1
    prepare_runtime_queue_cutover
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      prepare_deerflow_runtime
    fi
    compose_up_with_runtime_worker_scale
    if [ -n "$COMPOSE_OVERLAY" ]; then
      wait_for_services oidc object-storage clamav docling
    fi
    wait_for_services \
      object-storage-egress \
      workbench-api \
      workbench-web \
      workbench-file-worker \
      workbench-import-worker \
      workbench-export-worker \
      workbench-preview \
      knowledge \
      preview-gateway \
      gateway
    wait_for_runtime_workers
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
    compose_up_with_runtime_worker_scale workbench-worker
    wait_for_runtime_workers
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
    [ -n "$ROLLBACK_ENV_FILE" ] || { echo "WORKBENCH_ROLLBACK_ENV_FILE is required for rollback" >&2; exit 64; }
    [ -f "$ROLLBACK_ENV_FILE" ] || { echo "Rollback environment file is missing: $ROLLBACK_ENV_FILE" >&2; exit 66; }
    [ -f "$ROLLBACK_COMPOSE_FILE" ] || { echo "Rollback Compose file is missing: $ROLLBACK_COMPOSE_FILE" >&2; exit 66; }
    case "$ROLLBACK_APP_DIR" in
      /*) ;;
      *) echo "WORKBENCH_ROLLBACK_APP_DIR must be an absolute candidate checkout" >&2; exit 64 ;;
    esac
    [ -d "$ROLLBACK_APP_DIR" ] || { echo "Rollback candidate checkout is missing: $ROLLBACK_APP_DIR" >&2; exit 66; }
    rollback_deploy_script="$ROLLBACK_APP_DIR/deploy/server-deploy.sh"
    [ -x "$rollback_deploy_script" ] \
      || { echo "Rollback candidate deploy script is missing or not executable: $rollback_deploy_script" >&2; exit 66; }
    assert_candidate_source_file "$rollback_deploy_script" "$ROLLBACK_APP_DIR" \
      "deploy/server-deploy.sh" "Rollback deploy script"
    assert_candidate_compose_file "$ROLLBACK_COMPOSE_FILE" "$ROLLBACK_APP_DIR" "Rollback"
    assert_candidate_source_file "$ROLLBACK_APP_DIR/deploy/deerflow-runtime-compose.yml" "$ROLLBACK_APP_DIR" \
      "deploy/deerflow-runtime-compose.yml" "Rollback DeerFlow Compose file"
    assert_candidate_source_file "$ROLLBACK_APP_DIR/deploy/workbench-production-preflight.sh" "$ROLLBACK_APP_DIR" \
      "deploy/workbench-production-preflight.sh" "Rollback production preflight"
    assert_candidate_source_file "$ROLLBACK_APP_DIR/deploy/deerflow-production-preflight.sh" "$ROLLBACK_APP_DIR" \
      "deploy/deerflow-production-preflight.sh" "Rollback DeerFlow preflight"
    rollback_release_owner_uid="$(rollback_env_value WORKBENCH_RELEASE_OWNER_UID)"
    if ! [[ "$rollback_release_owner_uid" =~ ^(0|[1-9][0-9]{0,9})$ ]]; then
      echo "Rollback WORKBENCH_RELEASE_OWNER_UID must be a numeric UID" >&2
      exit 64
    fi
    assert_candidate_source_file "$ROLLBACK_APP_DIR/scripts/assert-sealed-production-release.mjs" "$ROLLBACK_APP_DIR" \
      "scripts/assert-sealed-production-release.mjs" "Rollback sealed release verifier"
    assert_sealed_release "$ROLLBACK_APP_DIR" "$ROLLBACK_ENV_FILE" "Rollback" "$rollback_release_owner_uid"
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
    node "$PRODUCTION_DEPLOYMENT_CONFIG_SCRIPT" \
      --env-file "$ROLLBACK_ENV_FILE" \
      --repo-root "$ROLLBACK_APP_DIR" >/dev/null
    ROLLBACK_COMPOSE=("${PINNED_COMMAND_ENV[@]}" \
      WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=1 \
      docker compose --project-directory "$ROLLBACK_APP_DIR/deploy" \
      --env-file "$ROLLBACK_ENV_FILE" -f "$ROLLBACK_COMPOSE_FILE")
    "${ROLLBACK_COMPOSE[@]}" config --quiet
    "${ROLLBACK_COMPOSE[@]}" pull --quiet migrate
    stop_runtime_queue_participants
    "${COMPOSE[@]}" up -d postgres
    wait_for_services postgres
    echo "Restoring Runtime queue policies with the previous signed candidate migrator."
    if "${ROLLBACK_COMPOSE[@]}" run --rm --no-deps migrate; then
      :
    else
      rollback_migration_status=$?
      echo "Rollback queue reconciliation failed closed; queue producers and consumers remain stopped." >&2
      exit "$rollback_migration_status"
    fi
    runtime_queue_reconciled=1
    "${COMPOSE[@]}" down --remove-orphans
    if [ "$MANAGE_DEERFLOW_RUNTIME" = "1" ]; then
      WORKBENCH_APP_DIR="$APP_DIR" "${DEERFLOW_COMPOSE[@]}" down --remove-orphans
    fi
    WORKBENCH_ENV_FILE="$ROLLBACK_ENV_FILE" \
      WORKBENCH_COMPOSE_FILE="$ROLLBACK_COMPOSE_FILE" \
      WORKBENCH_COMPOSE_OVERLAY= \
      WORKBENCH_COMPOSE_PROFILES= \
      WORKBENCH_PREFLIGHT_SCRIPT="$ROLLBACK_APP_DIR/deploy/workbench-production-preflight.sh" \
      WORKBENCH_DEERFLOW_COMPOSE_FILE="$ROLLBACK_APP_DIR/deploy/deerflow-runtime-compose.yml" \
      WORKBENCH_DEERFLOW_PREFLIGHT_SCRIPT="$ROLLBACK_APP_DIR/deploy/deerflow-production-preflight.sh" \
      WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PREPARE_SCRIPT="$ROLLBACK_APP_DIR/scripts/prepare-runtime-worker-execution-private-key.mjs" \
      WORKBENCH_DEPLOY_IMAGE_MODE=pinned \
      WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=1 \
      DEPLOY_TARGET=all \
      WORKBENCH_DEPLOY_ROLLBACK_ON_FAILURE=0 \
      WORKBENCH_RELEASE_OWNER_UID="$rollback_release_owner_uid" \
      APP_DIR="$ROLLBACK_APP_DIR" \
      exec "$rollback_deploy_script"
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
    prepare_runtime_queue_cutover
    ;;
  *)
    echo "DEPLOY_TARGET must be one of: all, api, web, runtime-worker, deerflow-runtime, file-worker, import-worker, export-worker, preview, knowledge, migrate, stop, rollback" >&2
    exit 64
    ;;
esac

echo "产品工作台部署完成，目标: $DEPLOY_TARGET"
