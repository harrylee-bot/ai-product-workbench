#!/usr/bin/env node

import { readFileSync } from "node:fs";

import YAML from "yaml";

const compose = readYaml("deploy/workbench-compose.yml");
const runtime = readYaml("deploy/deerflow-runtime-compose.yml");
const serverDeploy = read("deploy/server-deploy.sh");
const productionPreflight = read("deploy/workbench-production-preflight.sh");
const deerflowProductionPreflight = read("deploy/deerflow-production-preflight.sh");
const productionCaddy = read("deploy/workbench-production.Caddyfile");
const readme = read("README.md");
const envExample = read("deploy/workbench.env.example");

const deerflow = runtime.services?.deerflow;
assert(deerflow, "standalone DeerFlow service is required");
assert(deerflow.pull_policy === "never", "DeerFlow must be resolved before Compose starts it");
assert(String(deerflow.image).includes("WORKBENCH_DEERFLOW_IMAGE_REF"), "DeerFlow must use the pinned image ref");
assert(runtime.networks?.["workbench-runtime"]?.external === true, "DeerFlow must join the explicit Workbench network");
assert(deerflow.networks?.["workbench-runtime"]?.aliases?.includes("deerflow"), "DeerFlow alias must be stable");
assert(deerflow.healthcheck, "DeerFlow readiness healthcheck is required");
assert(deerflow.read_only === true, "DeerFlow root filesystem must be read-only");
assert(
  serverDeploy.includes('chown -R "$DEERFLOW_RUNTIME_UID:$DEERFLOW_RUNTIME_GID" "$runtime_home"')
    && serverDeploy.includes('chown "$DEERFLOW_RUNTIME_UID:$DEERFLOW_RUNTIME_GID" "$effective_config"'),
  "DeerFlow deploy must transfer private runtime paths to the pinned non-root identity",
);
assert(
  deerflowProductionPreflight.includes("effective config must be owned by the DeerFlow runtime identity 65532:65532")
    && deerflowProductionPreflight.includes("DeerFlow home must be owned by the DeerFlow runtime identity 65532:65532"),
  "DeerFlow preflight must reject root-owned runtime paths",
);

