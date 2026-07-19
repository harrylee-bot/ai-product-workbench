#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
current="${WORKBENCH_OPENAPI_CURRENT:-$repo_root/packages/workbench-contracts/openapi/workbench.v1.yaml}"
baseline="${WORKBENCH_OPENAPI_BASELINE:-$repo_root/packages/workbench-contracts/openapi/baseline/workbench.v1.yaml}"
oasdiff_version="v1.23.0"

resolve_oasdiff() {
  local binary="${WORKBENCH_OASDIFF_BIN:-}"
  local reported_version=""

  if [[ -z "$binary" ]]; then
    binary="$(node "$repo_root/scripts/resolve-oasdiff.mjs" --print)" || exit $?
  fi
  if [[ -z "$binary" || ! -x "$binary" ]]; then
    printf 'oasdiff %s is required; install the pinned binary before running this check.\n' "$oasdiff_version" >&2
    exit 69
  fi

  reported_version="$($binary -v 2>&1)"
  case "$reported_version" in
    "oasdiff version $oasdiff_version" | "oasdiff version ${oasdiff_version#v}") ;;
    *)
      printf 'oasdiff version mismatch: expected %s, got %s\n' "$oasdiff_version" "$reported_version" >&2
      exit 69
      ;;
  esac

  printf '%s\n' "$binary"
}

case "${1:-check}" in
  baseline)
    mkdir -p "$(dirname "$baseline")"
    cp "$current" "$baseline"
    printf 'OpenAPI baseline updated: %s\n' "${baseline#"$repo_root/"}"
    ;;
  check)
    if [[ ! -f "$baseline" ]]; then
      printf 'OpenAPI baseline is missing. Review the generated contract, then run npm run openapi:baseline.\n' >&2
      exit 1
    fi
    if [[ ! -f "$current" ]]; then
      printf 'Current OpenAPI contract is missing: %s\n' "$current" >&2
      exit 1
    fi
    oasdiff_binary="$(resolve_oasdiff)"
    exec "$oasdiff_binary" breaking "$baseline" "$current" --fail-on ERR
    ;;
  *)
    printf 'Usage: %s [baseline|check]\n' "${0##*/}" >&2
    exit 2
    ;;
esac
