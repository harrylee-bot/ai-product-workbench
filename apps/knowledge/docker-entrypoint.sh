#!/usr/bin/env bash
set -euo pipefail

CONTENT_DIR="${QUARTZ_CONTENT_DIR:-/vault}"
OUTPUT_DIR="${QUARTZ_OUTPUT_DIR:-/usr/share/nginx/html}"
BUILD_CONTENT_PREFIX="${QUARTZ_BUILD_CONTENT_DIR:-/tmp/quartz-content}"
BUILD_OUTPUT_PREFIX="${QUARTZ_BUILD_OUTPUT_DIR:-${OUTPUT_DIR}.generation}"
BUILD_LOCK_DIR="${QUARTZ_BUILD_LOCK_DIR:-${BUILD_CONTENT_PREFIX}.lock}"
CONFIG_PATH="${QUARTZ_CONFIG_PATH:-/opt/quartz/quartz.config.yaml}"
QUARTZ_WORK_DIR="${QUARTZ_WORK_DIR:-/opt/quartz}"
FINALIZE_SCRIPT="${QUARTZ_FINALIZE_SCRIPT:-/usr/local/lib/knowledge-finalize-output.mjs}"
GENERATION_SCRIPT="${QUARTZ_GENERATION_SCRIPT:-/usr/local/lib/knowledge-publish-generation.mjs}"
ASSERT_OUTPUT_SCRIPT="${QUARTZ_ASSERT_OUTPUT_SCRIPT:-/usr/local/lib/knowledge-assert-output.mjs}"
SEED_DIR="${QUARTZ_SEED_DIR:-/seed-vault}"
NGINX_BIN="${QUARTZ_NGINX_BIN:-nginx}"
WATCH_INTERVAL_SECONDS="${QUARTZ_WATCH_INTERVAL_SECONDS:-30}"

