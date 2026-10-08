#!/usr/bin/env bash
set -Eeuo pipefail
set -f

usage() {
  printf '%s\n' \
    'Usage: APP_DIR=/absolute/project WORKBENCH_ENV_FILE=/absolute/private.env workbench-build [SERVICE ...]' \
    '' \
    'Build images with the bounded Workbench builder. Does not deploy or restart services.' \
    'APP_DIR and WORKBENCH_ENV_FILE are required absolute paths.' \
    'WORKBENCH_COMPOSE_FILE defaults to $APP_DIR/deploy/workbench-compose.yml.' \
    'WORKBENCH_COMPOSE_OVERLAY optionally adds a second Compose file.' \
    'WORKBENCH_COMPOSE_PROFILES optionally selects space-separated profiles.' \
    'Only service names are accepted; omit them to build all configured services.'
}

if [ "$#" -eq 1 ] && [ "$1" = --help ]; then
  usage
  exit 0
fi

fail() {
  printf 'Workbench build: %s\n' "$*" >&2
  exit 64
}

for service in "$@"; do
  [[ "$service" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] \
    || fail 'arguments must be Compose service names, not options'
done

[[ "${APP_DIR:-}" = /* ]] || fail 'APP_DIR must be an explicit absolute project directory'
[ -d "$APP_DIR" ] || fail 'APP_DIR is not a directory'
[[ "${WORKBENCH_ENV_FILE:-}" = /* ]] || fail 'WORKBENCH_ENV_FILE must be an explicit absolute file path'
COMPOSE_FILE="${WORKBENCH_COMPOSE_FILE:-$APP_DIR/deploy/workbench-compose.yml}"
COMPOSE_OVERLAY="${WORKBENCH_COMPOSE_OVERLAY:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_HELPER="$SCRIPT_DIR/workbench-build-resources.sh"

require_file() {
  [[ "$2" = /* ]] || fail "$1 must be an absolute file path"
  [ -f "$2" ] && [ -r "$2" ] || fail "$1 must be a readable regular file"
}

require_file WORKBENCH_ENV_FILE "$WORKBENCH_ENV_FILE"
require_file WORKBENCH_COMPOSE_FILE "$COMPOSE_FILE"
[ -z "$COMPOSE_OVERLAY" ] || require_file WORKBENCH_COMPOSE_OVERLAY "$COMPOSE_OVERLAY"
require_file 'build resource helper' "$BUILD_HELPER"

COMPOSE=(docker compose --env-file "$WORKBENCH_ENV_FILE" -f "$COMPOSE_FILE")
[ -z "$COMPOSE_OVERLAY" ] || COMPOSE+=(-f "$COMPOSE_OVERLAY")
for profile in ${WORKBENCH_COMPOSE_PROFILES:-}; do
  [[ "$profile" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] \
    || fail 'WORKBENCH_COMPOSE_PROFILES must contain profile names, not options'
  COMPOSE+=(--profile "$profile")
done

command -v docker >/dev/null || fail 'docker is required'
cd "$APP_DIR"
"${COMPOSE[@]}" config --quiet
source "$BUILD_HELPER"
validation_build_images "$@"