for (const name of ["workbench-api", "workbench-worker"]) {
  const service = compose.services?.[name];
  assert(service?.environment?.DEERFLOW_GATEWAY_URL?.includes("WORKBENCH_DEERFLOW_GATEWAY_URL"), `${name} must declare the DeerFlow gateway URL`);
  assert(envExample.includes("WORKBENCH_DEERFLOW_GATEWAY_URL=http://deerflow:8001"), "the deployment URL must resolve through the internal DeerFlow alias");
  assert(service?.depends_on?.migrate?.condition === "service_completed_successfully", `${name} must wait for migrations`);
}
assert(compose.services?.migrate?.depends_on?.postgres?.condition === "service_healthy", "migrator must wait for healthy PostgreSQL");
assert(
  compose.services?.migrate?.environment?.WORKBENCH_DATABASE_URL
    === "${WORKBENCH_MIGRATOR_DATABASE_URL:?WORKBENCH_MIGRATOR_DATABASE_URL is required and must use the postgres service hostname}",
  "migrator must use the dedicated migrator database URL",
);
assert(
  String(compose.services?.migrate?.environment?.WORKBENCH_POSTGRES_ADMIN_URL).includes("WORKBENCH_POSTGRES_ADMIN_URL"),
  "only the migrator receives the infrastructure-admin database URL",
);
for (const name of [
  "workbench-api",
  "workbench-web",
  "workbench-worker",
  "workbench-file-worker",
  "workbench-import-worker",
  "workbench-export-worker",
  "workbench-preview",
]) {
  const service = compose.services?.[name];
  assert(
    service?.environment?.WORKBENCH_DATABASE_URL
      === "${WORKBENCH_DATABASE_URL:?WORKBENCH_DATABASE_URL is required and must use the postgres service hostname}",
    `${name} must use the runtime database URL`,
  );
  assert(!Object.hasOwn(service.environment ?? {}, "WORKBENCH_POSTGRES_ADMIN_URL"), `${name} must not receive the admin database URL`);
  assert(!Object.hasOwn(service.environment ?? {}, "WORKBENCH_MIGRATOR_DATABASE_URL"), `${name} must not receive the migrator database URL`);
}
for (const marker of [
  "WORKBENCH_POSTGRES_ADMIN_URL=",
  "WORKBENCH_MIGRATOR_DATABASE_URL=",
  "WORKBENCH_POSTGRES_MIGRATOR_USER=",
  "WORKBENCH_POSTGRES_RUNTIME_USER=",
]) {
  assert(envExample.includes(marker), `deployment env must declare ${marker}`);
}
assert(compose.services?.["workbench-api"]?.depends_on?.migrate?.condition === "service_completed_successfully", "API must wait for migrator");
assert(
  compose.services?.["workbench-worker"]?.environment?.WORKBENCH_CANVAS_VISUAL_URL
    === "${WORKBENCH_CANVAS_VISUAL_URL:?WORKBENCH_CANVAS_VISUAL_URL is required and must be the public HTTPS Canvas visual capability base URL}",
  "Runtime Worker must receive the required Canvas visual capability base URL",
);
assert(
  envExample.includes("WORKBENCH_CANVAS_VISUAL_URL=https://aionbench.com/api/v1/runtime/canvas/visuals"),
  "deployment env must declare the Canvas visual capability base URL",
);
assert(
  compose.services?.["workbench-worker"]?.environment?.WORKBENCH_RUNTIME_PROVIDER_STATE_MODE
    === "${WORKBENCH_RUNTIME_PROVIDER_STATE_MODE:?WORKBENCH_RUNTIME_PROVIDER_STATE_MODE is required}",
  "Runtime Worker must receive an explicit required provider-state mode",
);
assert(
  envExample.includes("WORKBENCH_RUNTIME_PROVIDER_STATE_MODE=projection-required"),
  "deployment env must keep Runtime provider-state reads on the verified projection",
);
assert(
  productionPreflight.includes("WORKBENCH_RUNTIME_PROVIDER_STATE_MODE must be projection-required"),
  "production preflight must reject the legacy Runtime provider-state replay path",
);
const preview = compose.services?.["workbench-preview"];
assert(preview, "Preview service is required");
assert(
  preview.environment?.WORKBENCH_PREVIEW_SPOOL_DIR === "/var/lib/workbench-preview",
  "Preview must stage verified HTML in the dedicated disk-backed directory",
);
assert(
  preview.environment?.WORKBENCH_PREVIEW_MAX_CONCURRENCY === "${WORKBENCH_PREVIEW_MAX_CONCURRENCY:-4}",
  "Preview must use the capacity-tested default concurrency",
);
assert(
  preview.volumes?.includes("workbench-preview-spool:/var/lib/workbench-preview"),
  "Preview must mount its dedicated spool volume",
);
assert(
  Object.hasOwn(compose.volumes ?? {}, "workbench-preview-spool"),
  "Preview spool volume must be declared",
);
assert(
  envExample.includes("WORKBENCH_PREVIEW_SPOOL_DIR=/var/lib/workbench-preview")
    && envExample.includes("WORKBENCH_PREVIEW_MAX_CONCURRENCY=4"),
  "deployment env must document the capacity-tested Preview spool contract",
);
const api = compose.services?.["workbench-api"];
assert(
  api?.environment?.WORKBENCH_READY_OBJECT_SPOOL_DIR
    === "/var/lib/workbench-api/ready-object-spool",
  "API must stage untrusted ready-object bytes in its dedicated disk directory",
);
assert(
  api?.volumes?.includes(
    "workbench-api-ready-object-spool:/var/lib/workbench-api/ready-object-spool",
  ),
  "API must mount the dedicated ready-object spool volume",
);
assert(
  Object.hasOwn(compose.volumes ?? {}, "workbench-api-ready-object-spool"),
  "API ready-object spool volume must be declared",
);
assert(
  envExample.includes(
    "WORKBENCH_READY_OBJECT_SPOOL_DIR=/var/lib/workbench-api/ready-object-spool",
  ),
  "deployment env must document the ready-object spool boundary",
);

