import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const preflight = resolve("deploy/workbench-server-preflight.sh");
const originManifest = resolve("scripts/workbench-origin-manifest.mjs");
const originWireguardPreflight = resolve("deploy/edge/workbench-origin-wireguard-preflight.sh");

test("server preflight rejects a missing WireGuard Edge peer", () => {
  const result = runPreflight({ WORKBENCH_EDGE_WIREGUARD_IP: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_EDGE_WIREGUARD_IP must occur exactly once/);
});

test("server preflight rejects a public Edge address as the WireGuard peer", () => {
  const result = runPreflight({ WORKBENCH_EDGE_WIREGUARD_IP: "8.130.160.177" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an RFC1918 IPv4 address/);
});

test("server preflight rejects a non-HTTPS main origin", () => {
  const result = runPreflight({ WORKBENCH_WEB_ORIGIN: "http://workbench.example.test" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_WEB_ORIGIN must use HTTPS/);
});

test("server preflight rejects a Preview hostname equal to the main hostname", () => {
  const result = runPreflight({ WORKBENCH_PREVIEW_ORIGIN: "https://workbench.example.test" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Web, Preview, browser upload, and enabled identity hostnames must be distinct/);
});

test("server preflight rejects a weak Edge origin authentication secret", () => {
  const result = runPreflight({ WORKBENCH_EDGE_ORIGIN_AUTH_SECRET: "too-short" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain at least 32 random bytes/);
});

test("server preflight rejects a non-canonical Better Auth IP header", () => {
  const result = runPreflight({ WORKBENCH_AUTH_CLIENT_IP_HEADER: "x-workbench-edge-client-ip" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be x-workbench-client-ip/);
});

test("server preflight rejects an ambiguous public registration policy", () => {
  const result = runPreflight({ WORKBENCH_PUBLIC_REGISTRATION_ENABLED: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_PUBLIC_REGISTRATION_ENABLED must be true or false/);
});

test("server validation requires enterprise SSO for its local Dex profile", () => {
  const result = runPreflight({ WORKBENCH_ENTERPRISE_SSO_ENABLED: "false" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires WORKBENCH_ENTERPRISE_SSO_ENABLED=true/u);
});

test("server preflight requires production imports to use ClamAV", () => {
  const result = runPreflight({ WORKBENCH_FILE_SCAN_MODE: "fail-closed" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires WORKBENCH_FILE_SCAN_MODE=clamav/);
});

test("server preflight rejects an Import Source blob above the Import Worker ClamAV stream limit", () => {
  const result = runPreflight({ WORKBENCH_IMPORT_MAX_FIGMA_BYTES: "52428801" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_IMPORT_MAX_FIGMA_BYTES exceeds the Import Worker ClamAV stream limit/);
});

test("server preflight includes GitHub blobs in the Import Worker ClamAV capacity contract", () => {
  const result = runPreflight({ WORKBENCH_IMPORT_MAX_GITHUB_BYTES: "52428801" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_IMPORT_MAX_GITHUB_BYTES exceeds the Import Worker ClamAV stream limit/);
});

test("server preflight rejects a File Worker ClamAV limit above its upload contract", () => {
  const result = runPreflight({ WORKBENCH_CLAMAV_STREAM_MAX_BYTES: "52428800" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /File Worker ClamAV stream limit must be 26214400/);
});

test("server preflight rejects an Import Worker limit below validation ClamD", () => {
  const result = runPreflight({ WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES: "26214400" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Import Worker ClamAV stream limit must be 52428800/);
});

test("server preflight requires an independent Import Worker S3 identity", () => {
  const result = runPreflight({ WORKBENCH_IMPORT_S3_ACCESS_KEY_ID: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_IMPORT_S3_ACCESS_KEY_ID must occur exactly once/);
});

test("server preflight rejects a non-canonical Canvas visual capability path", () => {
  const result = runPreflight({
    WORKBENCH_CANVAS_VISUAL_URL: "https://workbench.example.test/api/v1/runtime/canvas/images",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must share the Canvas tool origin/u);
});

function runPreflight(overrides) {
  const appDir = mkdtempSync(join(tmpdir(), "workbench-preflight-"));
  const deployDir = join(appDir, "deploy");
  const vaultDir = join(appDir, "knowledge-vault");
  mkdirSync(deployDir);
  mkdirSync(vaultDir);

  const env = {
    WORKBENCH_WEB_ORIGIN: "https://workbench.example.test",
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.example.test",
    WORKBENCH_ENTERPRISE_SSO_ENABLED: "true",
    WORKBENCH_OIDC_PROVIDER_ISSUER: "https://identity.example.test",
    WORKBENCH_OIDC_CLIENT_ID: "workbench-web",
    WORKBENCH_OIDC_CLIENT_SECRET: "oidc-secret",
    WORKBENCH_IDENTITY_HOSTNAME: "identity.example.test",
    WORKBENCH_CANVAS_TOOL_URL: "https://workbench.example.test/api/v1/runtime/canvas/tools/execute",
    WORKBENCH_CANVAS_VISUAL_URL: "https://workbench.example.test/api/v1/runtime/canvas/visuals",
    WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR: "/srv/workbench/tokenizer",
    WORKBENCH_S3_INTERNAL_ENDPOINT: "http://object-storage:9000",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.example.test/workbench",
    WORKBENCH_S3_CONDITIONAL_CREATE_MODE: "s3-if-none-match",
    WORKBENCH_LOCAL_S3_PORT: "9100",
    WORKBENCH_CLAMAV_HOST: "clamav",
    WORKBENCH_CLAMAV_STREAM_MAX_BYTES: "26214400",
    WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES: "52428800",
    WORKBENCH_FILE_SCAN_MODE: "clamav",
    WORKBENCH_IMPORT_MAX_URL_BYTES: "10485760",
    WORKBENCH_IMPORT_MAX_GITHUB_BYTES: "52428800",
    WORKBENCH_IMPORT_MAX_FIGMA_BYTES: "26214400",
    WORKBENCH_IMPORT_S3_ACCESS_KEY_ID: "import-access-key",
    WORKBENCH_IMPORT_S3_SECRET_ACCESS_KEY: "import-secret-key",
    WORKBENCH_DOCLING_URL: "http://docling:5001",
    WORKBENCH_AUTH_CLIENT_IP_HEADER: "x-workbench-client-ip",
    WORKBENCH_PUBLIC_REGISTRATION_ENABLED: "false",
    WORKBENCH_EDGE_WIREGUARD_IP: "10.88.0.1",
    WORKBENCH_ORIGIN_WIREGUARD_IP: "10.88.0.2",
    WORKBENCH_EDGE_WIREGUARD_ENDPOINT: "8.130.160.177:51820",
    WORKBENCH_ORIGIN_HTTP_PORT: "8080",
    WORKBENCH_EDGE_ORIGIN_AUTH_SECRET: "A".repeat(64),
    ...overrides,
  };
  const envSource = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  writeFileSync(join(deployDir, "workbench.env"), `${envSource}\n`);
  writeFileSync(join(deployDir, "workbench-compose.yml"), "services: {}\n");
  writeFileSync(join(deployDir, "workbench-server-validation-compose.yml"), "services: {}\n");
  writeFileSync(join(deployDir, "workbench-dex-config.yaml"), "issuer: https://identity.example.test\n");
  writeFileSync(join(deployDir, "workbench-server-validation.Caddyfile"), ":8080 { respond 403 }\n");
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
  writeFileSync(join(vaultDir, "README.md"), "# fixture\n");

  try {
    return spawnSync("sh", [preflight], {
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_APP_DIR: appDir,
        WORKBENCH_ORIGIN_MANIFEST_SCRIPT: originManifest,
        WORKBENCH_ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT: originWireguardPreflight,
        WORKBENCH_ORIGIN_WIREGUARD_CONFIG: wireguardConfig,
      },
    });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}
