import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const preflight = resolve("deploy/deerflow-production-preflight.sh");
const fragment = resolve("integrations/deerflow/runtime-tools/config.fragment.yaml");
const patchManifest = resolve(
  "integrations/deerflow/source-patches/7a6c4a994a86583d2a3c056ee9d0f157d4f030c2/manifest.json",
);

test("DeerFlow preflight rejects an empty provider environment", () => {
  const result = runPreflight("");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENAI_API_KEY must occur exactly once in provider environment/u);
});

test("DeerFlow preflight requires a fixed provider model id", () => {
  const result = runPreflight([
    "OPENAI_API_KEY=test-key-with-enough-entropy",
    "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL=https://provider.example.test",
    "",
  ].join("\n"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_DEERFLOW_PROVIDER_MODEL must occur exactly once/u);
});

test("DeerFlow preflight rejects provider base URLs that are not safe HTTPS origins", () => {
  const result = runPreflight([
    "OPENAI_API_KEY=test-key-with-enough-entropy",
    "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL=http://provider.example.test/v1",
    "WORKBENCH_DEERFLOW_PROVIDER_MODEL=gpt5.5",
    "",
  ].join("\n"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_DEERFLOW_PROVIDER_BASE_URL must use HTTPS/u);
  assert.doesNotMatch(result.stderr, /test-key-with-enough-entropy/u);
});

test("DeerFlow preflight rejects mutable provider model aliases", () => {
  const result = runPreflight([
    "OPENAI_API_KEY=test-key-with-enough-entropy",
    "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL=https://provider.example.test/v1",
    "WORKBENCH_DEERFLOW_PROVIDER_MODEL=latest",
    "",
  ].join("\n"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_DEERFLOW_PROVIDER_MODEL must be a fixed provider model id/u);
});

function runPreflight(providerEnvSource) {
  const appDir = mkdtempSync(join(tmpdir(), "workbench-deerflow-preflight-"));
  const deployDir = join(appDir, "deploy");
  const integrationsDir = join(appDir, "integrations/deerflow");
  const runtimeToolsDir = join(integrationsDir, "runtime-tools");
  const patchDir = join(integrationsDir, "source-patches/7a6c4a994a86583d2a3c056ee9d0f157d4f030c2");
  const scriptsDir = join(appDir, "scripts");
  const etcDir = join(appDir, "etc/workbench/deerflow");
  const runtimeDir = join(appDir, "var/lib/workbench/deerflow");
  const releaseDir = join(appDir, "etc/workbench/release");

  mkdirSync(deployDir, { recursive: true });
  mkdirSync(runtimeToolsDir, { recursive: true });
  mkdirSync(patchDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(etcDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(runtimeDir, "home"), { recursive: true, mode: 0o700 });
  mkdirSync(releaseDir, { recursive: true });

  writeFileSync(join(runtimeToolsDir, "config.fragment.yaml"), readFixture(fragment));
  writeFileSync(join(patchDir, "manifest.json"), readFixture(patchManifest));
  writeFileSync(join(deployDir, "deerflow-runtime-compose.yml"), "services: {}\n");
  writeFileSync(join(etcDir, "config.base.yaml"), "models: []\ntool_groups: []\ntools: []\n");
  writeFileSync(join(runtimeDir, "config.effective.yaml"), "models: []\ntool_groups: []\ntools: []\n", { mode: 0o600 });
  chmodSync(join(runtimeDir, "config.effective.yaml"), 0o600);
  writeFileSync(join(etcDir, "provider.env"), providerEnvSource, { mode: 0o600 });
  chmodSync(join(etcDir, "provider.env"), 0o600);
  writeFileSync(join(etcDir, "request-scoped-secrets.attestation.json"), "{}\n");
  writeFileSync(join(releaseDir, "production-image-manifest.json"), "{}\n");
  writeFileSync(join(releaseDir, "production-image-manifest.bundle.json"), "{}\n");
  writeFileSync(join(scriptsDir, "assert-deerflow-production-deployment.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "generate-workbench-runtime-result-validator.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "merge-deerflow-config.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "assert-deerflow-runtime-config.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "assert-deerflow-secret-channel-attestation.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "production-image-inventory.mjs"), "process.exit(99);\n");

  const envFile = join(deployDir, "workbench.env");
  writeFileSync(envFile, [
    `DEER_FLOW_HOME=${join(runtimeDir, "home")}`,
    `WORKBENCH_DEERFLOW_BASE_CONFIG_PATH=${join(etcDir, "config.base.yaml")}`,
    `DEER_FLOW_CONFIG_PATH=${join(runtimeDir, "config.effective.yaml")}`,
    `WORKBENCH_DEERFLOW_PROVIDER_ENV_FILE=${join(etcDir, "provider.env")}`,
    "WORKBENCH_DEERFLOW_HOST_PORT=2026",
    "WORKBENCH_INTERNAL_NETWORK_NAME=workbench_internal",
    "WORKBENCH_DEERFLOW_INTERNAL_AUTH_TOKEN=test-internal-token",
    "WORKBENCH_DEERFLOW_COMMIT=7a6c4a994a86583d2a3c056ee9d0f157d4f030c2",
    `WORKBENCH_SOURCE_COMMIT=${"a".repeat(40)}`,
    `WORKBENCH_DEERFLOW_BASE_IMAGE_REF=registry.example.test/deerflow/base@sha256:${"b".repeat(64)}`,
    `WORKBENCH_DEERFLOW_IMAGE_DIGEST=sha256:${"c".repeat(64)}`,
    `WORKBENCH_DEERFLOW_IMAGE_REF=registry.example.test/workbench/deerflow@sha256:${"c".repeat(64)}`,
    `WORKBENCH_IMAGE_INVENTORY_PATH=${join(releaseDir, "production-image-manifest.json")}`,
    `WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH=${join(releaseDir, "production-image-manifest.bundle.json")}`,
    "WORKBENCH_COSIGN_CERTIFICATE_IDENTITY=https://github.com/example/workbench/.github/workflows/workbench-ci.yml@refs/heads/production",
    "WORKBENCH_COSIGN_OIDC_ISSUER=https://token.actions.githubusercontent.com",
    `WORKBENCH_DEERFLOW_SECRET_CHANNEL_ATTESTATION_PATH=${join(etcDir, "request-scoped-secrets.attestation.json")}`,
    "",
  ].join("\n"));

  try {
    return spawnSync("sh", [preflight], {
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_APP_DIR: appDir,
        WORKBENCH_ENV_FILE: envFile,
        WORKBENCH_DEERFLOW_COMPOSE_FILE: join(deployDir, "deerflow-runtime-compose.yml"),
      },
    });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}

function readFixture(path) {
  return readFileSync(path, "utf8");
}
