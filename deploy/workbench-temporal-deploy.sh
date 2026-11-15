#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${WORKBENCH_ENV_FILE:?WORKBENCH_ENV_FILE is required}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$SCRIPT_DIR/workbench-temporal-compose.yml")
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 temporal-postgres
"${COMPOSE[@]}" run --rm --no-deps temporal-schema
"${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 180 workbench-temporal
"${COMPOSE[@]}" run --rm --no-deps temporal-namespace
