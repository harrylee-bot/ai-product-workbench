import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const preflight = resolve("deploy/workbench-production-preflight.sh");
const originManifest = resolve("scripts/workbench-origin-manifest.mjs");
const originCaddy = resolve("deploy/workbench-production.Caddyfile");
const originWireguardPreflight = resolve("deploy/edge/workbench-origin-wireguard-preflight.sh");

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
  const result = runPreflight({ WORKBENCH_EDGE_WIREGUARD_IP: "8.130.160.177" });
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

test("production preflight requires a manifest signature bundle", () => {
  const result = runPreflight({ WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH is empty/u);
});

test("production preflight requires an exact Cosign certificate identity", () => {
  const result = runPreflight({
    WORKBENCH_COSIGN_CERTIFICATE_IDENTITY: "^https://github.com/example/.*$",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an exact HTTPS identity/u);
});

test("production preflight does not require OIDC when enterprise SSO is disabled", () => {
  const result = runPreflight({
    WORKBENCH_ENTERPRISE_SSO_ENABLED: "false",
    WORKBENCH_OIDC_PROVIDER_ISSUER: undefined,
    WORKBENCH_OIDC_CLIENT_ID: undefined,
    WORKBENCH_OIDC_CLIENT_SECRET: undefined,
    WORKBENCH_IDENTITY_HOSTNAME: undefined,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing signed production image manifest/u);
  assert.doesNotMatch(result.stderr, /OIDC|IDENTITY_HOSTNAME/u);
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
    "Endpoint = 8.130.160.177:51820",
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
    WORKBENCH_EDGE_WIREGUARD_ENDPOINT: "8.130.160.177:51820",
    WORKBENCH_ORIGIN_HTTP_PORT: "8080",
    WORKBENCH_EDGE_ORIGIN_AUTH_SECRET: "A".repeat(64),
    WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR: "/srv/tokenizer",
    WORKBENCH_IMAGE_INVENTORY_PATH: "/srv/image-manifest.json",
    WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH: "/srv/image-manifest.bundle.json",
    WORKBENCH_COSIGN_CERTIFICATE_IDENTITY: "https://github.com/example/workbench/.github/workflows/workbench-ci.yml@refs/heads/main",
    WORKBENCH_COSIGN_OIDC_ISSUER: "https://token.actions.githubusercontent.com",
    WORKBENCH_SOURCE_COMMIT: "a".repeat(40),
    WORKBENCH_FILE_SCAN_MODE: "clamav",
    WORKBENCH_POSTGRES_IMAGE: `pgvector/pgvector:pg16@sha256:${"b".repeat(64)}`,
    WORKBENCH_NGINX_IMAGE: `nginx:stable-alpine@sha256:${"c".repeat(64)}`,
    WORKBENCH_NODE_IMAGE: `node:22-alpine@sha256:${"d".repeat(64)}`,
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
