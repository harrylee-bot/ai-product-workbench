#!/usr/bin/env bash
set -Eeuo pipefail

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

printf '%s' "$HOST" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*$' || fail 'production host is invalid'
printf '%s' "$USER_NAME" | grep -Eq '^[A-Za-z0-9._-]+$' || fail 'production user is invalid'
printf '%s' "$APP_DIR" | grep -Eq '^/[A-Za-z0-9._/-]+$' || fail 'production app directory is invalid'
printf '%s' "$PRIVATE_DIR" | grep -Eq '^/[A-Za-z0-9._/-]+$' || fail 'production private directory is invalid'
printf '%s' "$SOURCE_COMMIT" | grep -Eq '^[a-f0-9]{40}$' || fail 'WORKBENCH_SOURCE_COMMIT must be a full lowercase Git SHA'
printf '%s' "$HEALTH_RETRIES" | grep -Eq '^[1-9][0-9]*$' || fail 'WORKBENCH_DIRECT_HEALTH_RETRIES must be a positive integer'
case "$WEB_ORIGIN" in https://*) ;; *) fail 'WORKBENCH_WEB_ORIGIN must use HTTPS' ;; esac
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

RELEASE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_ID="direct-${SOURCE_COMMIT}-${RELEASE_STAMP}"
REMOTE_ROOT="$PRIVATE_DIR/releases/$RELEASE_ID"
REMOTE_SHORT="direct-${SOURCE_COMMIT:0:12}"

ssh "${SSH_OPTS[@]}" "$TARGET" "set -eu; test \"\$(uname -s)\" = Linux; case \"\$(uname -m)\" in x86_64|amd64) ;; *) exit 65 ;; esac; test -d '$APP_DIR/deploy'; test -f '$PRIVATE_DIR/current/workbench.env'; test ! -e '$REMOTE_ROOT'"
ssh "${SSH_OPTS[@]}" "$TARGET" "umask 077; mkdir -p '$REMOTE_ROOT/source' '$REMOTE_ROOT/incoming'"
scp "${SSH_OPTS[@]}" "$SOURCE_ARCHIVE" "$TARGET:$REMOTE_ROOT/incoming/source.tar.gz"

ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- "$REMOTE_ROOT" "$APP_DIR" "$PRIVATE_DIR" "$SOURCE_COMMIT" "$REMOTE_SHORT" <<'REMOTE'
set -Eeuo pipefail

remote_root="$1"
current_app_dir="$2"
private_dir="$3"
source_commit="$4"
image_tag="$5"
source_root="$remote_root/source"
base_env="$private_dir/current/workbench.env"
direct_env="$remote_root/direct.env"

command -v docker >/dev/null 2>&1
command -v node >/dev/null 2>&1
command -v npm >/dev/null 2>&1
command -v python3 >/dev/null 2>&1
docker compose version >/dev/null 2>&1
tar --no-same-owner --no-same-permissions -xzf "$remote_root/incoming/source.tar.gz" -C "$source_root"
cd "$source_root"
node "$source_root/deploy/workbench-disk-preflight.mjs" "$source_root"
# The host's Apport handler honors a zero core limit for unpackaged Node jobs.
ulimit -c 0
npm ci --ignore-scripts --no-audit --no-fund
npm run workbench:prepare
(
  cd "$source_root/apps/web"
  WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL="${WORKBENCH_WEB_TYPEGEN_UPLOAD_URL:-http://127.0.0.1:9000/workbench}" \
    node "$source_root/node_modules/next/dist/bin/next" typegen
  NODE_OPTIONS="${WORKBENCH_WEB_TYPECHECK_NODE_OPTIONS:---max-old-space-size=3072}" \
    npx tsc -p tsconfig.json --noEmit
)

export DIRECT_BASE_ENV="$base_env"
export DIRECT_ENV="$direct_env"
export DIRECT_APP_DIR="$source_root"
export DIRECT_SOURCE_COMMIT="$source_commit"
export DIRECT_IMAGE_TAG="$image_tag"
python3 - <<'PY'
import os
from pathlib import Path

