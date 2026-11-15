import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const preflight = resolve("deploy/workbench-production-preflight.sh");
const originManifest = resolve("scripts/workbench-origin-manifest.mjs");
const originCaddy = resolve("deploy/workbench-production.Caddyfile");
const originWireguardPreflight = resolve("deploy/edge/workbench-origin-wireguard-preflight.sh");

test("Compose has unique keys and supplies the Temporal storage and health configuration", () => {
  const compose = parseYaml(readFileSync(resolve("deploy/workbench-compose.yml"), "utf8"));
  const api = compose.services["workbench-api"].environment;
  const runtime = compose.services["workbench-worker"].environment;
  const temporal = compose.services["workbench-temporal-worker"].environment;
  assert.equal(compose.services["workbench-build-worker"], undefined);
  assert.equal(compose.services["workbench-temporal-worker"].build.dockerfile, "apps/workbench-worker/Dockerfile.temporal");
  assert.equal(compose.services["workbench-worker"].build.dockerfile, "apps/workbench-worker/Dockerfile");
  for (const service of ["workbench-worker", "workbench-web"]) {
    assert.equal(compose.services[service].build.args.NODE_IMAGE, "${WORKBENCH_NODE_IMAGE:-node:22-alpine}");
    assert.equal(compose.services[service].build.args.TEMPORAL_NODE_IMAGE, undefined);
  }
  for (const name of ["WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID", "WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY", "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE"]) {
    assert.equal(temporal[name], runtime[name], `Temporal must receive ${name}`);
  }
  assert.equal(api.WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY, undefined);
  assert.equal(temporal.WORKBENCH_CANVAS_TOOL_SECRET, undefined);
  assert.equal(temporal.WORKBENCH_S3_CONDITIONAL_CREATE_MODE, compose.services["workbench-export-worker"].environment.WORKBENCH_S3_CONDITIONAL_CREATE_MODE);
  for (const action of ["START", "CANCEL", "EXECUTE"]) {
    assert(api[`WORKBENCH_TEMPORAL_WORKFLOW_${action}_URL`].includes("${WORKBENCH_TEMPORAL_WORKER_HEALTH_PORT:-4310}"));
  }
});

test("the restricted S3 tunnel resolves both ordinary and prototype virtual-host buckets", () => {
  const compose = parseYaml(readFileSync(resolve("deploy/workbench-compose.yml"), "utf8"));
  const tunnel = compose.services["object-storage-egress"];
  const host = "${WORKBENCH_S3_EGRESS_UPSTREAM_HOST:?WORKBENCH_S3_EGRESS_UPSTREAM_HOST is required}";
  assert.deepEqual(tunnel.networks["workbench-internal"].aliases, [
    `\${WORKBENCH_S3_BUCKET:?WORKBENCH_S3_BUCKET is required}.${host}`,
    `\${WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET:?WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET is required}.${host}`,
  ]);
  assert(compose.services["workbench-api"].networks.includes("workbench-internal"));
  const tunnelConfig = readFileSync(resolve("deploy/workbench-oss-egress-nginx.conf.template"), "utf8");
  assert.match(tunnelConfig, /set \$oss_upstream "\$\{WORKBENCH_S3_EGRESS_UPSTREAM_HOST\}:443";/u);
  assert.match(tunnelConfig, /proxy_pass \$oss_upstream;/u);
});

