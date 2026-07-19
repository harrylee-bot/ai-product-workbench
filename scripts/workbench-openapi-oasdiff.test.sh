#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$repo_root/scripts/fixtures/openapi-breaking"
check="$repo_root/scripts/workbench-openapi-oasdiff.sh"

WORKBENCH_OPENAPI_BASELINE="$fixture_root/baseline.yaml" \
WORKBENCH_OPENAPI_CURRENT="$fixture_root/compatible.yaml" \
  bash "$check" check >/dev/null

if WORKBENCH_OPENAPI_BASELINE="$fixture_root/baseline.yaml" \
  WORKBENCH_OPENAPI_CURRENT="$fixture_root/breaking.yaml" \
  bash "$check" check >/dev/null 2>&1; then
  printf 'Expected the breaking OpenAPI fixture to fail.\n' >&2
  exit 1
fi

printf 'OpenAPI breaking fixtures: compatible PASS, breaking rejected PASS\n'
