#!/bin/sh
set -eu

APP_DIR=${WORKBENCH_APP_DIR:-/opt/workbench}
ENV_FILE=${WORKBENCH_ENV_FILE:-$APP_DIR/deploy/workbench.env}
COMPOSE_FILE=${WORKBENCH_DEERFLOW_COMPOSE_FILE:-$APP_DIR/deploy/deerflow-runtime-compose.yml}
FRAGMENT_FILE=$APP_DIR/integrations/deerflow/runtime-tools/config.fragment.yaml
TOOL_SCOPE_PATCH_MANIFEST=$APP_DIR/integrations/deerflow/source-patches/7a6c4a994a86583d2a3c056ee9d0f157d4f030c2/manifest.json

fail() {
  printf '%s\n' "deerflow production preflight: $*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || fail "missing $COMPOSE_FILE"
[ -f "$FRAGMENT_FILE" ] || fail "missing $FRAGMENT_FILE"
[ -f "$TOOL_SCOPE_PATCH_MANIFEST" ] || fail "missing $TOOL_SCOPE_PATCH_MANIFEST"

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

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

deerflow_home=$(require_env DEER_FLOW_HOME)
base_config=$(require_env WORKBENCH_DEERFLOW_BASE_CONFIG_PATH)
effective_config=$(require_env DEER_FLOW_CONFIG_PATH)
provider_env=$(require_env WORKBENCH_DEERFLOW_PROVIDER_ENV_FILE)
internal_network=$(require_env WORKBENCH_INTERNAL_NETWORK_NAME)
internal_token=$(require_env WORKBENCH_DEERFLOW_INTERNAL_AUTH_TOKEN)
expected_commit=$(require_env WORKBENCH_DEERFLOW_COMMIT)
workbench_source_commit=$(require_env WORKBENCH_SOURCE_COMMIT)
base_image_ref=$(require_env WORKBENCH_DEERFLOW_BASE_IMAGE_REF)
image_ref=$(require_env WORKBENCH_DEERFLOW_IMAGE_REF)
image_digest=$(require_env WORKBENCH_DEERFLOW_IMAGE_DIGEST)
image_inventory=$(require_env WORKBENCH_IMAGE_INVENTORY_PATH)
image_inventory_bundle=$(require_env WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH)
cosign_identity=$(require_env WORKBENCH_COSIGN_CERTIFICATE_IDENTITY)
cosign_issuer=$(require_env WORKBENCH_COSIGN_OIDC_ISSUER)
attestation=$(require_env WORKBENCH_DEERFLOW_SECRET_CHANNEL_ATTESTATION_PATH)
host_port=$(require_env WORKBENCH_DEERFLOW_HOST_PORT)

[ -f "$base_config" ] || fail "missing base DeerFlow config: $base_config"
[ -f "$effective_config" ] || fail "missing generated DeerFlow config: $effective_config"
[ -f "$provider_env" ] || fail "missing provider environment: $provider_env"
[ -d "$deerflow_home" ] || fail "missing dedicated DeerFlow home: $deerflow_home"
[ -f "$attestation" ] || fail "missing request-scoped secret attestation: $attestation"
[ -f "$image_inventory" ] || fail "missing signed image evidence manifest: $image_inventory"
[ -f "$image_inventory_bundle" ] || fail "missing image evidence manifest signature bundle: $image_inventory_bundle"
tool_scope_patch_sha256=$(sha256sum "$TOOL_SCOPE_PATCH_MANIFEST" 2>/dev/null | awk '{print $1}') \
  || fail "cannot hash DeerFlow tool-scope patch manifest"
printf '%s' "$tool_scope_patch_sha256" | grep -Eq '^[0-9a-f]{64}$' \
  || fail "DeerFlow tool-scope patch manifest hash is invalid"
[ "$base_config" != "$effective_config" ] || fail "base and effective config paths must differ"
[ ! -L "$provider_env" ] || fail "provider environment must not be a symlink"
[ ! -L "$base_config" ] || fail "base config must not be a symlink"
grep -Fq 'REPLACE_WITH_' "$provider_env" && fail "provider environment still contains placeholders"

provider_mode=$(file_mode "$provider_env") || fail "cannot inspect provider environment permissions"
case "$provider_mode" in
  400 | 440 | 600 | 640) ;;
  *) fail "provider environment must be owner-readable, optionally group-readable, and never writable by group/other" ;;
esac

provider_env_value() {
  key=$1
  count=$(grep -c "^${key}=" "$provider_env" || true)
  [ "$count" -eq 1 ] || fail "$key must occur exactly once in provider environment"
  sed -n "s/^${key}=//p" "$provider_env"
}

provider_api_key=$(provider_env_value OPENAI_API_KEY)
provider_base_url=$(provider_env_value WORKBENCH_DEERFLOW_PROVIDER_BASE_URL)
provider_model=$(provider_env_value WORKBENCH_DEERFLOW_PROVIDER_MODEL)

[ -n "$provider_api_key" ] || fail "OPENAI_API_KEY is empty in provider environment"
[ -n "$provider_base_url" ] || fail "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL is empty in provider environment"
[ -n "$provider_model" ] || fail "WORKBENCH_DEERFLOW_PROVIDER_MODEL is empty in provider environment"
case "$provider_base_url" in
  https://*) ;;
  *) fail "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL must use HTTPS" ;;
esac
case "$provider_base_url" in
  *"@"* | *"?"* | *"#"*) fail "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL must not contain credentials, a query, or a fragment" ;;
esac
case "$provider_model" in
  *[!A-Za-z0-9._:/-]* | latest | "") fail "WORKBENCH_DEERFLOW_PROVIDER_MODEL must be a fixed provider model id" ;;
esac

