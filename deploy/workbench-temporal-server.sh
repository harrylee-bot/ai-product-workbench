#!/bin/sh
set -eu
# The pinned server image ships the server binary without dockerize, the CLI,
# or a writable configuration directory. Generate only private runtime config.
: "${POSTGRES_PWD:?}"
case "$POSTGRES_PWD" in *[!A-Za-z0-9_-]*) echo 'Temporal password must be base64url' >&2; exit 1 ;; esac
[ "${#POSTGRES_PWD}" -ge 32 ] || { echo 'Temporal password is too short' >&2; exit 1; }
umask 077
mkdir -p /tmp/temporal-config
address=$(getent hosts "$(hostname)" | awk 'NR==1 {print $1}')
cat > /tmp/temporal-config/server.yaml <<EOF
log:
  stdout: true
  level: info
persistence:
  numHistoryShards: 4
  defaultStore: default
  visibilityStore: visibility
  datastores:
    default:
      sql: &sql
        pluginName: postgres12
        databaseName: temporal
        connectAddr: temporal-postgres:5432
        connectProtocol: tcp
        user: temporal_owner
        password: '$POSTGRES_PWD'
        maxConns: 5
        maxIdleConns: 5
        maxConnLifetime: 1h
    visibility:
      sql:
        <<: *sql
        databaseName: temporal_visibility
        maxConns: 2
        maxIdleConns: 2
global:
  membership:
    maxJoinDuration: 30s
    broadcastAddress: $address
services:
  frontend:
    rpc: {grpcPort: 7233, membershipPort: 6933, bindOnIP: 0.0.0.0}
  matching:
    rpc: {grpcPort: 7235, membershipPort: 6935, bindOnIP: 0.0.0.0}
  history:
    rpc: {grpcPort: 7234, membershipPort: 6934, bindOnIP: 0.0.0.0}
  worker:
    rpc: {grpcPort: 7239, membershipPort: 6939, bindOnIP: 0.0.0.0}
clusterMetadata:
  enableGlobalNamespace: false
  failoverVersionIncrement: 10
  masterClusterName: active
  currentClusterName: active
  clusterInformation:
    active:
      enabled: true
      initialFailoverVersion: 1
      rpcAddress: workbench-temporal:7233
publicClient:
  hostPort: 127.0.0.1:7233
EOF
# Authorization is supplied by the isolated Docker network: no host ports,
# no ingress network, and a separate persistence network. The deployment also
# checks gRPC cluster health and namespace readiness through the admin image.
exec temporal-server --config-file /tmp/temporal-config/server.yaml --allow-no-auth start
