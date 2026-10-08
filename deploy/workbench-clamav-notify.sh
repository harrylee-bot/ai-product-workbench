#!/bin/sh
# Freshclam also invokes this hook during the first, synchronous database
# download, before /init can start clamd. Return immediately and let a bounded
# child wait for clamd; waiting inside the hook would hold up that first boot.
set -eu

log() {
    printf '%s\n' "[workbench-clamav] $*"
}

if [ "${1:-}" != "--worker" ]; then
    script_path="$(command -v "$0")"
    sh "$script_path" --worker </dev/null &
    log "Queued database reload verification (pid $!)."
    exit 0
fi

log "Waiting for scanner readiness after a database update."
if ! timeout 310 clamdscan --config-file=/etc/clamav/clamd.conf --ping=150:2 >/dev/null 2>&1; then
    log "ERROR: Scanner did not become ready within 310 seconds; signature-age checks remain enforced." >&2
    exit 1
fi
if ! disk_version="$(timeout 15 clamscan --version)"; then
    log "ERROR: Could not read the database version on disk." >&2
    exit 1
fi
if ! loaded_version="$(timeout 15 clamdscan --config-file=/etc/clamav/clamd.conf --version)"; then
    log "ERROR: Could not read the scanner's loaded database version." >&2
    exit 1
fi
if [ "$disk_version" = "$loaded_version" ]; then
    log "Confirmed loaded database: $loaded_version"
    exit 0
fi

# Keep the deployment's ConcurrentDatabaseReload=no memory protection.
if timeout 15 clamdscan --config-file=/etc/clamav/clamd.conf --reload >/dev/null 2>&1; then
    log "Requested reload after a database version mismatch; waiting for the loaded version."
else
    status=$?
    log "ERROR: Scanner rejected the reload request (exit $status)." >&2
    exit "$status"
fi

# RELOAD only acknowledges the request. Check the running daemon afterwards.
# At most 30 ten-second reads and 29 two-second delays: bounded to 358 seconds.
attempt=1
while [ "$attempt" -le 30 ]; do
    if loaded_version="$(timeout 10 clamdscan --config-file=/etc/clamav/clamd.conf --version)" \
        && [ "$disk_version" = "$loaded_version" ]; then
        log "Confirmed loaded database: $loaded_version"
        exit 0
    fi
    [ "$attempt" -eq 30 ] || sleep 2
    attempt=$((attempt + 1))
done
log "ERROR: Reload was acknowledged but the expected database was not confirmed: $disk_version" >&2
exit 1
