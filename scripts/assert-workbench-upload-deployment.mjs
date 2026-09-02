#!/usr/bin/env node

import { readFileSync } from "node:fs";

import YAML from "yaml";

const root = new URL("../", import.meta.url);
const compose = YAML.parse(read("deploy/workbench-compose.yml"));
const validation = YAML.parse(read("deploy/workbench-server-validation-compose.yml"));
const ci = YAML.parse(read(".github/workflows/workbench-ci.yml"));
const services = compose?.services ?? {};
const internalEndpoint = "WORKBENCH_S3_INTERNAL_ENDPOINT";
const internalPathStyle = "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE";
const browserBucketUrl = "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL";
const fileClamAvStreamMaxBytes = "WORKBENCH_CLAMAV_STREAM_MAX_BYTES";
const importClamAvStreamMaxBytes = "WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES";
const egressUpstreamHost = "WORKBENCH_S3_EGRESS_UPSTREAM_HOST";
const conditionalCreateMode = "WORKBENCH_S3_CONDITIONAL_CREATE_MODE";

assertEnvironment(services["workbench-api"], internalEndpoint, "workbench-api");
assertEnvironment(services["workbench-api"], internalPathStyle, "workbench-api");
assertEnvironment(services["workbench-api"], browserBucketUrl, "workbench-api");
for (const canvasCredential of [
  "WORKBENCH_API_CANVAS_VISUAL_S3_ACCESS_KEY_ID",
  "WORKBENCH_API_CANVAS_VISUAL_S3_SECRET_ACCESS_KEY",
]) {
  assertEnvironment(services["workbench-api"], canvasCredential, "workbench-api");
}

for (const serviceName of [
  "workbench-worker",
  "workbench-file-worker",
  "workbench-import-worker",
  "workbench-export-worker",
  "workbench-preview",
]) {
  assertEnvironment(services[serviceName], internalEndpoint, serviceName);
  assertEnvironment(services[serviceName], internalPathStyle, serviceName);
  assert(
    !Object.hasOwn(services[serviceName]?.environment ?? {}, browserBucketUrl),
    `${serviceName} must not receive the browser upload bucket URL`,
  );
  for (const canvasCredential of [
    "WORKBENCH_API_CANVAS_VISUAL_S3_ACCESS_KEY_ID",
    "WORKBENCH_API_CANVAS_VISUAL_S3_SECRET_ACCESS_KEY",
  ]) {
    assert(
      !Object.hasOwn(services[serviceName]?.environment ?? {}, canvasCredential),
      `${serviceName} must not receive ${canvasCredential}`,
    );
  }
  assert(
    services[serviceName]?.depends_on?.["object-storage-egress"]?.condition === "service_healthy",
    `${serviceName} must wait for the restricted object-storage egress tunnel`,
  );
}

for (const serviceName of [
  "workbench-file-worker",
  "workbench-import-worker",
  "workbench-export-worker",
]) {
  assertEnvironment(services[serviceName], conditionalCreateMode, serviceName);
}
for (const serviceName of ["workbench-api", "workbench-worker", "workbench-preview"]) {
  assert(
    !Object.hasOwn(services[serviceName]?.environment ?? {}, conditionalCreateMode),
    `${serviceName} must not receive the conditional-create mode because it does not publish immutable objects`,
  );
}

