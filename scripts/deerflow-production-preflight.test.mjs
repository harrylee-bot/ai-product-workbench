import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const preflight = resolve("deploy/deerflow-production-preflight.sh");
const fragment = resolve("integrations/deerflow/runtime-tools/config.fragment.yaml");
const patchManifest = resolve(
  "integrations/deerflow/source-patches/345f08be00c8a9495079b732a39b46aa9af1584e/manifest.json",
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

test("DeerFlow preflight requires an immutable Validator Node image", () => {
  const missing = runPreflight(validProviderEnv(), null, { nodeImageRef: null });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /WORKBENCH_DEERFLOW_NODE_IMAGE_REF must occur exactly once/u);

  const mutable = runPreflight(validProviderEnv(), null, {
    nodeImageRef: "node:22-bookworm-slim",
  });
  assert.notEqual(mutable.status, 0);
  assert.match(
    mutable.stderr,
    /WORKBENCH_DEERFLOW_NODE_IMAGE_REF must be an immutable digest reference/u,
  );
});

test("DeerFlow preflight rejects a Validator Node image label mismatch", () => {
  const result = runPreflight(validProviderEnv(), {
    configOwner: "65532:65532",
    homeOwner: "65532:65532",
  }, {
    labelNodeImageRef: `node:22-bookworm-slim@sha256:${"e".repeat(64)}`,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /image is not bound to WORKBENCH_DEERFLOW_NODE_IMAGE_REF/u);
});

test("DeerFlow preflight rejects a root-owned effective config", () => {
  const result = runPreflight(validProviderEnv(), {
    configOwner: "0:0",
    homeOwner: "65532:65532",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /effective config must be owned by the DeerFlow runtime identity 65532:65532/u);
});

test("DeerFlow preflight rejects a root-owned runtime home", () => {
  const result = runPreflight(validProviderEnv(), {
    configOwner: "65532:65532",
    homeOwner: "0:0",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DeerFlow home must be owned by the DeerFlow runtime identity 65532:65532/u);
});

test("DeerFlow preflight accepts private paths owned by the pinned runtime identity", () => {
  const result = runPreflight(validProviderEnv(), {
    configOwner: "65532:65532",
    homeOwner: "65532:65532",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deerflow production preflight: ok/u);
  const probeArguments = result.stderr.split("\n");
  for (const argument of [
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "65532:65532",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "64",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=67108864,uid=65532,gid=65532,mode=1770",
    "--entrypoint",
    "/bin/sh",
    `registry.example.test/workbench/deerflow@sha256:${"c".repeat(64)}`,
  ]) {
    assert.ok(probeArguments.includes(`validator-probe-arg=${argument}`), `missing probe argument: ${argument}`);
  }
  assert.match(result.stderr, /validator-probe-arg=.*validate_runtime_result\(\{\}\)/u);
});

test("DeerFlow preflight fails closed when the Validator image probe fails", () => {
  const result = runPreflight(validProviderEnv(), {
    configOwner: "65532:65532",
    homeOwner: "65532:65532",
  }, { validatorProbeStatus: 42 });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_RUNTIME_VALIDATOR_IMAGE_PROBE_FAILED/u);
});

function runPreflight(providerEnvSource, ownership = null, overrides = {}) {
  const appDir = mkdtempSync(join(tmpdir(), "workbench-deerflow-preflight-"));
  const deployDir = join(appDir, "deploy");
  const integrationsDir = join(appDir, "integrations/deerflow");
  const runtimeToolsDir = join(integrationsDir, "runtime-tools");
  const patchDir = join(integrationsDir, "source-patches/345f08be00c8a9495079b732a39b46aa9af1584e");
  const scriptsDir = join(appDir, "scripts");
  const etcDir = join(appDir, "etc/workbench/deerflow");
  const runtimeDir = join(appDir, "var/lib/workbench/deerflow");
  const fakeBinDir = join(appDir, "test-bin");
  const effectiveConfig = join(runtimeDir, "config.effective.yaml");
  const runtimeHome = join(runtimeDir, "home");

  mkdirSync(deployDir, { recursive: true });
  mkdirSync(runtimeToolsDir, { recursive: true });
  mkdirSync(patchDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(etcDir, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });

  writeFileSync(join(runtimeToolsDir, "config.fragment.yaml"), readFixture(fragment));
  writeFileSync(join(patchDir, "manifest.json"), readFixture(patchManifest));
  writeFileSync(join(deployDir, "deerflow-runtime-compose.yml"), "services: {}\n");
  writeFileSync(join(etcDir, "config.base.yaml"), "models: []\ntool_groups: []\ntools: []\n");
  writeFileSync(effectiveConfig, "models: []\ntool_groups: []\ntools: []\n", { mode: 0o600 });
  chmodSync(effectiveConfig, 0o600);
  writeFileSync(join(etcDir, "provider.env"), providerEnvSource, { mode: 0o600 });
  chmodSync(join(etcDir, "provider.env"), 0o600);
  writeFileSync(join(etcDir, "request-scoped-secrets.attestation.json"), "{}\n");
  writeFileSync(join(scriptsDir, "assert-deerflow-production-deployment.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "generate-workbench-runtime-result-validator.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "merge-deerflow-config.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "assert-deerflow-runtime-config.mjs"), "process.exit(99);\n");
  writeFileSync(join(scriptsDir, "assert-deerflow-secret-channel-attestation.mjs"), "process.exit(99);\n");

  const envFile = join(deployDir, "workbench.env");
  const nodeImageRef = overrides.nodeImageRef === undefined
    ? `node:22-bookworm-slim@sha256:${"d".repeat(64)}`
    : overrides.nodeImageRef;
  const workbenchSourceCommit = overrides.workbenchSourceCommit ?? "a".repeat(40);
  writeFileSync(envFile, [
    `DEER_FLOW_HOME=${runtimeHome}`,
    `WORKBENCH_DEERFLOW_BASE_CONFIG_PATH=${join(etcDir, "config.base.yaml")}`,
    `DEER_FLOW_CONFIG_PATH=${effectiveConfig}`,
    `WORKBENCH_DEERFLOW_PROVIDER_ENV_FILE=${join(etcDir, "provider.env")}`,
    "WORKBENCH_DEERFLOW_HOST_PORT=2026",
    "WORKBENCH_INTERNAL_NETWORK_NAME=workbench_internal",
    "WORKBENCH_DEERFLOW_INTERNAL_AUTH_TOKEN=test-internal-token",
    "WORKBENCH_DEERFLOW_COMMIT=7a6c4a994a86583d2a3c056ee9d0f157d4f030c2",
    `WORKBENCH_SOURCE_COMMIT=${workbenchSourceCommit}`,
    `WORKBENCH_DEERFLOW_BASE_IMAGE_REF=registry.example.test/deerflow/base@sha256:${"b".repeat(64)}`,
    ...(nodeImageRef === null ? [] : [`WORKBENCH_DEERFLOW_NODE_IMAGE_REF=${nodeImageRef}`]),
    `WORKBENCH_DEERFLOW_IMAGE_DIGEST=sha256:${"c".repeat(64)}`,
    `WORKBENCH_DEERFLOW_IMAGE_REF=registry.example.test/workbench/deerflow@sha256:${"c".repeat(64)}`,
    `WORKBENCH_DEERFLOW_SECRET_CHANNEL_ATTESTATION_PATH=${join(etcDir, "request-scoped-secrets.attestation.json")}`,
    "",
  ].join("\n"));

  if (ownership) {
    mkdirSync(fakeBinDir, { recursive: true });
    writeExecutable(join(fakeBinDir, "node"), "#!/bin/sh\nexit 0\n");
    writeExecutable(join(fakeBinDir, "stat"), [
      "#!/bin/sh",
      "if { [ \"$1\" = \"-c\" ] || [ \"$1\" = \"-f\" ]; } && [ \"$2\" = \"%u:%g\" ]; then",
      "  case \"$3\" in",
      "    \"$TEST_EFFECTIVE_CONFIG\") printf '%s\\n' \"$TEST_CONFIG_OWNER\"; exit 0 ;;",
      "    \"$TEST_RUNTIME_HOME\") printf '%s\\n' \"$TEST_HOME_OWNER\"; exit 0 ;;",
      "  esac",
      "fi",
      "if [ \"$1\" = \"-c\" ] && [ \"$2\" = \"%a\" ]; then",
      "  /usr/bin/stat -c '%a' \"$3\" 2>/dev/null && exit 0",
      "  exec /usr/bin/stat -f '%Lp' \"$3\"",
      "fi",
      "exec /usr/bin/stat \"$@\"",
      "",
    ].join("\n"));
    writeExecutable(join(fakeBinDir, "docker"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"run\" ]; then",
      "  shift",
      "  for arg in \"$@\"; do printf 'validator-probe-arg=%s\\n' \"$arg\" >&2; done",
      "  exit \"${TEST_VALIDATOR_PROBE_STATUS:-0}\"",
      "fi",
      "case \" $* \" in",
      "  *' {{join .RepoDigests \" \"}} '*) printf '%s@%s\\n' \"$TEST_IMAGE_REPOSITORY\" \"$TEST_IMAGE_DIGEST\" ;;",
      "  *' {{json .Config.Labels}} '*)",
      "    if [ \"$TEST_INCLUDE_NODE_LABEL\" = \"1\" ]; then",
      "      printf '{\"org.opencontainers.image.revision\":\"%s\",\"io.workbench.deerflow.source-commit\":\"%s\",\"io.workbench.deerflow.base-image\":\"%s\",\"io.workbench.deerflow.validator-node-image\":\"%s\",\"io.workbench.deerflow.tool-scope-patch-sha256\":\"%s\"}\\n' \"$TEST_SOURCE_COMMIT\" \"$TEST_DEERFLOW_COMMIT\" \"$TEST_BASE_IMAGE_REF\" \"$TEST_NODE_IMAGE_REF\" \"$TEST_PATCH_SHA256\"",
      "    else",
      "      printf '{\"org.opencontainers.image.revision\":\"%s\",\"io.workbench.deerflow.source-commit\":\"%s\",\"io.workbench.deerflow.base-image\":\"%s\",\"io.workbench.deerflow.tool-scope-patch-sha256\":\"%s\"}\\n' \"$TEST_SOURCE_COMMIT\" \"$TEST_DEERFLOW_COMMIT\" \"$TEST_BASE_IMAGE_REF\" \"$TEST_PATCH_SHA256\"",
      "    fi",
      "    ;;",
      "  *' {{.Internal}} '*) printf 'true\\n' ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"));
  }

  try {
    return spawnSync("sh", [preflight], {
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_APP_DIR: appDir,
        WORKBENCH_ENV_FILE: envFile,
        WORKBENCH_DEERFLOW_COMPOSE_FILE: join(deployDir, "deerflow-runtime-compose.yml"),
        ...(ownership ? {
          PATH: `${fakeBinDir}:${process.env.PATH}`,
          TEST_EFFECTIVE_CONFIG: effectiveConfig,
          TEST_RUNTIME_HOME: runtimeHome,
          TEST_CONFIG_OWNER: ownership.configOwner,
          TEST_HOME_OWNER: ownership.homeOwner,
          TEST_IMAGE_REPOSITORY: "registry.example.test/workbench/deerflow",
          TEST_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
          TEST_SOURCE_COMMIT: workbenchSourceCommit,
          TEST_DEERFLOW_COMMIT: "7a6c4a994a86583d2a3c056ee9d0f157d4f030c2",
          TEST_BASE_IMAGE_REF: `registry.example.test/deerflow/base@sha256:${"b".repeat(64)}`,
          TEST_NODE_IMAGE_REF: overrides.labelNodeImageRef
            ?? `node:22-bookworm-slim@sha256:${"d".repeat(64)}`,
          TEST_INCLUDE_NODE_LABEL: overrides.labelNodeImageRef === null ? "0" : "1",
          TEST_VALIDATOR_PROBE_STATUS: String(overrides.validatorProbeStatus ?? 0),
          TEST_PATCH_SHA256: createHash("sha256").update(readFixture(patchManifest)).digest("hex"),
        } : {}),
      },
    });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}

function validProviderEnv() {
  return [
    "OPENAI_API_KEY=test-key-with-enough-entropy",
    "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL=https://provider.example.test/v1",
    "WORKBENCH_DEERFLOW_PROVIDER_MODEL=gpt5.5",
    "",
  ].join("\n");
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function readFixture(path) {
  return readFileSync(path, "utf8");
}