base = Path(os.environ["DIRECT_BASE_ENV"])
target = Path(os.environ["DIRECT_ENV"])
values = {
    "WORKBENCH_APP_DIR": os.environ["DIRECT_APP_DIR"],
    "WORKBENCH_SOURCE_COMMIT": os.environ["DIRECT_SOURCE_COMMIT"],
    "WORKBENCH_API_MIGRATOR_IMAGE_REF": f"workbench-api-migrator:{os.environ['DIRECT_IMAGE_TAG']}",
    "WORKBENCH_API_IMAGE_REF": f"workbench-api:{os.environ['DIRECT_IMAGE_TAG']}",
    "WORKBENCH_WEB_IMAGE_REF": f"workbench-web:{os.environ['DIRECT_IMAGE_TAG']}",
    "WORKBENCH_RUNTIME_WORKER_IMAGE_REF": f"workbench-runtime-worker:{os.environ['DIRECT_IMAGE_TAG']}",
    "WORKBENCH_FILE_WORKER_IMAGE_REF": f"workbench-file-worker:{os.environ['DIRECT_IMAGE_TAG']}",
    "WORKBENCH_IMPORT_WORKER_IMAGE_REF": f"workbench-import-worker:{os.environ['DIRECT_IMAGE_TAG']}",
    "WORKBENCH_EXPORT_WORKER_IMAGE_REF": f"workbench-export-worker:{os.environ['DIRECT_IMAGE_TAG']}",
    "WORKBENCH_PREVIEW_IMAGE_REF": f"workbench-preview:{os.environ['DIRECT_IMAGE_TAG']}",
    "WORKBENCH_KNOWLEDGE_IMAGE_REF": f"workbench-knowledge:{os.environ['DIRECT_IMAGE_TAG']}",
}
lines = base.read_text(encoding="utf-8").splitlines()
seen = set()
result = []
for line in lines:
    key, separator, _ = line.partition("=")
    if separator and key in values:
        result.append(f"{key}={values[key]}")
        seen.add(key)
    else:
        result.append(line)
for key, value in values.items():
    if key not in seen:
        result.append(f"{key}={value}")
target.write_text("\n".join(result) + "\n", encoding="utf-8")
target.chmod(0o600)
PY

WORKBENCH_APP_DIR="$source_root" \
WORKBENCH_ENV_FILE="$direct_env" \
WORKBENCH_COMPOSE_FILE="$source_root/deploy/workbench-compose.yml" \
WORKBENCH_BUILD_BUILDER="${WORKBENCH_DIRECT_BUILD_BUILDER:-workbench-direct-$image_tag}" \
WORKBENCH_BUILD_MEMORY_MIB="${WORKBENCH_BUILD_MEMORY_MIB:-4096}" \
WORKBENCH_BUILD_RESERVE_MIB="${WORKBENCH_BUILD_RESERVE_MIB:-1024}" \
WORKBENCH_BUILD_CPUS="${WORKBENCH_BUILD_CPUS:-2}" \
WORKBENCH_TYPES_PREVALIDATED=1 \
WORKBENCH_MANAGE_DEERFLOW_RUNTIME="${WORKBENCH_DIRECT_MANAGE_DEERFLOW_RUNTIME:-0}" \
DEPLOY_TARGET=all \
bash "$source_root/deploy/server-deploy.sh"

rm -f "$remote_root/incoming/source.tar.gz"
REMOTE

health_url="${WEB_ORIGIN%/}/api/healthz"
curl --fail --silent --show-error --retry "$HEALTH_RETRIES" --retry-all-errors --retry-delay 3 "$health_url" >/dev/null
root_code="$(curl --silent --show-error --retry "$HEALTH_RETRIES" --retry-all-errors --retry-delay 3 \
  -o /dev/null -w '%{http_code}' "${WEB_ORIGIN%/}/")"
[ "$root_code" = 307 ] || fail "public Workbench root returned HTTP $root_code instead of 307"

printf 'Workbench direct release deployed: commit=%s host=%s\n' "$SOURCE_COMMIT" "$HOST"