assertEnvironment(
  services["workbench-import-worker"],
  "WORKBENCH_IMPORT_S3_ACCESS_KEY_ID",
  "workbench-import-worker",
);
assertEnvironment(
  services["workbench-import-worker"],
  "WORKBENCH_IMPORT_S3_SECRET_ACCESS_KEY",
  "workbench-import-worker",
);
for (const scannerSetting of [
  "WORKBENCH_FILE_SCAN_MODE",
  "WORKBENCH_CLAMAV_HOST",
  "WORKBENCH_CLAMAV_PORT",
  importClamAvStreamMaxBytes,
]) {
  assertEnvironment(services["workbench-import-worker"], scannerSetting, "workbench-import-worker");
}
assertEnvironment(services["workbench-file-worker"], fileClamAvStreamMaxBytes, "workbench-file-worker");
assert(
  !Object.hasOwn(services["workbench-file-worker"]?.environment ?? {}, importClamAvStreamMaxBytes),
  `workbench-file-worker must not receive ${importClamAvStreamMaxBytes}`,
);
assert(
  !Object.hasOwn(services["workbench-import-worker"]?.environment ?? {}, fileClamAvStreamMaxBytes),
  `workbench-import-worker must not receive ${fileClamAvStreamMaxBytes}`,
);
assert(
  services["workbench-file-worker"]?.environment?.[fileClamAvStreamMaxBytes]
    === "${WORKBENCH_CLAMAV_STREAM_MAX_BYTES:-26214400}",
  "workbench-file-worker must retain the 25 MiB ClamAV stream contract",
);
assert(
  services["workbench-import-worker"]?.environment?.[importClamAvStreamMaxBytes]
    === "${WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES:-52428800}",
  "workbench-import-worker must use the independent 50 MiB ClamAV stream contract",
);
for (const forbiddenCredential of [
  "WORKBENCH_API_STAGING_S3_ACCESS_KEY_ID",
  "WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID",
  "WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID",
  "WORKBENCH_EXPORT_S3_ACCESS_KEY_ID",
  "WORKBENCH_PREVIEW_S3_ACCESS_KEY_ID",
]) {
  assert(
    !Object.hasOwn(services["workbench-import-worker"]?.environment ?? {}, forbiddenCredential),
    `workbench-import-worker must not receive ${forbiddenCredential}`,
  );
}

const objectStorageEgress = services["object-storage-egress"];
assert(objectStorageEgress, "restricted object-storage egress service is required");
assertEnvironment(objectStorageEgress, egressUpstreamHost, "object-storage-egress");
assert(objectStorageEgress.read_only === true, "object-storage-egress must use a read-only root filesystem");
assert(
  objectStorageEgress.security_opt?.includes("no-new-privileges:true"),
  "object-storage-egress must forbid privilege escalation",
);
assert(
  equal(objectStorageEgress.cap_drop, ["ALL"])
    && objectStorageEgress.cap_add?.includes("NET_BIND_SERVICE"),
  "object-storage-egress must retain only NET_BIND_SERVICE",
);
for (const credentialName of [
  "WORKBENCH_API_STAGING_S3_ACCESS_KEY_ID",
  "WORKBENCH_API_READY_BLOB_S3_ACCESS_KEY_ID",
  "WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID",
  "WORKBENCH_IMPORT_S3_ACCESS_KEY_ID",
  "WORKBENCH_EXPORT_S3_ACCESS_KEY_ID",
  "WORKBENCH_PREVIEW_S3_ACCESS_KEY_ID",
]) {
  assert(
    !Object.hasOwn(objectStorageEgress.environment ?? {}, credentialName),
    `object-storage-egress must not receive ${credentialName}`,
  );
}
const egressAliases = objectStorageEgress.networks?.["workbench-internal"]?.aliases ?? [];
assert(
  egressAliases.some((alias) => String(alias).includes("WORKBENCH_S3_BUCKET")
    && String(alias).includes(egressUpstreamHost)),
  "object-storage-egress must own only the configured bucket virtual hostname",
);
const egressTemplate = read("deploy/workbench-oss-egress-nginx.conf.template");
for (const fragment of [
  `set $oss_upstream \"\${${egressUpstreamHost}}:443\"`,
  "proxy_pass $oss_upstream",
  "resolver 127.0.0.11",
]) {
  assert(egressTemplate.includes(fragment), `object-storage egress template is missing ${fragment}`);
}
assert(
  !egressTemplate.includes("ssl_preread_server_name"),
  "object-storage egress destination must not be client-selected through SNI",
);

assert(
  Object.hasOwn(services["workbench-web"]?.build?.args ?? {}, browserBucketUrl),
  "workbench-web must receive the browser upload bucket URL at build time",
);
assertEnvironment(services["workbench-web"], browserBucketUrl, "workbench-web");
assert(
  services["object-storage"]?.ports?.some((entry) => String(entry).includes(":9000")),
  "local object storage must publish its S3 API port to the host browser",
);

