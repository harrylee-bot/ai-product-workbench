#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${WORKBENCH_APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BUCKET="${WORKBENCH_OSS_BUCKET:-}"
ENVIRONMENT="${WORKBENCH_OSS_ENVIRONMENT:-prod}"
REGION="${WORKBENCH_OSS_REGION:-}"
INTERNAL_ENDPOINT="${WORKBENCH_OSS_INTERNAL_ENDPOINT:-}"
EGRESS_UPSTREAM_HOST="${WORKBENCH_OSS_EGRESS_UPSTREAM_HOST:-}"
BROWSER_UPLOAD_BUCKET_URL="${WORKBENCH_OSS_BROWSER_UPLOAD_BUCKET_URL:-}"
ENV_OUTPUT="${WORKBENCH_OSS_CREDENTIAL_OUTPUT:-}"
EVIDENCE_OUTPUT="${WORKBENCH_OSS_EVIDENCE_OUTPUT:-}"
CONFIRM="${WORKBENCH_OSS_PROVISION_CONFIRM:-}"

for command in aliyun jq node; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 69
  }
done

[ -n "$BUCKET" ] || { printf 'WORKBENCH_OSS_BUCKET is required\n' >&2; exit 64; }
[ -n "$REGION" ] || { printf 'WORKBENCH_OSS_REGION is required\n' >&2; exit 64; }
[ -n "$INTERNAL_ENDPOINT" ] || { printf 'WORKBENCH_OSS_INTERNAL_ENDPOINT is required\n' >&2; exit 64; }
[ -n "$EGRESS_UPSTREAM_HOST" ] || { printf 'WORKBENCH_OSS_EGRESS_UPSTREAM_HOST is required\n' >&2; exit 64; }
[ -n "$BROWSER_UPLOAD_BUCKET_URL" ] || { printf 'WORKBENCH_OSS_BROWSER_UPLOAD_BUCKET_URL is required\n' >&2; exit 64; }
[ "$CONFIRM" = "$BUCKET" ] || {
  printf 'WORKBENCH_OSS_PROVISION_CONFIRM must exactly equal WORKBENCH_OSS_BUCKET\n' >&2
  exit 64
}
[ -n "$ENV_OUTPUT" ] || { printf 'WORKBENCH_OSS_CREDENTIAL_OUTPUT is required\n' >&2; exit 64; }
[ -n "$EVIDENCE_OUTPUT" ] || { printf 'WORKBENCH_OSS_EVIDENCE_OUTPUT is required\n' >&2; exit 64; }
[ ! -e "$ENV_OUTPUT" ] || { printf 'Credential output already exists; refusing to overwrite it\n' >&2; exit 73; }
[ ! -e "$EVIDENCE_OUTPUT" ] || { printf 'Evidence output already exists; refusing to overwrite it\n' >&2; exit 73; }

node -e '
  const [region, endpointValue, upstreamHost, browserValue] = process.argv.slice(1);
  const regionPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  const endpoint = new URL(endpointValue);
  const browser = new URL(browserValue);
  if (!regionPattern.test(region)) process.exit(1);
  if (!hostnamePattern.test(upstreamHost) || !upstreamHost.endsWith(".aliyuncs.com")) process.exit(1);
  if (endpoint.protocol !== "https:" || endpoint.origin !== endpointValue
      || endpoint.hostname !== upstreamHost || endpoint.username || endpoint.password) process.exit(1);
  if (browser.protocol !== "https:" || browser.origin !== browserValue
      || browser.username || browser.password || browser.hostname === upstreamHost) process.exit(1);
' "$REGION" "$INTERNAL_ENDPOINT" "$EGRESS_UPSTREAM_HOST" "$BROWSER_UPLOAD_BUCKET_URL" \
  >/dev/null 2>&1 || {
    printf 'OSS region, endpoint, egress host, or browser bucket URL is invalid\n' >&2
    exit 64
  }

