#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEERFLOW_SOURCE_DIR="${DEERFLOW_SOURCE_DIR:?Set DEERFLOW_SOURCE_DIR to the DeerFlow source checkout}"
PATCH_DIR="${REPO_ROOT}/integrations/deerflow/patches"

for patch_file in "${PATCH_DIR}"/*.patch; do
  if git -C "$DEERFLOW_SOURCE_DIR" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    echo "Already applied: $(basename "$patch_file")"
    continue
  fi
  git -C "$DEERFLOW_SOURCE_DIR" apply --check "$patch_file"
  git -C "$DEERFLOW_SOURCE_DIR" apply "$patch_file"
  echo "Applied: $(basename "$patch_file")"
done