const objectStorageEnvironment = services["object-storage"]?.environment ?? {};
assert(
  objectStorageEnvironment.MINIO_API_CORS_ALLOW_ORIGIN
    === "${WORKBENCH_WEB_ORIGIN:?WORKBENCH_WEB_ORIGIN is required for local object-storage CORS}",
  "local object storage must restrict browser CORS to WORKBENCH_WEB_ORIGIN",
);
assert(
  objectStorageEnvironment.MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL === "1h",
  "local object storage must scan for stale multipart uploads every hour",
);
assert(
  objectStorageEnvironment.MINIO_API_STALE_UPLOADS_EXPIRY === "24h",
  "local object storage must expire stale multipart uploads after 24 hours",
);

const objectStorageInit = services["object-storage-init"]?.entrypoint?.join("\n") ?? "";
for (const requiredFragment of [
  "mc mb --ignore-existing",
  "mc anonymous set none",
]) {
  assert(
    objectStorageInit.includes(requiredFragment),
    `local object storage initialization is missing ${requiredFragment}`,
  );
}

const cors = JSON.parse(read("deploy/workbench-s3-cors.example.json"));
assert(
  Array.isArray(cors.CORSRules) && cors.CORSRules.length === 1,
  "external production S3 CORS template must define exactly one rule",
);
const corsRule = cors.CORSRules[0];
assert(equal(corsRule.AllowedMethods, ["PUT"]), "external production S3 CORS template must allow only PUT");
assert(
  Array.isArray(corsRule.AllowedOrigins)
    && corsRule.AllowedOrigins.length === 1
    && corsRule.AllowedOrigins[0] !== "*",
  "external production S3 CORS template must allow one exact Web origin",
);
assert(
  corsRule.ExposeHeaders?.includes("ETag"),
  "external production S3 CORS template must expose ETag to Uppy",
);

const lifecycle = JSON.parse(read("deploy/workbench-s3-lifecycle.example.json"));
assert(
  lifecycle.Rules?.some((rule) => (
    rule.Status === "Enabled"
    && rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 1
  )),
  "external production S3 lifecycle template must abort incomplete multipart uploads after one day",
);
assert(
  !lifecycle.Rules?.some((rule) => (
    rule.Status === "Enabled"
    && (rule.Expiration || rule.NoncurrentVersionExpiration)
    && lifecyclePrefixOverlaps(lifecycleRulePrefix(rule), "canvas-visuals/")
  )),
  "external production S3 lifecycle must not delete Canvas visuals outside the database forensic-release fence",
);

const deploymentContracts = [
  "deploy/workbench-compose.yml",
  "deploy/workbench.env.example",
  "apps/web/Dockerfile",
  "apps/workbench-api/src/platform/object-storage/object-storage.config.ts",
  "apps/workbench-worker/src/config.ts",
  "apps/workbench-file-worker/src/config.ts",
  "apps/workbench-import-worker/src/config.ts",
  "apps/workbench-export-worker/src/config.ts",
  "apps/workbench-preview/src/config.ts",
  "deploy/workbench-oss-egress-nginx.conf.template",
];
const legacyEndpoint = ["WORKBENCH", "S3", "ENDPOINT"].join("_");
const legacyPathStyle = ["WORKBENCH", "S3", "FORCE", "PATH", "STYLE"].join("_");
for (const file of deploymentContracts) {
  const source = read(file);
  assert(!source.includes(legacyEndpoint), `${file} must not use the ambiguous legacy S3 endpoint`);
  assert(!source.includes(legacyPathStyle), `${file} must not use the ambiguous legacy path-style setting`);
}