workdir="$(mktemp -d)"
manifest="$workdir/manifest.json"
credential_staging="$workdir/workbench-oss.env"
evidence_staging="$workdir/evidence.json"
created_users=()
created_policies=()
attached_users=()
attached_policies=()
created_key_users=()
created_key_ids=()
provisioning_complete=0

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$provisioning_complete" -eq 0 ]; then
    local index
    for ((index=${#created_key_ids[@]} - 1; index >= 0; index -= 1)); do
      aliyun ram DeleteAccessKey \
        --UserName "${created_key_users[$index]}" \
        --UserAccessKeyId "${created_key_ids[$index]}" >/dev/null 2>&1 || true
    done
    for ((index=${#attached_users[@]} - 1; index >= 0; index -= 1)); do
      aliyun ram DetachPolicyFromUser \
        --PolicyType Custom \
        --PolicyName "${attached_policies[$index]}" \
        --UserName "${attached_users[$index]}" >/dev/null 2>&1 || true
    done
    for ((index=${#created_users[@]} - 1; index >= 0; index -= 1)); do
      aliyun ram DeleteUser --UserName "${created_users[$index]}" >/dev/null 2>&1 || true
    done
    for ((index=${#created_policies[@]} - 1; index >= 0; index -= 1)); do
      aliyun ram DeletePolicy \
        --PolicyType Custom \
        --PolicyName "${created_policies[$index]}" >/dev/null 2>&1 || true
    done
    rm -f "$ENV_OUTPUT" "$EVIDENCE_OUTPUT"
  fi
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT

node "$APP_DIR/scripts/workbench-oss-ram-manifest.mjs" \
  --bucket "$BUCKET" \
  --environment "$ENVIRONMENT" >"$manifest"

caller_json="$(aliyun sts GetCallerIdentity)"
jq -e '.AccountId and .Arn' <<<"$caller_json" >/dev/null

while IFS= read -r identity; do
  user="$(jq -r '.userName' <<<"$identity")"
  policy="$(jq -r '.policyName' <<<"$identity")"
  if existing="$(aliyun ram GetUser --UserName "$user" 2>&1)"; then
    printf 'refusing to overwrite existing RAM user: %s\n' "$user" >&2
    exit 73
  elif [[ "$existing" != *"EntityNotExist.User"* ]]; then
    printf 'unable to prove RAM user is absent: %s\n' "$user" >&2
    exit 74
  fi
  if existing="$(aliyun ram GetPolicy --PolicyType Custom --PolicyName "$policy" 2>&1)"; then
    printf 'refusing to overwrite existing RAM policy: %s\n' "$policy" >&2
    exit 73
  elif [[ "$existing" != *"EntityNotExist.Policy"* ]]; then
    printf 'unable to prove RAM policy is absent: %s\n' "$policy" >&2
    exit 74
  fi
done < <(jq -c '.identities[]' "$manifest")

printf '%s\n' \
  "WORKBENCH_S3_INTERNAL_ENDPOINT=$INTERNAL_ENDPOINT" \
  "WORKBENCH_S3_EGRESS_UPSTREAM_HOST=$EGRESS_UPSTREAM_HOST" \
  "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL=$BROWSER_UPLOAD_BUCKET_URL" \
  "WORKBENCH_S3_BUCKET=$BUCKET" \
  "WORKBENCH_S3_REGION=$REGION" \
  'WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE=false' \
  'WORKBENCH_S3_CONDITIONAL_CREATE_MODE=oss-forbid-overwrite' >"$credential_staging"

while IFS= read -r identity; do
  user="$(jq -r '.userName' <<<"$identity")"
  policy="$(jq -r '.policyName' <<<"$identity")"
  env_prefix="$(jq -r '.envPrefix' <<<"$identity")"
  description="$(jq -r '.description' <<<"$identity")"
  policy_document="$(jq -c '.policyDocument' <<<"$identity")"

  aliyun ram CreatePolicy \
    --PolicyName "$policy" \
    --PolicyDocument "$policy_document" \
    --Description "$description" >/dev/null
  created_policies+=("$policy")

  aliyun ram CreateUser \
    --UserName "$user" \
    --DisplayName "$user" \
    --Comments "$description" >/dev/null
  created_users+=("$user")

  aliyun ram AttachPolicyToUser \
    --PolicyType Custom \
    --PolicyName "$policy" \
    --UserName "$user" >/dev/null
  attached_users+=("$user")
  attached_policies+=("$policy")

  access_key_json="$(aliyun ram CreateAccessKey --UserName "$user")"
  access_key_id="$(jq -er '.AccessKey.AccessKeyId' <<<"$access_key_json")"
  access_key_secret="$(jq -er '.AccessKey.AccessKeySecret' <<<"$access_key_json")"
  created_key_users+=("$user")
  created_key_ids+=("$access_key_id")
  printf '%s_ACCESS_KEY_ID=%s\n%s_SECRET_ACCESS_KEY=%s\n' \
    "$env_prefix" "$access_key_id" \
    "$env_prefix" "$access_key_secret" >>"$credential_staging"
  unset access_key_json access_key_id access_key_secret policy_document
  printf 'Created OSS identity: %s\n' "$user"
done < <(jq -c '.identities[]' "$manifest")

jq -n \
  --arg schemaVersion 'workbench.oss-ram-provision-evidence.v1' \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg accountId "$(jq -r '.AccountId' <<<"$caller_json")" \
  --arg principalArn "$(jq -r '.Arn' <<<"$caller_json")" \
  --slurpfile manifest "$manifest" \
  '{schemaVersion:$schemaVersion,generatedAt:$generatedAt,accountId:$accountId,principalArn:$principalArn,manifest:$manifest[0]}' \
  >"$evidence_staging"

install -m 600 "$credential_staging" "$ENV_OUTPUT"
install -m 600 "$evidence_staging" "$EVIDENCE_OUTPUT"
provisioning_complete=1
printf 'OSS RAM provisioning complete; secret output is mode 0600\n'
