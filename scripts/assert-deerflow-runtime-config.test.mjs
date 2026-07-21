import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  WORKBENCH_RUNTIME_TOOLS,
  WORKBENCH_TOOL_GROUP,
} from "./deerflow-workbench-tool-contract.mjs";

const scriptPath = fileURLToPath(new URL("./assert-deerflow-runtime-config.mjs", import.meta.url));

test("accepts the pinned OpenAI-compatible model and canonical Workbench tools", () => {
  const fixture = createFixture();
  try {
    const result = runCheck(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "valid");
  } finally {
    fixture.cleanup();
  }
});

test("rejects the legacy model and sandbox shape before runtime startup", () => {
  const fixture = createFixture({
    config: {
      models: [{ name: "gpt-5.5", use: "datatoken:gpt-5.5" }],
      sandbox: {},
      tool_groups: [WORKBENCH_TOOL_GROUP],
      tools: WORKBENCH_RUNTIME_TOOLS,
    },
  });
  try {
    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config_version must be a positive integer/u);
  } finally {
    fixture.cleanup();
  }
});

test("rejects inline provider credentials and unapproved base URL references", () => {
  const fixture = createFixture({
    config: {
      ...validConfig(),
      models: [{
        ...validConfig().models[0],
        api_key: "sk-inline-secret",
        base_url: "https://provider.example.test/v1",
      }],
    },
  });
  try {
    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /model api_key must reference OPENAI_API_KEY/u);
    assert.doesNotMatch(result.stderr, /sk-inline-secret/u);
  } finally {
    fixture.cleanup();
  }
});

function createFixture({ config = validConfig(), providerEnv = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "workbench-deerflow-runtime-config-"));
  const configPath = path.join(root, "config.yaml");
  const providerEnvPath = path.join(root, "provider.env");
  writeFileSync(configPath, YAML.stringify(config), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  writeFileSync(providerEnvPath, providerEnv || [
    "OPENAI_API_KEY=test-key",
    "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL=https://provider.example.test",
    "WORKBENCH_DEERFLOW_PROVIDER_MODEL=gpt-5.5",
    "",
  ].join("\n"), { mode: 0o600 });
  chmodSync(providerEnvPath, 0o600);
  return {
    configPath,
    providerEnvPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function validConfig() {
  return {
    config_version: 1,
    models: [{
      name: "gpt-5.5",
      use: "langchain_openai:ChatOpenAI",
      model: "gpt-5.5",
      api_key: "$OPENAI_API_KEY",
      base_url: "$WORKBENCH_DEERFLOW_PROVIDER_BASE_URL",
    }],
    sandbox: {
      use: "deerflow.sandbox.local:LocalSandboxProvider",
      allow_host_bash: false,
    },
    tool_groups: [WORKBENCH_TOOL_GROUP],
    tools: WORKBENCH_RUNTIME_TOOLS,
  };
}

function runCheck(fixture) {
  return spawnSync(process.execPath, [
    scriptPath,
    "--config", fixture.configPath,
    "--provider-env", fixture.providerEnvPath,
  ], { encoding: "utf8" });
}
