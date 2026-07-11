#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTRYPOINT="$ROOT_DIR/apps/knowledge/docker-entrypoint.sh"
FINALIZER="$ROOT_DIR/apps/knowledge/finalize-output.mjs"
GENERATION_MANAGER="$ROOT_DIR/apps/knowledge/publish-generation.mjs"
ASSERT_OUTPUT="$ROOT_DIR/apps/knowledge/test-fixtures/assert-output.mjs"
FIXTURE_BIN="$ROOT_DIR/apps/knowledge/test-fixtures/bin"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aipw-quartz-watcher.XXXXXX")"
SEED_DIR="$TEST_ROOT/seed"
CONTENT_DIR="$TEST_ROOT/content"
OUTPUT_DIR="$TEST_ROOT/output"
BUILD_PREFIX="$TEST_ROOT/build/content"
BUILD_OUTPUT_PREFIX="$TEST_ROOT/build/output.generation"
COUNT_FILE="$TEST_ROOT/build-count"
FAIL_FILE="$TEST_ROOT/fail-build"
DELAY_FILE="$TEST_ROOT/build-delay"
GAP_FILE="$TEST_ROOT/output-gap"
NGINX_PID_FILE="$TEST_ROOT/nginx-pid"
LOG_FILE="$TEST_ROOT/entrypoint.log"
ENTRYPOINT_PID=""

cleanup() {
  if [ -n "$ENTRYPOINT_PID" ] && kill -0 "$ENTRYPOINT_PID" 2>/dev/null; then
    kill -TERM "$ENTRYPOINT_PID" 2>/dev/null || true
    wait "$ENTRYPOINT_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  echo "watcher test failed: $1" >&2
  if [ -f "$LOG_FILE" ]; then
    echo "--- entrypoint log ---" >&2
    tail -n 80 "$LOG_FILE" >&2
  fi
  exit 1
}

read_count() {
  if [ -f "$COUNT_FILE" ]; then cat "$COUNT_FILE"; else printf '0\n'; fi
}

