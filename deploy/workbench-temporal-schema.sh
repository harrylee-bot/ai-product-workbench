#!/bin/sh
set -eu
: "${POSTGRES_SEEDS:?}" "${POSTGRES_USER:?}" "${SQL_PASSWORD:?}"
for database in temporal temporal_visibility; do
  schema=temporal
  [ "$database" != temporal_visibility ] || schema=visibility
  # setup-schema preserves a newer existing schema; update-schema applies only
  # missing ordered migrations. Never use --overwrite or drop a database.
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -p 5432 \
    -u "$POSTGRES_USER" --db "$database" setup-schema -v 0.0
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -p 5432 \
    -u "$POSTGRES_USER" --db "$database" update-schema \
    -d "/etc/temporal/schema/postgresql/v12/$schema/versioned"
done