if ! [[ "$WATCH_INTERVAL_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] \
  || [[ "$WATCH_INTERVAL_SECONDS" =~ ^0+([.]0+)?$ ]]; then
  echo "QUARTZ_WATCH_INTERVAL_SECONDS must be a positive number" >&2
  exit 64
fi
if [ "${QUARTZ_WATCH_ENABLED:-true}" != "true" ] \
  && [ "${QUARTZ_WATCH_ENABLED:-true}" != "false" ]; then
  echo "QUARTZ_WATCH_ENABLED must be true or false" >&2
  exit 64
fi

BUILD_CHILD_PID=""
BUILD_LOCK_TOKEN=""
CURRENT_BUILD_OUTPUT=""
CURRENT_SNAPSHOT=""
WATCHER_PID=""
NGINX_PID=""

mkdir -p "$(dirname "$CONTENT_DIR")" "$(dirname "$OUTPUT_DIR")" \
  "$(dirname "$BUILD_CONTENT_PREFIX")" "$(dirname "$BUILD_OUTPUT_PREFIX")"

directory_has_entries() {
  [ -d "$1" ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

initialize_seed_vault() {
  if [ -e "$CONTENT_DIR" ] && [ ! -d "$CONTENT_DIR" ]; then
    echo "Knowledge content path is not a directory: $CONTENT_DIR" >&2
    return 1
  fi
  if directory_has_entries "$CONTENT_DIR"; then
    return 0
  fi
  if ! directory_has_entries "$SEED_DIR"; then
    echo "Knowledge seed vault is missing or empty: $SEED_DIR" >&2
    return 1
  fi

  local staging
  staging="$(mktemp -d "${CONTENT_DIR}.seed.XXXXXX")"
  if ! cp -a "$SEED_DIR"/. "$staging"/; then
    rm -rf "$staging"
    return 1
  fi

  if [ ! -e "$CONTENT_DIR" ]; then
    mv "$staging" "$CONTENT_DIR"
    return 0
  fi
  if directory_has_entries "$CONTENT_DIR"; then
    rm -rf "$staging"
    return 0
  fi

  # An existing empty directory may be a mount point, so seed it without replacing it.
  if ! cp -a "$staging"/. "$CONTENT_DIR"/; then
    rm -rf "$staging"
    return 1
  fi
  rm -rf "$staging"
}

prepare_snapshot() {
  local destination="$1"
  local quiet="${2:-false}"
  if [ "$quiet" = true ]; then
    node "$GENERATION_SCRIPT" prepare "$CONTENT_DIR" "$destination" >/dev/null &
  else
    node "$GENERATION_SCRIPT" prepare "$CONTENT_DIR" "$destination" &
  fi
  BUILD_CHILD_PID=$!
  local exit_code=0
  wait "$BUILD_CHILD_PID" || exit_code=$?
  BUILD_CHILD_PID=""
  return "$exit_code"
}

snapshot_signature() {
  local snapshot="$1"
  local signature
  [ -f "$snapshot/.publish-generation" ] || return 1
  signature="$(tr -d '\r\n' < "$snapshot/.publish-generation")"
  [[ "$signature" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "$signature"
}

recover_stale_build_lock() {
  [ -d "$BUILD_LOCK_DIR" ] || return 0
  local owner=""
  local owner_pid=""
  if [ -f "$BUILD_LOCK_DIR/owner" ]; then
    owner="$(cat "$BUILD_LOCK_DIR/owner" 2>/dev/null || true)"
    owner_pid="${owner%%-*}"
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    return 0
  fi
  rm -rf "$BUILD_LOCK_DIR"
}

acquire_build_lock() {
  if ! mkdir "$BUILD_LOCK_DIR" 2>/dev/null; then return 1; fi
  BUILD_LOCK_TOKEN="$$-$(date +%s)-$RANDOM"
  if ! printf '%s\n' "$BUILD_LOCK_TOKEN" > "$BUILD_LOCK_DIR/owner"; then
    rm -rf "$BUILD_LOCK_DIR"
    BUILD_LOCK_TOKEN=""
    return 1
  fi
}

release_build_lock() {
  if [ -n "$BUILD_LOCK_TOKEN" ] \
    && [ "$(cat "$BUILD_LOCK_DIR/owner" 2>/dev/null || true)" = "$BUILD_LOCK_TOKEN" ]; then
    rm -rf "$BUILD_LOCK_DIR"
  fi
  BUILD_LOCK_TOKEN=""
}

cleanup_build() {
  if [ -n "$BUILD_CHILD_PID" ]; then
    kill -TERM "$BUILD_CHILD_PID" 2>/dev/null || true
    wait "$BUILD_CHILD_PID" 2>/dev/null || true
    BUILD_CHILD_PID=""
  fi
  if [ -n "$CURRENT_BUILD_OUTPUT" ]; then
    local active_target=""
    local current_target=""
    current_target="$(cd "$CURRENT_BUILD_OUTPUT" 2>/dev/null && pwd -P)" || current_target=""
    if [ -L "$OUTPUT_DIR" ]; then
      active_target="$(cd "$(dirname "$OUTPUT_DIR")" \
        && cd "$(readlink "$OUTPUT_DIR")" 2>/dev/null \
        && pwd -P)" || active_target=""
    fi
    if [ -z "$current_target" ] || [ "$active_target" != "$current_target" ]; then
      rm -rf "$CURRENT_BUILD_OUTPUT"
    fi
    CURRENT_BUILD_OUTPUT=""
  fi
  if [ -n "$CURRENT_SNAPSHOT" ]; then
    rm -rf "$CURRENT_SNAPSHOT"
    CURRENT_SNAPSHOT=""
  fi
  release_build_lock
}

run_quartz_build() {
  local snapshot="$1"
  local output="$2"
  node "$GENERATION_SCRIPT" run "$QUARTZ_WORK_DIR" \
    npx quartz build \
    --directory "$snapshot" \
    --output "$output" \
    --concurrency "${QUARTZ_CONCURRENCY:-2}" &
  BUILD_CHILD_PID=$!
  local exit_code=0
  wait "$BUILD_CHILD_PID" || exit_code=$?
  BUILD_CHILD_PID=""
  return "$exit_code"
}

build_site() {
  local snapshot="$1"
  local signature="$2"
  if ! acquire_build_lock; then
    echo "Knowledge build skipped because another build owns $BUILD_LOCK_DIR" >&2
    rm -rf "$snapshot"
    if [ "$CURRENT_SNAPSHOT" = "$snapshot" ]; then CURRENT_SNAPSHOT=""; fi
    return 75
  fi
  CURRENT_SNAPSHOT="$snapshot"
  if ! CURRENT_BUILD_OUTPUT="$(mktemp -d "${BUILD_OUTPUT_PREFIX}.XXXXXX")"; then
    cleanup_build
    return 1
  fi

  if [ ! -f "$snapshot/index.md" ]; then
    if ! cp "$snapshot/README.md" "$snapshot/index.md"; then
      cleanup_build
      return 1
    fi
  fi

  if ! run_quartz_build "$snapshot" "$CURRENT_BUILD_OUTPUT"; then
    cleanup_build
    return 1
  fi
  if ! node "$FINALIZE_SCRIPT" "$CURRENT_BUILD_OUTPUT" "${QUARTZ_BASE_URL:-}"; then
    cleanup_build
    return 1
  fi
  if [ -n "$ASSERT_OUTPUT_SCRIPT" ] \
    && ! node "$ASSERT_OUTPUT_SCRIPT" "$CURRENT_BUILD_OUTPUT" "${QUARTZ_BASE_URL:-}"; then
    cleanup_build
    return 1
  fi
  if ! printf 'ok\n' > "$CURRENT_BUILD_OUTPUT/__health" \
    || ! printf '%s\n' "$signature" > "$CURRENT_BUILD_OUTPUT/.publish-generation"; then
    cleanup_build
    return 1
  fi
  if ! chmod -R a+rX "$CURRENT_BUILD_OUTPUT"; then
    cleanup_build
    return 1
  fi
  if ! node "$GENERATION_SCRIPT" activate \
    "$CURRENT_BUILD_OUTPUT" "$OUTPUT_DIR" "$BUILD_OUTPUT_PREFIX"; then
    cleanup_build
    return 1
  fi

  CURRENT_BUILD_OUTPUT=""
  rm -rf "$CURRENT_SNAPSHOT"
  CURRENT_SNAPSHOT=""
  release_build_lock
  return 0
}

initialize_seed_vault
recover_stale_build_lock

if [ -n "${QUARTZ_BASE_URL:-}" ]; then
  escaped_base_url="$(printf '%s\n' "$QUARTZ_BASE_URL" | sed 's/[\/&]/\\&/g')"
  sed -i "s#^  baseUrl:.*#  baseUrl: ${escaped_base_url}#" "$CONFIG_PATH"
fi

if [ -n "${KNOWLEDGE_WEB_URL:-}" ]; then
  knowledge_web_url="${KNOWLEDGE_WEB_URL%/}"
  escaped_web_url="$(printf '%s\n' "$knowledge_web_url" | sed 's/[\/&]/\\&/g')"
  escaped_admin_url="$(printf '%s\n' "${knowledge_web_url}/admin/knowledge/vault" | sed 's/[\/&]/\\&/g')"
  sed -i "s#^        业务系统:.*#        业务系统: ${escaped_web_url}#" "$CONFIG_PATH"
  sed -i "s#^        知识维护:.*#        知识维护: ${escaped_admin_url}#" "$CONFIG_PATH"
fi

initial_shutdown() {
  trap - TERM INT
  cleanup_build
  exit 143
}

trap initial_shutdown TERM INT
INITIAL_SNAPSHOT="$(mktemp -d "${BUILD_CONTENT_PREFIX}.initial.XXXXXX")"
CURRENT_SNAPSHOT="$INITIAL_SNAPSHOT"
if ! prepare_snapshot "$INITIAL_SNAPSHOT"; then
  rm -rf "$INITIAL_SNAPSHOT"
  CURRENT_SNAPSHOT=""
  exit 1
fi
if ! INITIAL_SIGNATURE="$(snapshot_signature "$INITIAL_SNAPSHOT")"; then
  rm -rf "$INITIAL_SNAPSHOT"
  CURRENT_SNAPSHOT=""
  exit 1
fi
if ! build_site "$INITIAL_SNAPSHOT" "$INITIAL_SIGNATURE"; then
  exit 1
fi

stop_watcher() {
  trap - TERM INT EXIT
  cleanup_build
  exit 0
}

watch_loop() {
  local last_signature="$1"
  local candidate next_signature
  trap stop_watcher TERM INT
  trap cleanup_build EXIT

  while sleep "$WATCH_INTERVAL_SECONDS"; do
    candidate="$(mktemp -d "${BUILD_CONTENT_PREFIX}.watch.XXXXXX")"
    CURRENT_SNAPSHOT="$candidate"
    if ! prepare_snapshot "$candidate" true; then
      echo "Knowledge snapshot validation failed; continuing to serve the previous generation" >&2
      rm -rf "$candidate"
      CURRENT_SNAPSHOT=""
      continue
    fi
    if ! next_signature="$(snapshot_signature "$candidate")"; then
      echo "Knowledge snapshot has no valid generation hash; continuing to serve the previous generation" >&2
      rm -rf "$candidate"
      CURRENT_SNAPSHOT=""
      continue
    fi
    if [ "$next_signature" = "$last_signature" ]; then
      rm -rf "$candidate"
      CURRENT_SNAPSHOT=""
      continue
    fi
    if build_site "$candidate" "$next_signature"; then
      last_signature="$next_signature"
      echo "Knowledge site rebuilt for content generation ${next_signature}"
    else
      echo "Knowledge site rebuild failed; continuing to serve the previous generation" >&2
    fi
  done
}

shutdown() {
  local exit_code="${1:-0}"
  trap - TERM INT
  if [ -n "$WATCHER_PID" ]; then
    kill -TERM "$WATCHER_PID" 2>/dev/null || true
    wait "$WATCHER_PID" 2>/dev/null || true
    WATCHER_PID=""
  fi
  if [ -n "$NGINX_PID" ]; then
    kill -TERM "$NGINX_PID" 2>/dev/null || true
    wait "$NGINX_PID" 2>/dev/null || true
    NGINX_PID=""
  fi
  cleanup_build
  exit "$exit_code"
}

trap 'shutdown 0' TERM INT
"$NGINX_BIN" -g "daemon off;" &
NGINX_PID=$!

if [ "${QUARTZ_WATCH_ENABLED:-true}" = "true" ]; then
  watch_loop "$INITIAL_SIGNATURE" &
  WATCHER_PID=$!
fi

nginx_exit=0
wait "$NGINX_PID" || nginx_exit=$?
NGINX_PID=""
shutdown "$nginx_exit"