wait_for_count() {
  local minimum="$1"
  local attempts=0
  while [ "$(read_count)" -lt "$minimum" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || fail "build count did not reach $minimum"
    sleep 0.05
  done
}

wait_for_target_change() {
  local previous="$1"
  local attempts=0
  while [ ! -L "$OUTPUT_DIR" ] || [ "$(readlink "$OUTPUT_DIR")" = "$previous" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || fail "output generation did not change"
    sleep 0.05
  done
}

wait_for_output() {
  local attempts=0
  while [ ! -L "$OUTPUT_DIR" ] || [ ! -f "$OUTPUT_DIR/__health" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || fail "healthy output generation was not activated"
    sleep 0.05
  done
}

wait_for_file() {
  local file_path="$1"
  local attempts=0
  while [ ! -s "$file_path" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || fail "file was not created: $file_path"
    sleep 0.05
  done
}

start_entrypoint() {
  local watch_enabled="$1"
  rm -f "$NGINX_PID_FILE"
  env \
    NODE_ENV=test \
    PATH="$FIXTURE_BIN:$PATH" \
    QUARTZ_CONTENT_DIR="$CONTENT_DIR" \
    QUARTZ_OUTPUT_DIR="$OUTPUT_DIR" \
    QUARTZ_BUILD_CONTENT_DIR="$BUILD_PREFIX" \
    QUARTZ_BUILD_OUTPUT_DIR="$BUILD_OUTPUT_PREFIX" \
    QUARTZ_FINALIZE_SCRIPT="$FINALIZER" \
    QUARTZ_GENERATION_SCRIPT="$GENERATION_MANAGER" \
    QUARTZ_ASSERT_OUTPUT_SCRIPT="$ASSERT_OUTPUT" \
    QUARTZ_SEED_DIR="$SEED_DIR" \
    QUARTZ_WORK_DIR="$TEST_ROOT" \
    QUARTZ_NGINX_BIN="nginx" \
    QUARTZ_WATCH_ENABLED="$watch_enabled" \
    QUARTZ_WATCH_INTERVAL_SECONDS="0.1" \
    QUARTZ_TEST_BUILD_COUNT_FILE="$COUNT_FILE" \
    QUARTZ_TEST_FAIL_FILE="$FAIL_FILE" \
    QUARTZ_TEST_NGINX_PID_FILE="$NGINX_PID_FILE" \
    QUARTZ_TEST_DELAY_FILE="$DELAY_FILE" \
    QUARTZ_TEST_FORCE_LEGACY_RENAME_EXDEV=true \
    bash "$ENTRYPOINT" > "$LOG_FILE" 2>&1 &
  ENTRYPOINT_PID=$!
}

mkdir -p "$SEED_DIR/00-知识库使用规范" "$TEST_ROOT/build"
printf '%s\n' \
  '---' 'title: 测试知识库' 'status: 已生效' 'tags: [测试]' '---' \
  '# 测试知识库' 'seed-home' > "$SEED_DIR/README.md"
printf '%s\n' \
  '---' 'title: 测试规则' 'status: 已生效' 'tags: [测试]' '---' \
  '# 测试规则' 'seed-rule' > "$SEED_DIR/00-知识库使用规范/规则.md"
mkdir -p "$OUTPUT_DIR"
printf '<!doctype html><html><body>legacy</body></html>\n' > "$OUTPUT_DIR/index.html"

# First startup seeds an absent vault and produces one complete generation.
start_entrypoint true
wait_for_count 1
wait_for_output
wait_for_file "$NGINX_PID_FILE"
nginx_pid="$(cat "$NGINX_PID_FILE")"
[ -L "$OUTPUT_DIR" ] || fail "output is not an atomic generation symlink"
[ -f "$OUTPUT_DIR/__health" ] || fail "first generation has no health marker"
grep -q '"legacyMigration":"copy"' "$LOG_FILE" || fail "cross-device legacy fallback was not exercised"
grep -q 'seed-home' "$CONTENT_DIR/README.md" || fail "seed vault was not initialized"
first_target="$(readlink "$OUTPUT_DIR")"
first_count="$(read_count)"
sleep 0.35
[ "$(read_count)" = "$first_count" ] || fail "unchanged content triggered a rebuild"

# Excluded content and mtime-only changes do not alter the publish generation.
mkdir -p "$CONTENT_DIR/99-收件箱"
printf '%s\n' '---' 'title: 私有记录' 'status: 已生效' 'tags: [私有]' '---' '# 私有记录' 'private' \
  > "$CONTENT_DIR/99-收件箱/私有.md"
touch "$CONTENT_DIR/00-知识库使用规范/规则.md"
sleep 0.35
[ "$(read_count)" = "$first_count" ] || fail "non-published or mtime-only change triggered a rebuild"

# A published content change builds and atomically switches generations.
printf '0.2\n' > "$DELAY_FILE"
(
  for _ in $(seq 1 200); do
    [ -f "$OUTPUT_DIR/index.html" ] || : > "$GAP_FILE"
    sleep 0.003
  done
) &
reader_pid=$!
printf '\nchanged-once\n' >> "$CONTENT_DIR/00-知识库使用规范/规则.md"
wait_for_count 2
wait_for_target_change "$first_target"
wait "$reader_pid"
rm -f "$DELAY_FILE"
second_target="$(readlink "$OUTPUT_DIR")"
grep -q 'Build 2' "$OUTPUT_DIR/index.html" || fail "second generation was not activated"
[ ! -e "$GAP_FILE" ] || fail "output path disappeared during generation activation"
[ ! -e "${COUNT_FILE}.overlap" ] || fail "watcher started overlapping builds"

# A failed build never replaces the last healthy generation and is retried.
: > "$FAIL_FILE"
printf '\nfailed-generation\n' >> "$CONTENT_DIR/00-知识库使用规范/规则.md"
wait_for_count 3
sleep 0.1
[ "$(readlink "$OUTPUT_DIR")" = "$second_target" ] || fail "failed build replaced the active generation"
grep -q 'Build 2' "$OUTPUT_DIR/index.html" || fail "failed build damaged the previous output"
if find "$TEST_ROOT/build" -name partial.txt -print -quit | grep -q .; then
  fail "failed build left a partial generation"
fi
rm -f "$FAIL_FILE"
wait_for_target_change "$second_target"
grep -q 'Build ' "$OUTPUT_DIR/index.html" || fail "retry did not activate a healthy generation"

# SIGTERM during a slow rebuild cleans the child build and leaves the active output intact.
stable_target="$(readlink "$OUTPUT_DIR")"
printf '2\n' > "$DELAY_FILE"
printf '\nslow-generation\n' >> "$CONTENT_DIR/00-知识库使用规范/规则.md"
previous_count="$(read_count)"
wait_for_count $((previous_count + 1))
kill -TERM "$ENTRYPOINT_PID"
wait "$ENTRYPOINT_PID" 2>/dev/null || true
ENTRYPOINT_PID=""
sleep 0.1
[ ! -n "$nginx_pid" ] || ! kill -0 "$nginx_pid" 2>/dev/null || fail "nginx child survived SIGTERM"
[ ! -e "${COUNT_FILE}.active" ] || fail "build child survived SIGTERM"
[ "$(readlink "$OUTPUT_DIR")" = "$stable_target" ] || fail "interrupted build replaced the active output"
generation_count="$(find "$TEST_ROOT/build" -maxdepth 1 -type d -name 'output.generation.*' | wc -l | tr -d ' ')"
[ "$generation_count" -le 2 ] || fail "interrupted build left orphan generations"

# Restarting with a populated shared vault must not restore seed content over user changes.
rm -f "$DELAY_FILE"
printf '\nkept-across-restart\n' >> "$CONTENT_DIR/README.md"
start_entrypoint false
wait_for_count $((previous_count + 2))
wait_for_file "$NGINX_PID_FILE"
restart_nginx_pid="$(cat "$NGINX_PID_FILE")"
grep -q 'kept-across-restart' "$CONTENT_DIR/README.md" || fail "restart overwrote the populated vault"
kill -TERM "$ENTRYPOINT_PID"
wait "$ENTRYPOINT_PID" 2>/dev/null || true
ENTRYPOINT_PID=""
[ ! -n "$restart_nginx_pid" ] || ! kill -0 "$restart_nginx_pid" 2>/dev/null || fail "restart nginx child survived SIGTERM"

echo "Quartz watcher staging test passed"
