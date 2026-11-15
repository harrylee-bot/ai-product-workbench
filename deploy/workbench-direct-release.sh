#!/usr/bin/env bash
set -Eeuo pipefail
release_started_seconds=$SECONDS

# Direct production release entry point. The workstation only archives a clean
# committed tree and transfers it over SSH. The target Linux host builds native
# AMD64 images, runs the production preflight, cuts over the existing stack, and
# is then checked through its public HTTPS origin.

fail() {
  printf 'Workbench direct release: %s\n' "$*" >&2
  exit 64
}

require_env() {
  local name="$1" value="${!1-}"
  [ -n "$value" ] || fail "$name is required"
  case "$value" in *$'\n'*|*$'\r'*) fail "$name contains a newline" ;; esac
  printf '%s' "$value"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST="$(require_env WORKBENCH_PRODUCTION_HOST)"
USER_NAME="$(require_env WORKBENCH_PRODUCTION_USER)"
PRIVATE_DIR="${WORKBENCH_PRODUCTION_PRIVATE_DIR:-/home/data/workbench-private/1.0.0}"
APP_DIR="${WORKBENCH_PRODUCTION_APP_DIR:-/opt/workbench-1.0.0}"
WEB_ORIGIN="$(require_env WORKBENCH_WEB_ORIGIN)"
SOURCE_COMMIT="${WORKBENCH_SOURCE_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
SSH_BIND_INTERFACE="${WORKBENCH_SSH_BIND_INTERFACE-}"
ALLOW_DIRTY="${WORKBENCH_ALLOW_DIRTY:-0}"
HEALTH_RETRIES="${WORKBENCH_DIRECT_HEALTH_RETRIES:-10}"
FORCE_FULL="${WORKBENCH_FORCE_FULL_RELEASE:-0}"
case "$FORCE_FULL" in 0|1) ;; *) fail 'WORKBENCH_FORCE_FULL_RELEASE must be 0 or 1' ;; esac

printf '%s' "$HOST" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*$' || fail 'production host is invalid'
printf '%s' "$USER_NAME" | grep -Eq '^[A-Za-z0-9._-]+$' || fail 'production user is invalid'
printf '%s' "$APP_DIR" | grep -Eq '^/[A-Za-z0-9._/-]+$' || fail 'production app directory is invalid'
printf '%s' "$PRIVATE_DIR" | grep -Eq '^/[A-Za-z0-9._/-]+$' || fail 'production private directory is invalid'
printf '%s' "$SOURCE_COMMIT" | grep -Eq '^[a-f0-9]{40}$' || fail 'WORKBENCH_SOURCE_COMMIT must be a full lowercase Git SHA'
printf '%s' "$HEALTH_RETRIES" | grep -Eq '^[1-9][0-9]*$' || fail 'WORKBENCH_DIRECT_HEALTH_RETRIES must be a positive integer'
printf '%s' "$WEB_ORIGIN" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$' || fail 'WORKBENCH_WEB_ORIGIN must be an HTTPS origin'
if [ -n "$SSH_BIND_INTERFACE" ]; then
  [[ "$SSH_BIND_INTERFACE" =~ ^[A-Za-z][A-Za-z0-9._-]{0,63}$ ]] \
    || fail 'WORKBENCH_SSH_BIND_INTERFACE is invalid'
fi

case "$ALLOW_DIRTY" in
  0 | 1) ;;
  *) fail 'WORKBENCH_ALLOW_DIRTY must be 0 or 1' ;;
esac
git -C "$REPO_ROOT" cat-file -e "$SOURCE_COMMIT^{commit}" \
  || fail "source commit does not exist locally: $SOURCE_COMMIT"
if [ "$ALLOW_DIRTY" = "0" ]; then
  [ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ] \
    || fail 'working tree is not clean; commit the exact release tree before direct deployment'
fi

KNOWN_HOSTS="${WORKBENCH_PRODUCTION_KNOWN_HOSTS-}"
KNOWN_HOSTS_FILE="${WORKBENCH_PRODUCTION_KNOWN_HOSTS_FILE-}"
if [ -n "$KNOWN_HOSTS" ]; then
  case "$KNOWN_HOSTS" in *$'\r'*) fail 'WORKBENCH_PRODUCTION_KNOWN_HOSTS contains a carriage return' ;; esac
fi
if [ -z "$KNOWN_HOSTS" ] && [ -n "$KNOWN_HOSTS_FILE" ]; then
  [ -f "$KNOWN_HOSTS_FILE" ] || fail 'WORKBENCH_PRODUCTION_KNOWN_HOSTS_FILE is missing'
  KNOWN_HOSTS="$(cat "$KNOWN_HOSTS_FILE")"
