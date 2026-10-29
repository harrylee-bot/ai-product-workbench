#!/usr/bin/env bash

# Source from server-deploy.sh. The fixed host-wide lock also covers builders
# with different names and is held until cleanup has stopped the builder.
validation_build_images() (
  set -Eeuo pipefail
  trap - ERR
  command -v flock >/dev/null || { printf 'Workbench bounded build: flock is required\n' >&2; exit 69; }
  local compose_declaration status
  compose_declaration="$(declare -p COMPOSE 2>/dev/null)" \
    || { printf 'Workbench bounded build: COMPOSE must be a Bash array\n' >&2; exit 65; }
  if WORKBENCH_BUILD_BUILDER="${WORKBENCH_BUILD_BUILDER:-workbench-validation-bounded}" \
    WORKBENCH_BUILD_MEMORY_MIB="${WORKBENCH_BUILD_MEMORY_MIB:-6144}" \
    WORKBENCH_BUILD_RESERVE_MIB="${WORKBENCH_BUILD_RESERVE_MIB:-2048}" \
    WORKBENCH_BUILD_CPUS="${WORKBENCH_BUILD_CPUS:-2}" \
    flock --nonblock --conflict-exit-code 75 /run/lock/workbench-validation-build.lock \
      bash -c 'source "$1"; eval "$2"; shift 2; _validation_build_images_locked "$@"' \
      workbench-bounded-build "${BASH_SOURCE[0]}" "$compose_declaration" "$@"; then
    return 0
  else
    status=$?
    if [ "$status" -eq 75 ]; then
      printf 'Workbench bounded build: another validation build holds the host-wide lock\n' >&2
    fi
    return "$status"
  fi
)