for (const artifactBucket of ["prototype-fixture", "workbench-fixture"]) {
  test(`local object-storage initialization creates private buckets once with artifact bucket ${artifactBucket}`, () => {
    const compose = parseYaml(readFileSync(resolve("deploy/workbench-compose.yml"), "utf8"));
    const init = compose.services["object-storage-init"];
    assert.equal(init.environment.WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET,
      "${WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET:?WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET is required}");
    const directory = mkdtempSync(join(tmpdir(), "workbench-storage-init-test-"));
    const log = join(directory, "mc.log");
    const mc = join(directory, "mc");
    writeFileSync(mc, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_MC_LOG"\n');
    chmodSync(mc, 0o700);
    try {
      const script = init.entrypoint[2].replaceAll("$$", "$");
      const result = spawnSync(init.entrypoint[0], [init.entrypoint[1], script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          MOCK_MC_LOG: log,
          MINIO_ROOT_USER: "fixture-user",
          MINIO_ROOT_PASSWORD: "fixture-password",
          WORKBENCH_S3_BUCKET: "workbench-fixture",
          WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET: artifactBucket,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const commands = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(commands[0], "alias set local http://object-storage:9000 fixture-user fixture-password");
      assert.deepEqual(commands.slice(1), [...new Set(["workbench-fixture", artifactBucket])].flatMap((bucket) => [
        `mb --ignore-existing local/${bucket}`,
        `anonymous set none local/${bucket}`,
      ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("both S3 buckets reject names unsafe for the same TLS virtual-host tunnel", () => {
  for (const name of ["WORKBENCH_S3_BUCKET", "WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET"]) {
    for (const bucket of ["prototype.fixture", "prototype-", "-prototype", "Prototype", "ab", "a".repeat(64)]) {
      const result = runPreflight({ [name]: bucket });
      assert.notEqual(result.status, 0, `${name}: ${bucket}`);
      assert.match(result.stderr, /canonical restricted tunnel target/u, `${name}: ${bucket}`);
    }
  }
});

test("the tunnel accepts separate or shared canonical prototype buckets", () => {
  for (const bucket of ["prototype-fixture", "workbench-fixture", "abc", "a".repeat(63)]) {
    const result = runPreflight({
      WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET: bucket,
      WORKBENCH_COMPOSE_PROFILES: "local-object-storage",
    });
    // This guard runs after tunnel validation and deliberately stops before host tools.
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not enable local Compose profiles/u);
  }
});

test("production preflight rejects validation-only Compose profiles", () => {
  const result = runPreflight({ WORKBENCH_COMPOSE_PROFILES: "local-object-storage local-docling" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not enable local Compose profiles/u);
});

test("production preflight keeps public registration and origin checks fail closed", () => {
  const result = runPreflight({ WORKBENCH_PUBLIC_REGISTRATION_ENABLED: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be true or false/u);
});

test("production preflight rejects the legacy Runtime provider-state replay path", () => {
  const result = runPreflight({ WORKBENCH_RUNTIME_PROVIDER_STATE_MODE: "legacy-read" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be projection-required in production/u);
});

test("production preflight rejects a Canvas visual endpoint outside the tool origin", () => {
  const result = runPreflight({
    WORKBENCH_CANVAS_VISUAL_URL: "https://other.example.test/api/v1/runtime/canvas/visuals",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must share the Canvas tool origin/u);
});

test("production preflight requires a private WireGuard Edge peer", () => {
  const result = runPreflight({ WORKBENCH_EDGE_WIREGUARD_IP: "203.0.113.10" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an RFC1918 IPv4 address/u);
});

test("production preflight rejects a shared Edge and origin WireGuard address", () => {
  const result = runPreflight({ WORKBENCH_ORIGIN_WIREGUARD_IP: "10.88.0.1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Edge and origin WireGuard IPs must differ/u);
});

test("production preflight rejects a weak Edge origin authentication secret", () => {
  const result = runPreflight({ WORKBENCH_EDGE_ORIGIN_AUTH_SECRET: "too-short" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain at least 32 random bytes/u);
});

test("production preflight rejects a mutable Node base image", () => {
  const result = runPreflight({ WORKBENCH_NODE_IMAGE: "node:22-alpine" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_NODE_IMAGE must be an immutable digest reference/u);
});

test("production preflight rejects an invalid Temporal address", () => {
  const result = runPreflight({ WORKBENCH_TEMPORAL_ADDRESS: "https://temporal.example.test" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Temporal workflow gateway/u);
});

test("production preflight requires a pinned glibc image for the Temporal SDK", () => {
  const mutable = runPreflight({ WORKBENCH_TEMPORAL_NODE_IMAGE: "node:22-bookworm-slim" });
  assert.notEqual(mutable.status, 0);
  assert.match(mutable.stderr, /WORKBENCH_TEMPORAL_NODE_IMAGE must be an immutable digest reference/u);
  const musl = runPreflight({ WORKBENCH_TEMPORAL_NODE_IMAGE: `node:22-alpine@sha256:${"e".repeat(64)}` });
  assert.notEqual(musl.status, 0);
  assert.match(musl.stderr, /glibc base/u);
});

test("managed Temporal requires pinned server and schema images on its private endpoint", () => {
  const managed = {
    WORKBENCH_TEMPORAL_MANAGED: "1",
    WORKBENCH_TEMPORAL_ADDRESS: "workbench-temporal:7233",
    WORKBENCH_TEMPORAL_SERVER_IMAGE: `temporalio/server:1.31.2@sha256:${"f".repeat(64)}`,
    WORKBENCH_TEMPORAL_ADMIN_IMAGE: `temporalio/admin-tools:1.31.2@sha256:${"a".repeat(64)}`,
    WORKBENCH_TEMPORAL_POSTGRES_ADMIN_PASSWORD: "fixture-temporal-admin",
    WORKBENCH_TEMPORAL_DATABASE_PASSWORD: "fixture-temporal-owner",
  };
  const valid = runPreflight(managed);
  // The fixture deliberately has no host tokenizer or Caddy. Reaching that
  // later host check proves the managed endpoint and image contract passed.
  assert.match(valid.stderr, /tokenizer.json is missing/u);
  for (const name of ["WORKBENCH_TEMPORAL_SERVER_IMAGE", "WORKBENCH_TEMPORAL_ADMIN_IMAGE"]) {
    const result = runPreflight({ ...managed, [name]: "temporalio/server:latest" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be an immutable digest reference/u);
  }
  const wrongAddress = runPreflight({ ...managed, WORKBENCH_TEMPORAL_ADDRESS: "localhost:7233" });
  assert.notEqual(wrongAddress.status, 0);
  assert.match(wrongAddress.stderr, /private workbench-temporal/u);
  const missingPassword = runPreflight({ ...managed, WORKBENCH_TEMPORAL_DATABASE_PASSWORD: "" });
  assert.notEqual(missingPassword.status, 0);
  assert.match(missingPassword.stderr, /WORKBENCH_TEMPORAL_DATABASE_PASSWORD is empty/u);
});

test("production preflight rejects an S3 tunnel target that differs from the SDK endpoint", () => {
  const result = runPreflight({
    WORKBENCH_S3_EGRESS_UPSTREAM_HOST: "other.internal.example.test",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical restricted tunnel target/u);
});

test("production preflight requires OSS-native create-only semantics for Alibaba Cloud", () => {
  const result = runPreflight({
    WORKBENCH_S3_INTERNAL_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com",
    WORKBENCH_S3_EGRESS_UPSTREAM_HOST: "oss-cn-hangzhou.aliyuncs.com",
    WORKBENCH_S3_CONDITIONAL_CREATE_MODE: "s3-if-none-match",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Alibaba Cloud OSS requires/u);
});

test("production preflight requires complete OIDC configuration when enterprise SSO is enabled", () => {
  const result = runPreflight({
    WORKBENCH_ENTERPRISE_SSO_ENABLED: "true",
    WORKBENCH_OIDC_PROVIDER_ISSUER: "https://identity.example.test/realms/workbench",
    WORKBENCH_OIDC_CLIENT_ID: undefined,
    WORKBENCH_OIDC_CLIENT_SECRET: undefined,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_OIDC_CLIENT_ID is required/u);
});

test("production preflight rejects dormant OIDC secrets while enterprise SSO is disabled", () => {
  const result = runPreflight({
    WORKBENCH_ENTERPRISE_SSO_ENABLED: "false",
    WORKBENCH_OIDC_PROVIDER_ISSUER: "https://identity.example.test/realms/workbench",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be empty when enterprise SSO is disabled/u);
});

function runPreflight(overrides) {
  const appDir = mkdtempSync(join(tmpdir(), "workbench-production-preflight-"));
  const deployDir = join(appDir, "deploy");
  const scriptsDir = join(appDir, "scripts");
  mkdirSync(deployDir);
  mkdirSync(scriptsDir);
  mkdirSync(join(appDir, "knowledge-vault"));
  writeFileSync(join(appDir, "knowledge-vault/README.md"), "# fixture\n");
  writeFileSync(join(deployDir, "workbench-compose.yml"), "services: {}\n");
  writeFileSync(join(deployDir, "workbench-production.Caddyfile"), readFileSync(originCaddy, "utf8"));
  writeFileSync(
    join(scriptsDir, "assert-workbench-database-role-contract.mjs"),
    readFileSync(resolve("scripts/assert-workbench-database-role-contract.mjs"), "utf8"),
  );
  const wireguardConfig = join(deployDir, "wg0.conf");
  writeFileSync(wireguardConfig, [
    "[Interface]",
    "Address = 10.88.0.2/30",
    `PrivateKey = ${"A".repeat(43)}=`,
    "[Peer]",
    `PublicKey = ${"B".repeat(43)}=`,
    "Endpoint = 203.0.113.10:51820",
    "AllowedIPs = 10.88.0.1/32",
    "",
  ].join("\n"));
  const env = {
    WORKBENCH_WEB_ORIGIN: "https://workbench.example.test",
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.example.test",
    WORKBENCH_S3_INTERNAL_ENDPOINT: "https://s3.internal.example.test",
    WORKBENCH_S3_EGRESS_UPSTREAM_HOST: "s3.internal.example.test",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.example.test/workbench",
    WORKBENCH_S3_BUCKET: "workbench-fixture",
    WORKBENCH_S3_CONDITIONAL_CREATE_MODE: "s3-if-none-match",
    WORKBENCH_ENTERPRISE_SSO_ENABLED: "false",
    WORKBENCH_CANVAS_TOOL_URL: "https://workbench.example.test/api/v1/runtime/canvas/tools/execute",
    WORKBENCH_CANVAS_VISUAL_URL: "https://workbench.example.test/api/v1/runtime/canvas/visuals",
    WORKBENCH_DATABASE_URL: "postgresql://workbench_runtime:runtime@postgres:5432/workbench?schema=workbench",
    WORKBENCH_POSTGRES_ADMIN_URL: "postgresql://workbench_admin:admin@postgres:5432/workbench",
    WORKBENCH_MIGRATOR_DATABASE_URL: "postgresql://workbench_migrator:migrator@postgres:5432/workbench?schema=workbench",
    WORKBENCH_POSTGRES_USER: "workbench_admin",
    WORKBENCH_POSTGRES_MIGRATOR_USER: "workbench_migrator",
    WORKBENCH_POSTGRES_MIGRATOR_PASSWORD: "migrator",
    WORKBENCH_POSTGRES_RUNTIME_USER: "workbench_runtime",
    WORKBENCH_POSTGRES_RUNTIME_PASSWORD: "runtime",
    WORKBENCH_PUBLIC_REGISTRATION_ENABLED: "false",
    WORKBENCH_RUNTIME_PROVIDER_STATE_MODE: "projection-required",
    WORKBENCH_AUTH_CLIENT_IP_HEADER: "x-workbench-client-ip",
    WORKBENCH_EDGE_WIREGUARD_IP: "10.88.0.1",
    WORKBENCH_ORIGIN_WIREGUARD_IP: "10.88.0.2",
    WORKBENCH_EDGE_WIREGUARD_ENDPOINT: "203.0.113.10:51820",
    WORKBENCH_ORIGIN_HTTP_PORT: "8080",
    WORKBENCH_EDGE_ORIGIN_AUTH_SECRET: "A".repeat(64),
    WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR: "/srv/tokenizer",
    WORKBENCH_SOURCE_COMMIT: "a".repeat(40),
    WORKBENCH_FILE_SCAN_MODE: "clamav",
    WORKBENCH_TEMPORAL_WORKFLOW_START_URL: "http://temporal-worker:4310/workflows/start",
    WORKBENCH_TEMPORAL_WORKFLOW_CANCEL_URL: "http://temporal-worker:4310/workflows/cancel",
    WORKBENCH_TEMPORAL_WORKFLOW_EXECUTE_URL: "http://temporal-worker:4310/workflows/execute",
    WORKBENCH_TEMPORAL_WORKER_HEALTH_PORT: "4310",
    WORKBENCH_TEMPORAL_ADDRESS: "temporal.example.test:7233",
    WORKBENCH_TEMPORAL_NAMESPACE: "default",
    WORKBENCH_TEMPORAL_TASK_QUEUE: "workbench-prototype-v2",
    WORKBENCH_TEMPORAL_MANAGED: "0",
    WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET: "prototype-fixture",
    WORKBENCH_PROTOTYPE_ARTIFACT_S3_ACCESS_KEY_ID: "fixture-access-key",
    WORKBENCH_PROTOTYPE_ARTIFACT_S3_SECRET_ACCESS_KEY: "fixture-secret-key",
    WORKBENCH_POSTGRES_IMAGE: `pgvector/pgvector:pg16@sha256:${"b".repeat(64)}`,
    WORKBENCH_NGINX_IMAGE: `nginx:stable-alpine@sha256:${"c".repeat(64)}`,
    WORKBENCH_NODE_IMAGE: `node:22-alpine@sha256:${"d".repeat(64)}`,
    WORKBENCH_TEMPORAL_NODE_IMAGE: `node:22-bookworm-slim@sha256:${"e".repeat(64)}`,
    ...overrides,
  };
  const envSource = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(join(deployDir, "workbench.env"), `${envSource}\n`);
  try {
    return spawnSync("sh", [preflight], {
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_APP_DIR: appDir,
        WORKBENCH_ORIGIN_MANIFEST_SCRIPT: originManifest,
        WORKBENCH_ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT: originWireguardPreflight,
        WORKBENCH_ORIGIN_WIREGUARD_CONFIG: wireguardConfig,
        ...overrides,
      },
    });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}
