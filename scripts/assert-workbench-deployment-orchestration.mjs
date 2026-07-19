#!/usr/bin/env node

import { readFileSync } from "node:fs";

import YAML from "yaml";

const compose = readYaml("deploy/workbench-compose.yml");
const runtime = readYaml("deploy/deerflow-runtime-compose.yml");
const validation = readYaml("deploy/workbench-server-validation-compose.yml");
const serverDeploy = read("deploy/server-deploy.sh");
const preflight = read("deploy/workbench-server-preflight.sh");
const productionPreflight = read("deploy/workbench-production-preflight.sh");
const caddy = read("deploy/workbench-server-validation.Caddyfile");
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

for (const name of ["workbench-api", "workbench-worker"]) {
  const service = compose.services?.[name];
  assert(service?.environment?.DEERFLOW_GATEWAY_URL?.includes("WORKBENCH_DEERFLOW_GATEWAY_URL"), `${name} must declare the DeerFlow gateway URL`);
  assert(envExample.includes("WORKBENCH_DEERFLOW_GATEWAY_URL=http://deerflow:8001"), "the deployment URL must resolve through the internal DeerFlow alias");
  assert(service?.depends_on?.migrate?.condition === "service_completed_successfully", `${name} must wait for migrations`);
}
assert(compose.services?.migrate?.depends_on?.postgres?.condition === "service_healthy", "migrator must wait for healthy PostgreSQL");
assert(compose.services?.["workbench-api"]?.depends_on?.migrate?.condition === "service_completed_successfully", "API must wait for migrator");
assert(
  compose.services?.["workbench-worker"]?.environment?.WORKBENCH_CANVAS_VISUAL_URL
    === "${WORKBENCH_CANVAS_VISUAL_URL:?WORKBENCH_CANVAS_VISUAL_URL is required and must be the public HTTPS Canvas visual capability base URL}",
  "Runtime Worker must receive the required Canvas visual capability base URL",
);
assert(
  envExample.includes("WORKBENCH_CANVAS_VISUAL_URL=https://workbench.example.com/api/v1/runtime/canvas/visuals"),
  "deployment env must declare the Canvas visual capability base URL",
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

for (const marker of [
  "prepare_deerflow_runtime",
  "wait_for_deerflow",
  "WORKBENCH_DEPLOY_IMAGE_MODE",
  "--no-build",
  "already occupied by container",
  "rollback)",
  "on_deploy_error",
  "Rollback image manifest is missing",
]) {
  assert(serverDeploy.includes(marker), `server deploy is missing ${marker}`);
}
assert(productionPreflight.includes("production image manifest"), "production preflight must require the signed image manifest");
assert(productionPreflight.includes("config --quiet"), "production preflight must render the base Compose topology");
assert(productionPreflight.includes("WORKBENCH_POSTGRES_IMAGE must be an immutable digest reference"), "production PostgreSQL image must be digest-pinned");
assert(productionPreflight.includes("WORKBENCH_NGINX_IMAGE must be an immutable digest reference"), "production Nginx image must be digest-pinned");
assert(serverDeploy.includes("base greenfield Compose without a validation overlay"), "production must reject the validation overlay");
assert(serverDeploy.indexOf("prepare_deerflow_runtime") < serverDeploy.indexOf("compose_up"), "DeerFlow must be ready before Workbench consumers start");
assert(serverDeploy.includes("down --remove-orphans"), "deployment must have a deterministic shutdown path");

for (const profile of ["local-object-storage", "local-docling"]) {
  assert(readme.includes(profile), `README must document ${profile}`);
  assert(readme.includes(`--profile ${profile}`) || readme.includes(`COMPOSE_PROFILES=local-object-storage,local-docling`), `README must enable ${profile}`);
}
assert(validation.services?.["workbench-import-worker"]?.depends_on?.clamav?.condition === "service_healthy", "validation must gate Import Worker on ClamAV");
assert(validation.services?.["workbench-file-worker"]?.depends_on?.docling?.condition === "service_healthy", "validation must gate File Worker on Docling");

assert(!caddy.includes("aionbench.com"), "server-validation Caddy must not contain a product hostname");
assert(caddy.includes("{$WORKBENCH_WEB_HOSTNAME}"), "Caddy must consume the derived Web hostname");
assert(preflight.includes("workbench-origin-manifest.mjs"), "preflight must use the shared origin manifest");
assert(
  productionCaddy.includes("{$WORKBENCH_WEB_HOSTNAME}")
    && productionCaddy.includes("{$WORKBENCH_PREVIEW_HOSTNAME}"),
  "production Caddy must derive Web and Preview hostnames",
);
assert(
  !productionCaddy.includes("127.0.0.1:9100")
    && !productionCaddy.includes("127.0.0.1:5556"),
  "production Caddy must not proxy validation-only S3 or Dex services",
);

console.log("Workbench deployment orchestration contract passed.");

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