_validation_build_images_locked() (
  set -Eeuo pipefail
  trap - ERR
  builder="${WORKBENCH_BUILD_BUILDER:-workbench-validation-bounded}"
  memory_mib="${WORKBENCH_BUILD_MEMORY_MIB:-6144}"
  reserve_mib="${WORKBENCH_BUILD_RESERVE_MIB:-2048}"
  cpus="${WORKBENCH_BUILD_CPUS:-2}"
  config="${BASH_SOURCE[0]%/*}/workbench-buildkitd.toml"
  scratch="" stop_builder=0

  build_fail() {
    printf 'Workbench bounded build: %s\n' "$*" >&2
    exit 65
  }
  build_cleanup() {
    local status=$?
    trap - EXIT
    if [ "$stop_builder" = 1 ]; then
      if ! docker buildx stop "$builder"; then
        printf 'Workbench bounded build: could not stop the verified builder %s\n' "$builder" >&2
        [ "$status" -ne 0 ] || status=1
      fi
    fi
    [ -z "$scratch" ] || rm -rf -- "$scratch"
    exit "$status"
  }
  trap build_cleanup EXIT

  [ "$(uname -s)" = Linux ] || build_fail 'server-side validation builds require a local Linux Docker host'
  for command in docker node awk mktemp; do
    command -v "$command" >/dev/null || build_fail "required command is missing: $command"
  done
  [[ "$builder" =~ ^workbench-validation-[a-z0-9][a-z0-9-]{0,39}$ ]] \
    || build_fail 'WORKBENCH_BUILD_BUILDER must use the workbench-validation- namespace (up to 60 characters)'
  [[ "$memory_mib" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$memory_mib" -ge 512 ] && [ "$memory_mib" -le 65536 ] \
    || build_fail 'WORKBENCH_BUILD_MEMORY_MIB must be an integer from 512 to 65536'
  [[ "$reserve_mib" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$reserve_mib" -ge 1024 ] && [ "$reserve_mib" -le 65536 ] \
    || build_fail 'WORKBENCH_BUILD_RESERVE_MIB must be an integer from 1024 to 65536'
  [[ "$cpus" =~ ^[1-8]$ ]] || build_fail 'WORKBENCH_BUILD_CPUS must be an integer from 1 to 8'
  declare -p COMPOSE 2>/dev/null | grep -q '^declare -a ' \
    || build_fail 'COMPOSE must be a Bash array'
  [ "${COMPOSE[0]:-}" = docker ] && [ "${COMPOSE[1]:-}" = compose ] \
    || build_fail 'COMPOSE must invoke docker compose'
  [ -r "$config" ] || build_fail 'the BuildKit resource policy is missing'
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/workbench-bounded-build.XXXXXXXX")"
  available_kib="$(awk '$1 == "MemAvailable:" && $3 == "kB" { print $2; found++ } END { if (found != 1) exit 1 }' /proc/meminfo)" \
    || build_fail 'cannot read Linux MemAvailable; refusing to build'
  [[ "$available_kib" =~ ^[0-9]{1,15}$ ]] || build_fail 'invalid Linux MemAvailable'
  [ "$available_kib" -ge "$(((memory_mib + reserve_mib) * 1024))" ] \
    || build_fail "insufficient MemAvailable: need ${memory_mib} MiB build budget plus ${reserve_mib} MiB reserved for running services"
  memory_bytes=$((memory_mib * 1024 * 1024))
  cpu_quota=$((cpus * 100000))
  endpoint="${DOCKER_HOST:-}"
  if [ -z "$endpoint" ] || [ -n "${DOCKER_CONTEXT:-}" ]; then
    endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' "$(docker context show)")" \
      || build_fail 'cannot determine the active Docker endpoint'
  fi
  case "$endpoint" in
    unix:///*) ;;
    *) build_fail 'the build memory guard only supports a local Unix-socket Docker endpoint' ;;
  esac
  docker info --format '{{json .}}' > "$scratch/info.json" \
    || build_fail 'cannot inspect Docker resource-limit support'
  node - "$scratch/info.json" "$(uname -n)" <<'NODE' || build_fail 'Docker must run on this Linux host and enforce memory, swap and CPU CFS limits'
const fs = require("node:fs");
const info = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (info.OSType !== "linux" || info.Name !== process.argv[3] || ["MemoryLimit", "SwapLimit", "CpuCfsPeriod", "CpuCfsQuota"].some(key => info[key] !== true)) process.exit(1);
NODE
  docker buildx ls --format '{{json .}}' > "$scratch/builders.jsonl" \
    || build_fail 'cannot inspect Buildx builders'
  existing="$(node - "$scratch/builders.jsonl" "$builder" <<'NODE'
const fs = require("node:fs");
const builders = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
console.log(builders.some(item => item.Name === process.argv[3]) ? "yes" : "no");
NODE
  )" || build_fail 'cannot parse the Buildx inventory'
  if [ "$existing" = no ]; then
    docker buildx create --name "$builder" --node "${builder}0" \
      --driver docker-container --buildkitd-config "$config" \
      --driver-opt "memory=$memory_bytes" \
      --driver-opt "memory-swap=$memory_bytes" \
      --driver-opt cpu-period=100000 --driver-opt "cpu-quota=$cpu_quota" \
      --driver-opt default-load=true \
      "$endpoint" >/dev/null || build_fail 'could not create the bounded builder'
    docker buildx ls --format '{{json .}}' > "$scratch/builders.jsonl" \
      || build_fail 'cannot verify the new Buildx builder'
  fi
  # Check persisted settings before starting an existing builder. Unknown or
  # drifted builders are never reconfigured, deleted, or selected globally.
  node - "$scratch/builders.jsonl" "$builder" "$endpoint" "$memory_bytes" "$cpu_quota" "$config" <<'NODE' \
    || build_fail 'builder settings differ from the bounded policy; use a fresh workbench-validation- name'
const fs = require("node:fs");
const [file, name, endpoint, memory, quota, config] = process.argv.slice(2);
const records = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(item => item.Name === name);
if (records.length === 0) process.exit(1);
const allowedFlags = [[], ["--allow-insecure-entitlement=network.host"], ["--allow-insecure-entitlement", "network.host"]];
const policy = value => String(value).replace(/#[^\n]*/g, "").replace(/\s/g, "").replace(/\'/g, "\"").replace(/\[worker\]/g, "").replace(/\[registry\]/g, "");
const expectedPolicies = new Set([
  "[worker.oci]max-parallelism=1[registry.\"docker.io\"]mirrors=[\"docker.m.daocloud.io\"]",
  "[registry.\"docker.io\"]mirrors=[\"docker.m.daocloud.io\"][worker.oci]max-parallelism=1",
]);
if (!expectedPolicies.has(policy(fs.readFileSync(config, "utf8")))) process.exit(1);
for (const builder of records) {
  if (builder.Driver !== "docker-container" || builder.Nodes?.length !== 1) process.exit(1);
  const node = builder.Nodes[0];
  if (node.Name !== `${name}0` || node.Endpoint !== endpoint) process.exit(1);
  if (!allowedFlags.some(flags => JSON.stringify(flags) === JSON.stringify(node.Flags ?? []))) process.exit(1);
  const expected = { memory, "memory-swap": memory, "cpu-period": "100000", "cpu-quota": quota, "default-load": "true" };
  if (JSON.stringify(Object.keys(node.DriverOpts ?? {}).sort()) !== JSON.stringify(Object.keys(expected).sort())) process.exit(1);
  if (Object.entries(expected).some(([key, value]) => node.DriverOpts[key] !== value)) process.exit(1);
  const configData = node.Files?.["buildkitd.toml"];
  if (typeof configData !== "string" || !expectedPolicies.has(policy(Buffer.from(configData, "base64").toString("utf8")))) process.exit(1);
}
NODE
  stop_builder=1
  docker buildx inspect --bootstrap "$builder" >/dev/null \
    || build_fail 'the bounded builder could not start'
  docker inspect --type container "buildx_buildkit_${builder}0" > "$scratch/container.json" \
    || build_fail 'cannot verify the running builder limits'
  node - "$scratch/container.json" "$memory_bytes" "$cpu_quota" <<'NODE' \
    || build_fail 'the running builder does not enforce the requested resource limits'
const fs = require("node:fs");
const [file, memory, quota] = process.argv.slice(2);
const containers = JSON.parse(fs.readFileSync(file, "utf8"));
if (containers.length !== 1) process.exit(1);
const container = containers[0];
const limits = container.HostConfig;
if (!container.State?.Running || limits?.Memory !== Number(memory) || limits.MemorySwap !== Number(memory) || limits.CpuPeriod !== 100000 || limits.CpuQuota !== Number(quota)) process.exit(1);
const allowedFlags = [[], ["--allow-insecure-entitlement=network.host"], ["--allow-insecure-entitlement", "network.host"]];
if (!allowedFlags.some(flags => JSON.stringify(["--config", "/etc/buildkit/buildkitd.toml", ...flags]) === JSON.stringify(container.Config?.Cmd))) process.exit(1);
NODE
  docker exec "buildx_buildkit_${builder}0" cat /etc/buildkit/buildkitd.toml > "$scratch/active.toml" \
    || build_fail 'cannot read the running BuildKit policy'
  node - "$scratch/active.toml" <<'NODE' || build_fail 'the running BuildKit policy must allow only one build step at a time'
const fs = require("node:fs");
const policy = fs.readFileSync(process.argv[2], "utf8").replace(/#[^\n]*/g, "").replace(/\s/g, "").replace(/\'/g, "\"").replace(/\[worker\]/g, "").replace(/\[registry\]/g, "");
const expectedPolicies = new Set([
  "[worker.oci]max-parallelism=1[registry.\"docker.io\"]mirrors=[\"docker.m.daocloud.io\"]",
  "[registry.\"docker.io\"]mirrors=[\"docker.m.daocloud.io\"][worker.oci]max-parallelism=1",
]);
if (!expectedPolicies.has(policy)) process.exit(1);
NODE
  printf 'Building with %s: %s MiB RAM, %s CPU(s), one build step; required %s MiB service headroom at start.\n' \
    "$builder" "$memory_mib" "$cpus" "$reserve_mib"
  COMPOSE_BAKE=false DOCKER_BUILDKIT=1 \
    "${COMPOSE[@]}" --parallel 1 build --builder "$builder" --with-dependencies "$@"
)