fi
[ -n "$KNOWN_HOSTS" ] || fail 'provide WORKBENCH_PRODUCTION_KNOWN_HOSTS or WORKBENCH_PRODUCTION_KNOWN_HOSTS_FILE'

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/workbench-direct-release.XXXXXXXX")"
trap 'rm -rf -- "$TEMP_ROOT"' EXIT
LOCAL_KNOWN_HOSTS="$TEMP_ROOT/known_hosts"
printf '%s\n' "$KNOWN_HOSTS" > "$LOCAL_KNOWN_HOSTS"
chmod 600 "$LOCAL_KNOWN_HOSTS"
SSH_OPTS=(-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$LOCAL_KNOWN_HOSTS" -o ConnectTimeout=15)
if [ -n "$SSH_BIND_INTERFACE" ]; then
  SSH_OPTS+=(-o "BindInterface=$SSH_BIND_INTERFACE")
fi
if [ -n "${WORKBENCH_SSH_KEY_PATH:-}" ]; then
  [ -f "$WORKBENCH_SSH_KEY_PATH" ] || fail 'WORKBENCH_SSH_KEY_PATH is missing'
  SSH_OPTS+=(-i "$WORKBENCH_SSH_KEY_PATH")
fi
TARGET="$USER_NAME@$HOST"

SOURCE_ARCHIVE="$TEMP_ROOT/source.tar.gz"
git -C "$REPO_ROOT" archive --format=tar.gz --output="$SOURCE_ARCHIVE" "$SOURCE_COMMIT"
[ -s "$SOURCE_ARCHIVE" ] || fail 'source archive is empty'

# Public source commits intentionally exclude the private knowledge vault.
# Transfer an explicitly selected vault separately, without adding it to Git.
KNOWLEDGE_ARCHIVE=""
if [ -n "${WORKBENCH_RELEASE_KNOWLEDGE_DIR:-}" ]; then
  [ -r "$WORKBENCH_RELEASE_KNOWLEDGE_DIR/README.md" ] || fail 'private knowledge README is missing'
  [ -z "$(find "$WORKBENCH_RELEASE_KNOWLEDGE_DIR" -type l -print -quit)" ] \
    || fail 'private knowledge transfer does not accept symbolic links'
  KNOWLEDGE_ARCHIVE="$TEMP_ROOT/knowledge.tar.gz"
  COPYFILE_DISABLE=1 tar --exclude='.DS_Store' --exclude='._*' -czf "$KNOWLEDGE_ARCHIVE" \
    -C "$WORKBENCH_RELEASE_KNOWLEDGE_DIR" .
  chmod 600 "$KNOWLEDGE_ARCHIVE"
fi

RELEASE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_ID="direct-${SOURCE_COMMIT}-${RELEASE_STAMP}"
REMOTE_ROOT="$PRIVATE_DIR/releases/$RELEASE_ID"
REMOTE_SHORT="direct-${SOURCE_COMMIT:0:12}"

ssh "${SSH_OPTS[@]}" "$TARGET" "set -eu; test \"\$(uname -s)\" = Linux; case \"\$(uname -m)\" in x86_64|amd64) ;; *) exit 65 ;; esac; test -d '$APP_DIR/deploy'; test -f '$PRIVATE_DIR/current/workbench.env'; test ! -e '$REMOTE_ROOT'"
ssh "${SSH_OPTS[@]}" "$TARGET" "umask 077; mkdir -p '$REMOTE_ROOT/source' '$REMOTE_ROOT/incoming'"
scp "${SSH_OPTS[@]}" "$SOURCE_ARCHIVE" "$TARGET:$REMOTE_ROOT/incoming/source.tar.gz"
if [ -n "$KNOWLEDGE_ARCHIVE" ]; then
  scp "${SSH_OPTS[@]}" "$KNOWLEDGE_ARCHIVE" "$TARGET:$REMOTE_ROOT/incoming/knowledge.tar.gz"
fi

ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- "$REMOTE_ROOT" "$PRIVATE_DIR" "$SOURCE_COMMIT" "$REMOTE_SHORT" "$WEB_ORIGIN" "$FORCE_FULL" <<'REMOTE'
# Parse the entire script before executing it. Compose's interactive migration
# command must not consume the health/promotion commands from SSH stdin.
{
set -Eeuo pipefail

remote_root="$1"
private_dir="$2"
source_commit="$3"
image_tag="$4"
web_origin="$5"
export WORKBENCH_FORCE_FULL_RELEASE="$6"
source_root="$remote_root/source"
base_env="$private_dir/current/workbench.env"
direct_env="$remote_root/direct.env"

command -v docker >/dev/null 2>&1
command -v node >/dev/null 2>&1
command -v npm >/dev/null 2>&1
command -v flock >/dev/null 2>&1
# Serialize planning, build, health checks and successful-baseline promotion.
exec 8>"$private_dir/direct-release.lock"
flock -n 8 || { echo "Another direct release is running" >&2; exit 75; }
docker compose version >/dev/null 2>&1
tar --no-same-owner --no-same-permissions -xzf "$remote_root/incoming/source.tar.gz" -C "$source_root"
if [ -f "$remote_root/incoming/knowledge.tar.gz" ]; then
  [ ! -e "$source_root/knowledge-vault" ] || { echo 'Source archive already contains a knowledge vault' >&2; exit 65; }
  mkdir -m 700 "$source_root/knowledge-vault"
  tar --no-same-owner --no-same-permissions -xzf "$remote_root/incoming/knowledge.tar.gz" -C "$source_root/knowledge-vault"
fi
cd "$source_root"
node "$source_root/deploy/workbench-disk-preflight.mjs" "$source_root"
previous_plan="$private_dir/current/release-plan.json"
if [ -f "$private_dir/current/pending-release" ]; then
  export WORKBENCH_FORCE_FULL_RELEASE=1
fi
node "$source_root/deploy/workbench-release-plan.mjs" \
  "$source_root" "$previous_plan" "$base_env" "$remote_root" "$source_commit" "$image_tag"
release_mode="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).mode' "$remote_root/release-plan.json")"
release_services="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).services.join(" ")' "$remote_root/release-plan.json")"
cp "$base_env" "$remote_root/base.env"
chmod 600 "$remote_root/base.env"
if [ "$release_mode" != none ]; then
  # The host's Apport handler honors a zero core limit for unpackaged Node jobs.
  ulimit -c 0
  if [ "$release_mode" = all ]; then
    npm ci --ignore-scripts --no-audit --no-fund
    npm run workbench:prepare
  fi
  # Image builds compile their own inputs and validate Web types. Do not rebuild
  # every workspace on the host before building those same sources in Docker.
  printf '%s\n' "$source_commit" > "$private_dir/current/pending-release"
  chmod 600 "$private_dir/current/pending-release"

  WORKBENCH_APP_DIR="$source_root" \
  WORKBENCH_ENV_FILE="$direct_env" \
  WORKBENCH_COMPOSE_FILE="$source_root/deploy/workbench-compose.yml" \
  WORKBENCH_BUILD_BUILDER="${WORKBENCH_DIRECT_BUILD_BUILDER:-workbench-direct-release}" \
  WORKBENCH_BUILD_MEMORY_MIB="${WORKBENCH_BUILD_MEMORY_MIB:-4096}" \
  WORKBENCH_BUILD_RESERVE_MIB="${WORKBENCH_BUILD_RESERVE_MIB:-1024}" \
  WORKBENCH_BUILD_CPUS="${WORKBENCH_BUILD_CPUS:-2}" \
  WORKBENCH_TYPES_PREVALIDATED=0 \
  WORKBENCH_MANAGE_DEERFLOW_RUNTIME="${WORKBENCH_DIRECT_MANAGE_DEERFLOW_RUNTIME:-0}" \
  WORKBENCH_DEPLOY_SERVICES="$release_services" \
  DEPLOY_TARGET="$release_mode" \
  bash "$source_root/deploy/server-deploy.sh"
fi

curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 3 \
  "${web_origin%/}/api/healthz" >/dev/null
root_code="$(curl --silent --show-error --retry 10 --retry-all-errors --retry-delay 3 \
  -o /dev/null -w '%{http_code}' "${web_origin%/}/")"
[ "$root_code" = 307 ] || { echo "Public root health check failed: HTTP $root_code" >&2; exit 1; }
# Promote only a healthy release; hashes also detect manual env edits or a
# crash between the two atomic replacements. Keep base.env for recovery.
node --input-type=module - "$remote_root" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const root = process.argv[2];
const plan = JSON.parse(readFileSync(`${root}/release-plan.json`, "utf8"));
plan.envDigest = createHash("sha256").update(readFileSync(`${root}/direct.env`)).digest("hex");
writeFileSync(`${root}/release-plan.json`, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
NODE
install -m 600 "$direct_env" "$private_dir/current/workbench.env.next"
install -m 600 "$remote_root/release-plan.json" "$private_dir/current/release-plan.json.next"
mv "$private_dir/current/workbench.env.next" "$base_env"
mv "$private_dir/current/release-plan.json.next" "$private_dir/current/release-plan.json"
rm -f "$private_dir/current/pending-release"
rm -f "$remote_root/incoming/source.tar.gz"
rm -f "$remote_root/incoming/knowledge.tar.gz"
printf 'Healthy release baseline promoted: %s\n' "$source_commit"
} </dev/null
REMOTE

health_url="${WEB_ORIGIN%/}/api/healthz"
curl --fail --silent --show-error --retry "$HEALTH_RETRIES" --retry-all-errors --retry-delay 3 "$health_url" >/dev/null
root_code="$(curl --silent --show-error --retry "$HEALTH_RETRIES" --retry-all-errors --retry-delay 3 \
  -o /dev/null -w '%{http_code}' "${WEB_ORIGIN%/}/")"
[ "$root_code" = 307 ] || fail "public Workbench root returned HTTP $root_code instead of 307"

printf 'Workbench direct release deployed: commit=%s host=%s\n' "$SOURCE_COMMIT" "$HOST"

printf 'WORKBENCH_RELEASE_SECONDS=%s\n' "$((SECONDS - release_started_seconds))"
