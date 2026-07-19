import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const preflight = resolve("deploy/workbench-production-preflight.sh");
const originManifest = resolve("scripts/workbench-origin-manifest.mjs");

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

test("production preflight rejects a Canvas visual endpoint outside the tool origin", () => {
  const result = runPreflight({
    WORKBENCH_CANVAS_VISUAL_URL: "https://other.example.test/api/v1/runtime/canvas/visuals",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must share the Canvas tool origin/u);
});

function runPreflight(overrides) {
  const appDir = mkdtempSync(join(tmpdir(), "workbench-production-preflight-"));
  const deployDir = join(appDir, "deploy");
  mkdirSync(deployDir);
  mkdirSync(join(appDir, "knowledge-vault"));
  writeFileSync(join(appDir, "knowledge-vault/README.md"), "# fixture\n");
  writeFileSync(join(deployDir, "workbench-compose.yml"), "services: {}\n");
  writeFileSync(join(deployDir, "workbench-production.Caddyfile"), ":8080 { respond 403 }\n");
  const env = {
    WORKBENCH_WEB_ORIGIN: "https://workbench.example.test",
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.example.test",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.example.test/workbench",
    WORKBENCH_OIDC_PROVIDER_ISSUER: "https://identity.example.test/realms/workbench",
    WORKBENCH_IDENTITY_HOSTNAME: "identity.example.test",
    WORKBENCH_CANVAS_TOOL_URL: "https://workbench.example.test/api/v1/runtime/canvas/tools/execute",
    WORKBENCH_CANVAS_VISUAL_URL: "https://workbench.example.test/api/v1/runtime/canvas/visuals",
    WORKBENCH_DATABASE_URL: "postgresql://workbench:secret@postgres:5432/workbench",
    WORKBENCH_PUBLIC_REGISTRATION_ENABLED: "false",
    WORKBENCH_AUTH_CLIENT_IP_HEADER: "x-workbench-client-ip",
    WORKBENCH_CDN_EDGE_CIDRS: "192.0.2.0/24",
    WORKBENCH_CDN_EDGE_CIDRS_SOURCE: "https://cdn.example.test/ranges/v1",
    WORKBENCH_CDN_ORIGIN_AUTH_SECRET: "A".repeat(64),
    WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR: "/srv/tokenizer",
    WORKBENCH_IMAGE_INVENTORY_PATH: "/srv/image-manifest.json",
    WORKBENCH_SOURCE_COMMIT: "a".repeat(40),
    WORKBENCH_FILE_SCAN_MODE: "clamav",
    WORKBENCH_POSTGRES_IMAGE: `pgvector/pgvector:pg16@sha256:${"b".repeat(64)}`,
    WORKBENCH_NGINX_IMAGE: `nginx:1.27.5-alpine@sha256:${"c".repeat(64)}`,
    ...overrides,
  };
  writeFileSync(join(deployDir, "workbench.env"), `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  try {
    return spawnSync("sh", [preflight], {
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_APP_DIR: appDir,
        WORKBENCH_ORIGIN_MANIFEST_SCRIPT: originManifest,
        ...overrides,
      },
    });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}
