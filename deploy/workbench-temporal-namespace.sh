#!/bin/sh
set -eu
: "${TEMPORAL_ADDRESS:?}" "${TEMPORAL_NAMESPACE:?}"
attempt=0
until temporal operator cluster health --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { echo 'Temporal readiness timed out' >&2; exit 1; }
  sleep 2
done
if ! temporal operator namespace describe --namespace "$TEMPORAL_NAMESPACE" >/dev/null 2>&1; then
  temporal operator namespace create --namespace "$TEMPORAL_NAMESPACE" --retention 168h
fi
temporal operator namespace describe --namespace "$TEMPORAL_NAMESPACE"