for (const file of [
  "apps/workbench-api/src/platform/object-storage/s3-client.ts",
  "apps/workbench-file-worker/src/storage/s3-file-storage.adapter.ts",
  "apps/workbench-import-worker/src/storage/s3-import-storage.adapter.ts",
  "apps/workbench-export-worker/src/storage/s3-export-storage.adapter.ts",
  "apps/workbench-preview/src/storage.ts",
  "apps/workbench-worker/src/storage/s3-runtime-ready-blob-reader.ts",
]) {
  const source = read(file);
  const clientCount = source.match(/new S3Client\(\{/gu)?.length ?? 0;
  const requestModeCount = source.match(/requestChecksumCalculation: "WHEN_REQUIRED"/gu)?.length ?? 0;
  const responseModeCount = source.match(/responseChecksumValidation: "WHEN_REQUIRED"/gu)?.length ?? 0;
  assert(clientCount > 0, `${file} must create an S3 client`);
  assert(
    requestModeCount === clientCount && responseModeCount === clientCount,
    `${file} must disable optional AWS checksum negotiation on every S3 client for OSS compatibility`,
  );
}

for (const dockerfile of [
  "apps/workbench-file-worker/Dockerfile",
  "apps/workbench-import-worker/Dockerfile",
]) {
  const source = read(dockerfile);
  assert(
    source.includes("packages/workbench-content-security/package.json"),
    `${dockerfile} must install the shared content-security workspace`,
  );
  assert(
    source.includes("/app/packages/workbench-content-security/dist"),
    `${dockerfile} must copy the built shared content-security package into the runner`,
  );
}

assert(
  validation.services?.["workbench-import-worker"]?.depends_on?.clamav?.condition === "service_healthy",
  "server validation must wait for healthy ClamAV before starting workbench-import-worker",
);
assert(
  validation.services?.clamav?.environment?.CLAMD_CONF_StreamMaxLength === "50M",
  "server validation ClamD must accept the 50 MiB Import Worker stream contract",
);
const envExample = read("deploy/workbench.env.example");
assert(
  envExample.includes("WORKBENCH_CLAMAV_STREAM_MAX_BYTES=26214400"),
  "deployment env example must retain the 25 MiB File Worker ClamAV stream contract",
);
assert(
  envExample.includes("WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES=52428800"),
  "deployment env example must declare the 50 MiB Import Worker ClamAV stream contract",
);
assert(
  envExample.includes(`${egressUpstreamHost}=s3.internal.example.com`),
  "deployment env example must bind the restricted S3 egress upstream host",
);
assert(
  envExample.includes(`${conditionalCreateMode}=s3-if-none-match`),
  "deployment env example must declare portable create-only S3 semantics",
);
const ossProvisioner = read("deploy/provision-workbench-oss-ram.sh");
assert(
  ossProvisioner.includes(`${conditionalCreateMode}=oss-forbid-overwrite`),
  "Alibaba Cloud OSS provisioning must select native create-only semantics",
);
const publicUploadSmoke = read("scripts/workbench-public-upload-smoke.mjs");
const publicUploadRunner = read("deploy/run-workbench-public-upload-smoke.sh");
const cleanupFunction = publicUploadSmoke.slice(publicUploadSmoke.indexOf("async function bestEffortCleanup()"));
const cleanupAbort = cleanupFunction.indexOf("/file-upload-sessions/${encodeURIComponent(upload.id)}");
const cleanupFileDelete = cleanupFunction.indexOf("/files/${encodeURIComponent(file.id)}");
assert(
  cleanupAbort >= 0 && cleanupFileDelete > cleanupAbort,
  "public upload smoke cleanup must abort an unfinished multipart upload before deleting its File",
);
for (const fragment of [
  "WORKBENCH_UPLOAD_SMOKE_BASE_URL is required",
  "WORKBENCH_UPLOAD_SMOKE_EXPECTED_UPLOAD_ORIGIN is required",
  "docker inspect \"$web_container\" --format '{{.Config.Image}}'",
  "DELETE FROM workbench.workspaces",
  "DELETE FROM workbench.principals",
  "DELETE FROM workbench.auth_users",
]) {
  assert(publicUploadRunner.includes(fragment), `public upload runner is missing ${fragment}`);
}
assert(
  !publicUploadRunner.includes("Host: aionbench.com")
    && !publicUploadRunner.includes("workbench-web:server-validation"),
  "public upload runner must derive the target host and deployed Web image",
);
assert(
  publicUploadRunner.includes("set +x") && publicUploadRunner.includes("umask 077"),
  "public upload runner must suppress tracing and protect temporary credentials",
);
assert(
  publicUploadSmoke.includes('evidence.result = "FAIL"')
    && publicUploadSmoke.includes('code: "PUBLIC_UPLOAD_SMOKE_FAILED"')
    && publicUploadSmoke.includes("JSON.stringify(evidence"),
  "public upload smoke must retain structured failure evidence without response details",
);
assert(
  validation.services?.["workbench-import-worker"]?.depends_on?.["object-storage-init"]?.condition
    === "service_completed_successfully",
  "server validation must initialize object storage before starting workbench-import-worker",
);

const deployScript = read("deploy/server-deploy.sh");
assert(
  deployScript.includes("workbench-import-worker"),
  "server deployment must include workbench-import-worker in full rollout readiness",
);
assert(
  deployScript.includes("object-storage-egress"),
  "server deployment must wait for the restricted object-storage egress tunnel",
);
assert(
  deployScript.includes("import-worker)"),
  "server deployment must expose a dedicated import-worker rollout target",
);
const productionImageMatrix = ci.jobs?.["production-images"]?.strategy?.matrix?.include ?? [];
assert(
  equal(ci.jobs?.["production-images"]?.needs, ["release-chain", "release-chain-signing", "quality", "deployment-config"]),
  "production images must wait for the verified release chain, release-chain signing, quality, and deployment configuration gates",
);
assert(
  productionImageMatrix.some((entry) => (
    entry?.name === "import-worker"
    && entry?.dockerfile === "apps/workbench-import-worker/Dockerfile"
    && entry?.target === "runner"
  )),
  "production image CI matrix must build the Workbench Import Worker",
);
const webImage = productionImageMatrix.find((entry) => entry?.name === "web");
for (const marker of [
  "vars.WORKBENCH_PREVIEW_ORIGIN",
  "vars.WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL",
  "vars.WORKBENCH_KNOWLEDGE_BASE_URL",
  "vars.NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL",
  "vars.NEXT_PUBLIC_WORKBENCH_FORUM_URL",
  "vars.NEXT_PUBLIC_WORKBENCH_PRIVACY_URL",
]) {
  assert(
    String(webImage?.build_args ?? "").includes(marker),
    `production Web build args must derive ${marker} from approved release variables`,
  );
}
const quartzImage = productionImageMatrix.find((entry) => entry?.name === "quartz");
for (const marker of ["vars.WORKBENCH_KNOWLEDGE_BASE_URL", "vars.WORKBENCH_WEB_ORIGIN"]) {
  assert(
    String(quartzImage?.build_args ?? "").includes(marker),
    `production Quartz build args must derive ${marker} from approved release variables`,
  );
}
const productionImageSteps = ci.jobs?.["production-images"]?.steps ?? [];
const productionInputGate = productionImageSteps.find((step) => step?.name === "Require approved production build inputs");
assert(productionInputGate, "production image workflow must fail closed on missing release build inputs");
for (const variable of [
  "WORKBENCH_WEB_ORIGIN",
  "WORKBENCH_PREVIEW_ORIGIN",
  "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL",
  "WORKBENCH_KNOWLEDGE_BASE_URL",
  "WORKBENCH_PUBLIC_REGISTRATION_ENABLED",
]) {
  assert(
    String(productionInputGate?.env?.[variable] ?? "").includes(`vars.${variable}`),
    `production input gate must read ${variable} from repository or environment variables`,
  );
}
const buildConfigurationStep = productionImageSteps.find((step) => step?.name === "Freeze public image build configuration");
assert(
  String(buildConfigurationStep?.run ?? "").includes("write-production-build-configuration.mjs"),
  "production images must freeze a canonical public build configuration before building",
);
const buildImageStep = productionImageSteps.find((step) => step?.name === "Build ${{ matrix.name }} production image");
assert(
  String(buildImageStep?.with?.labels ?? "").includes("io.workbench.build-configuration-sha256="),
  "the signed image digest must bind the canonical build configuration SHA-256 through an OCI label",
);

const dockerIgnore = new Set(
  read(".dockerignore")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);
assert(
  !dockerIgnore.has("storage") && !dockerIgnore.has("**/storage"),
  ".dockerignore must not exclude Worker src/storage directories",
);
for (const requiredPattern of [
  "storage/**",
  ".env*",
  "output",
  ".playwright-cli",
  "**/dist",
  "packages/workbench-db/generated",
  "apps/workbench-figma-importer/build",
]) {
  assert(
    dockerIgnore.has(requiredPattern),
    `.dockerignore must exclude ${requiredPattern} from production build contexts`,
  );
}

console.log("Workbench browser upload deployment contract passed.");

function assertEnvironment(service, name, serviceName) {
  assert(Object.hasOwn(service?.environment ?? {}, name), `${serviceName} is missing ${name}`);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function lifecyclePrefixOverlaps(left, right) {
  return left.startsWith(right) || right.startsWith(left);
}

function lifecycleRulePrefix(rule) {
  return rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? "";
}

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
