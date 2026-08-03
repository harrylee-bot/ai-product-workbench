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
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "valid");
    assert.equal(report.databaseBackend, "sqlite");
    assert.equal(report.workbenchToolCount, WORKBENCH_RUNTIME_TOOLS.length);
  } finally {
    fixture.cleanup();
  }
});

test("accepts durable SQLite persistence beneath the DeerFlow home", () => {
  const fixture = createFixture({
    config: {
      ...validConfig(),
      database: {
        backend: "sqlite",
        sqlite_dir: ".deer-flow/data",
      },
    },
  });
  try {
    const result = runCheck(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).databaseBackend, "sqlite");
  } finally {
    fixture.cleanup();
  }
});

test("rejects the in-memory DeerFlow database backend", () => {
  const fixture = createFixture({
    config: {
      ...validConfig(),
      database: { backend: "memory" },
    },
  });
  try {
    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /database\.backend=memory is not allowed/u);
  } finally {
    fixture.cleanup();
  }
});

for (const [label, sqliteDir, expectedMessage] of [
  ["missing", undefined, /database\.sqlite_dir is required/u],
  ["absolute", "/var/lib/deerflow", /database\.sqlite_dir must be relative/u],
  ["escaping", ".deer-flow/../outside", /beneath \.deer-flow/u],
  ["outside", "runtime/data", /beneath \.deer-flow/u],
]) {
  test(`rejects ${label} SQLite persistence path`, () => {
    const database = { backend: "sqlite" };
    if (sqliteDir !== undefined) database.sqlite_dir = sqliteDir;
    const fixture = createFixture({
      config: {
        ...validConfig(),
        database,
      },
    });
    try {
      const result = runCheck(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expectedMessage);
    } finally {
      fixture.cleanup();
    }
  });
}

test("accepts a PostgreSQL URL through an exact environment reference", () => {
  const fixture = createFixture({
    config: {
      ...validConfig(),
      database: {
        backend: "postgres",
        postgres_url: "$DEER_FLOW_DATABASE_URL",
      },
    },
    providerEnv: providerEnvSource("DEER_FLOW_DATABASE_URL=postgresql://deerflow.example.test/runtime"),
  });
  try {
    const result = runCheck(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).databaseBackend, "postgres");
  } finally {
    fixture.cleanup();
  }
});

test("rejects a PostgreSQL URL available only to the preflight process", () => {
  const variableName = "WORKBENCH_RUNTIME_CONFIG_TEST_DATABASE_URL";
  const fixture = createFixture({
    config: {
      ...validConfig(),
      database: {
        backend: "postgres",
        postgres_url: `$${variableName}`,
      },
    },
  });
  try {
    const result = runCheck(fixture, {
      [variableName]: "postgres://deerflow.example.test/runtime",
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`database\\.postgres_url environment variable ${variableName} must be declared in provider environment`, "u"),
    );
    assert.doesNotMatch(result.stderr, /deerflow\.example\.test/u);
  } finally {
    fixture.cleanup();
  }
});

test("rejects provider values that Compose could interpolate from an unsigned variable", () => {
  const fixture = createFixture({
    providerEnv: [
      "UNTRACKED=runtime-secret-a",
      "OPENAI_API_KEY=$UNTRACKED",
      "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL=https://provider.example.test",
      "WORKBENCH_DEERFLOW_PROVIDER_MODEL=gpt-5.5",
      "",
    ].join("\n"),
  });
  try {
    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OPENAI_API_KEY.*must not contain/u);
    assert.doesNotMatch(result.stderr, /runtime-secret-a/u);
  } finally {
    fixture.cleanup();
  }
});

test("rejects a missing PostgreSQL URL environment reference", () => {
  const fixture = createFixture({
    config: {
      ...validConfig(),
      database: {
        backend: "postgres",
        postgres_url: "$WORKBENCH_MISSING_DEERFLOW_DATABASE_URL",
      },
    },
  });
  try {
    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /database\.postgres_url environment variable WORKBENCH_MISSING_DEERFLOW_DATABASE_URL must be declared in provider environment/u);
  } finally {
    fixture.cleanup();
  }
});

for (const [label, value, expectedMessage] of [
  ["non-PostgreSQL", "sqlite:///tmp/deerflow.db", /must use PostgreSQL/u],
  ["query-bearing", "postgresql://deerflow.example.test/runtime?sslmode=require", /query or fragment/u],
  ["fragment-bearing", "postgresql://deerflow.example.test/runtime#fragment", /query or fragment/u],
]) {
  test(`rejects a ${label} PostgreSQL URL`, () => {
    const fixture = createFixture({
      config: {
        ...validConfig(),
        database: {
          backend: "postgres",
          postgres_url: "$DEER_FLOW_DATABASE_URL",
        },
      },
      providerEnv: providerEnvSource(`DEER_FLOW_DATABASE_URL=${value}`),
    });
    try {
      const result = runCheck(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expectedMessage);
      assert.doesNotMatch(result.stderr, /deerflow\.example\.test/u);
    } finally {
      fixture.cleanup();
    }
  });
}

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

for (const [mutation, article] of [["missing", "a"], ["altered", "an"]]) {
  test(`rejects ${article} ${mutation} canonical PRD reference reader`, () => {
    const tools = structuredClone(WORKBENCH_RUNTIME_TOOLS);
    const readerIndex = tools.findIndex((tool) => tool.name === "read_file");
    assert.notEqual(readerIndex, -1, "canonical contract must define the restricted read_file tool");
    if (mutation === "missing") {
      tools.splice(readerIndex, 1);
    } else {
      tools[readerIndex].use = "untrusted.module:read_file";
    }
    const fixture = createFixture({
      config: {
        ...validConfig(),
        tools,
      },
    });
    try {
      const result = runCheck(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /canonical read_file tool/u);
    } finally {
      fixture.cleanup();
    }
  });
}

test("rejects any tool or tool group outside the exact Workbench allowlist", () => {
  const fixture = createFixture({
    config: {
      ...validConfig(),
      tool_groups: [WORKBENCH_TOOL_GROUP, { name: "injected" }],
      tools: [
        ...WORKBENCH_RUNTIME_TOOLS,
        { name: "injected_exec", group: "injected", use: "attacker_package:execute" },
      ],
    },
  });
  try {
    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must exactly equal the canonical Workbench allowlist/u);
    assert.doesNotMatch(result.stderr, /attacker_package/u);
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
  writeFileSync(providerEnvPath, providerEnv || providerEnvSource(), { mode: 0o600 });
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
    database: {
      backend: "sqlite",
      sqlite_dir: ".deer-flow/data",
    },
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

function providerEnvSource(extraLine = "") {
  return [
    "OPENAI_API_KEY=test-key",
    "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL=https://provider.example.test",
    "WORKBENCH_DEERFLOW_PROVIDER_MODEL=gpt-5.5",
    extraLine,
    "",
  ].filter((line, index, lines) => line || index === lines.length - 1).join("\n");
}

function runCheck(fixture, environment = {}) {
  return spawnSync(process.execPath, [
    scriptPath,
    "--config", fixture.configPath,
    "--provider-env", fixture.providerEnvPath,
  ], { encoding: "utf8", env: { ...process.env, ...environment } });
}