for (const marker of [
  "prepare_deerflow_runtime",
  "wait_for_deerflow",
  "prepare_direct_images",
  "--no-build",
  "compose_up_force_recreate",
  "--force-recreate",
  "already occupied by container",
  "on_deploy_error",
  "RUNTIME_QUEUE_PARTICIPANTS",
  "stop_runtime_queue_participants",
  "run_runtime_queue_migrator",
  "Runtime queue reconciliation failed closed",
]) {
  assert(serverDeploy.includes(marker), `server deploy is missing ${marker}`);
}
for (const [label, source] of [
  ["server deploy", serverDeploy],
  ["Workbench production preflight", productionPreflight],
  ["DeerFlow production preflight", deerflowProductionPreflight],
]) {
  assert(!source.includes("production-image-inventory"), `${label} must not depend on the retired image inventory`);
  assert(!source.includes("COSIGN"), `${label} must not depend on the retired signing contract`);
}
assert(!envExample.includes("WORKBENCH_IMAGE_INVENTORY"), "deployment env must not expose the retired image inventory");
assert(!envExample.includes("WORKBENCH_COSIGN"), "deployment env must not expose the retired signing contract");
assert(productionPreflight.includes("config --quiet"), "production preflight must render the base Compose topology");
assert(
  productionPreflight.includes("assert-workbench-database-role-contract.mjs"),
  "production preflight must verify database role separation",
);
assert(productionPreflight.includes("WORKBENCH_POSTGRES_IMAGE must be an immutable digest reference"), "production PostgreSQL image must be digest-pinned");
assert(productionPreflight.includes("WORKBENCH_NGINX_IMAGE must be an immutable digest reference"), "production Nginx image must be digest-pinned");
assert(productionPreflight.includes("WORKBENCH_NODE_IMAGE must be an immutable digest reference"), "production Node base image must be digest-pinned");
assert(envExample.includes("WORKBENCH_NODE_IMAGE=node:22-alpine"), "deployment env must expose the hardened Node base image input");
assert(compose.services?.["workbench-api"]?.build?.args?.NODE_IMAGE?.includes("WORKBENCH_NODE_IMAGE"), "API build must consume the pinned Node base image input");
assert(compose.services?.knowledge?.build?.args?.NGINX_IMAGE?.includes("WORKBENCH_NGINX_IMAGE"), "Quartz build must consume the pinned Nginx base image input");
assert(serverDeploy.indexOf("prepare_deerflow_runtime") < serverDeploy.indexOf("compose_up"), "DeerFlow must be ready before Workbench consumers start");
assert(serverDeploy.includes('"${COMPOSE[@]}" down'), "deployment must have a deterministic shutdown path");
assert(!serverDeploy.includes("--remove-orphans"), "direct deployment must not remove unrelated Compose services");
assert(
  serverDeploy.includes('export WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE="$ALLOW_RUNTIME_QUEUE_RECREATE"'),
  "queue policy recreation must be authorized by the deploy invocation instead of a persisted env-file value",
);

const allDeployBody = caseBody(serverDeploy, "all");
assert(
  allDeployBody.includes("prepare_runtime_queue_cutover")
    && allDeployBody.indexOf("prepare_runtime_queue_cutover") < allDeployBody.indexOf("compose_up"),
  "full deployment must reconcile Runtime queues before queue participants start",
);
const migrateBody = caseBody(serverDeploy, "migrate");
assert(
  migrateBody.includes("prepare_runtime_queue_cutover"),
  "the manual migration target must use the drained Runtime queue cutover",
);
for (const [target, requiredMarkers] of [
  ["all", ["prepare_runtime_queue_cutover", "compose_up_force_recreate preview-gateway gateway"]],
  ["api", ["compose_up workbench-api", "compose_up_force_recreate gateway"]],
  ["web", ["compose_up workbench-web knowledge", "compose_up_force_recreate gateway"]],
  ["knowledge", ["compose_up knowledge", "compose_up_force_recreate gateway"]],
  ["preview", ["compose_up workbench-preview preview-gateway", "compose_up_force_recreate preview-gateway"]],
]) {
  const body = caseBody(serverDeploy, target);
  for (const marker of requiredMarkers) {
    assert(body.includes(marker), `${target} deployment target must include ${marker}`);
  }
}

for (const profile of ["local-object-storage", "local-docling"]) {
  assert(readme.includes(profile), `README must document ${profile}`);
  assert(readme.includes(`--profile ${profile}`) || readme.includes(`COMPOSE_PROFILES=local-object-storage,local-docling`), `README must enable ${profile}`);
}
assert(productionPreflight.includes("workbench-origin-manifest.mjs"), "production preflight must use the shared origin manifest");
assert(
  productionCaddy.includes("{$WORKBENCH_WEB_HOSTNAME}")
    && productionCaddy.includes("{$WORKBENCH_PREVIEW_HOSTNAME}"),
  "production Caddy must derive Web and Preview hostnames",
);
assert(
  !productionCaddy.includes("127.0.0.1:9100")
    && !productionCaddy.includes("127.0.0.1:5556"),
  "production Caddy must not proxy local S3 or Dex services",
);

console.log("Workbench deployment orchestration contract passed.");

function caseBody(source, target) {
  const start = source.indexOf(`  ${target})`);
  assert(start >= 0, `deployment target is missing: ${target}`);
  const terminator = /\n\s+;;/u.exec(source.slice(start));
  assert(terminator, `deployment target has no terminator: ${target}`);
  return source.slice(start, start + terminator.index);
}

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function readYaml(relativePath) {
  const document = YAML.parseDocument(read(relativePath), { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw document.errors[0];
  return document.toJS({ maxAliasCount: 100 });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