case "$host_port" in
  *[!0-9]* | "") fail "WORKBENCH_DEERFLOW_HOST_PORT must be numeric" ;;
esac
printf '%s' "$expected_commit" | grep -Eq '^[0-9a-f]{40}$' \
  || fail "WORKBENCH_DEERFLOW_COMMIT must be a lowercase Git commit"
printf '%s' "$workbench_source_commit" | grep -Eq '^[0-9a-f]{40}$' \
  || fail "WORKBENCH_SOURCE_COMMIT must be a lowercase Git commit"
printf '%s' "$base_image_ref" | grep -Eq '@sha256:[0-9a-f]{64}$' \
  || fail "WORKBENCH_DEERFLOW_BASE_IMAGE_REF must be an immutable digest reference"
printf '%s' "$cosign_identity" | grep -Eq '^https://[^[:space:]]+$' \
  || fail "WORKBENCH_COSIGN_CERTIFICATE_IDENTITY must be an exact HTTPS identity"
printf '%s' "$cosign_issuer" | grep -Eq '^https://[^[:space:]]+$' \
  || fail "WORKBENCH_COSIGN_OIDC_ISSUER must be an exact HTTPS issuer"
printf '%s' "$image_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' \
  || fail "WORKBENCH_DEERFLOW_IMAGE_DIGEST must be sha256:<64 lowercase hex>"
case "$image_ref" in
  *@"$image_digest") ;;
  *) fail "WORKBENCH_DEERFLOW_IMAGE_REF must be pinned to WORKBENCH_DEERFLOW_IMAGE_DIGEST" ;;
esac

node "$APP_DIR/scripts/assert-deerflow-production-deployment.mjs" \
  --expected-commit "$expected_commit"
node "$APP_DIR/scripts/generate-workbench-runtime-result-validator.mjs" --check
node "$APP_DIR/scripts/merge-deerflow-config.mjs" \
  --base "$base_config" \
  --fragment "$FRAGMENT_FILE" \
  --output "$effective_config" \
  --check
node "$APP_DIR/scripts/assert-deerflow-runtime-config.mjs" \
  --config "$effective_config" \
  --provider-env "$provider_env"
node "$APP_DIR/scripts/assert-deerflow-secret-channel-attestation.mjs" \
  --attestation "$attestation" \
  --commit "$expected_commit" \
  --image-digest "$image_digest"
command -v cosign >/dev/null 2>&1 || fail "cosign is required to verify the production image manifest"
node "$APP_DIR/scripts/production-image-inventory.mjs" \
  --manifest "$image_inventory" \
  --bundle "$image_inventory_bundle" \
  --certificate-identity "$cosign_identity" \
  --certificate-oidc-issuer "$cosign_issuer" \
  --expected-commit "$workbench_source_commit" \
  --env-file "$ENV_FILE" \
  --image deerflow \
  --inspect-local-images

config_mode=$(file_mode "$effective_config") || fail "cannot inspect effective config permissions"
[ "$config_mode" = "600" ] || fail "effective config must have mode 0600"

image_repo_digests=$(docker image inspect --format '{{join .RepoDigests " "}}' "$image_ref" 2>/dev/null) \
  || fail "pinned DeerFlow image is not present: $image_ref"
printf '%s\n' "$image_repo_digests" | grep -Eq "@${image_digest}([[:space:]]|$)" \
  || fail "resolved DeerFlow RepoDigest does not match WORKBENCH_DEERFLOW_IMAGE_DIGEST"

image_labels=$(docker image inspect --format '{{json .Config.Labels}}' "$image_ref" 2>/dev/null) \
  || fail "cannot inspect DeerFlow image labels"
printf '%s' "$image_labels" | grep -Fq "\"org.opencontainers.image.revision\":\"$workbench_source_commit\"" \
  || fail "DeerFlow image is not bound to WORKBENCH_SOURCE_COMMIT"
printf '%s' "$image_labels" | grep -Fq "\"io.workbench.deerflow.source-commit\":\"$expected_commit\"" \
  || fail "DeerFlow image is not bound to WORKBENCH_DEERFLOW_COMMIT"
printf '%s' "$image_labels" | grep -Fq "\"io.workbench.deerflow.base-image\":\"$base_image_ref\"" \
  || fail "DeerFlow image is not bound to WORKBENCH_DEERFLOW_BASE_IMAGE_REF"
printf '%s' "$image_labels" | grep -Fq "\"io.workbench.deerflow.tool-scope-patch-sha256\":\"$tool_scope_patch_sha256\"" \
  || fail "DeerFlow image is not bound to the audited per-Run tool-scope patch"

command -v cosign >/dev/null 2>&1 || fail "cosign is required to verify the deployed DeerFlow signature"
cosign verify \
  --certificate-identity "$cosign_identity" \
  --certificate-oidc-issuer "$cosign_issuer" \
  "$image_ref" >/dev/null \
  || fail "deployed DeerFlow image signature verification failed"

docker network inspect "$internal_network" >/dev/null 2>&1 \
  || fail "missing Workbench internal network: $internal_network"
network_internal=$(docker network inspect --format '{{.Internal}}' "$internal_network")
[ "$network_internal" = "true" ] || fail "Workbench runtime network must remain internal"

export WORKBENCH_APP_DIR=$APP_DIR
export WORKBENCH_INTERNAL_NETWORK_NAME=$internal_network
export WORKBENCH_DEERFLOW_INTERNAL_AUTH_TOKEN=$internal_token
export WORKBENCH_DEERFLOW_HOST_PORT=$host_port
export DEER_FLOW_HOME=$deerflow_home
export DEER_FLOW_CONFIG_PATH=$effective_config

docker compose \
  --project-directory "$APP_DIR/deploy" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  config --quiet

printf '%s\n' "deerflow production preflight: ok"
