import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const deployScript = resolve("deploy/server-deploy.sh");
const legacyValidatorNodeRollbackCommit = "4bf8c155678f2b5baf0ab42e938cfbeca09abdf1";
const queueParticipants = [
  "workbench-api",
  "workbench-worker",
  "workbench-file-worker",
  "workbench-import-worker",
  "workbench-export-worker",
];

test("full deployment stops every queue participant before the authorized migrator", () => {
  const result = runDeployment({ processAuthorization: "1" });

  assert.equal(result.status, 0, result.stderr);
  const stopIndex = findLine(result.lines, (line) => line.includes(" stop --timeout "));
  const migrateIndex = findLine(result.lines, (line) => line.includes(" run --rm --no-deps migrate"));
  const startIndex = findLine(
    result.lines,
    (line) => line.includes(" up -d --remove-orphans ") && !line.includes("--force-recreate"),
  );
  assert.ok(stopIndex >= 0, "the queue stop command must run");
  for (const service of queueParticipants) {
    assert.ok(result.lines[stopIndex].includes(service), `the queue stop must include ${service}`);
  }
  assert.ok(migrateIndex > stopIndex, "the migrator must run after every queue participant stops");
  assert.match(result.lines[migrateIndex], /^allow=1 /u);
  assert.ok(startIndex > migrateIndex, "services must start only after queue reconciliation succeeds");
});

test("failed queue reconciliation leaves producers and consumers stopped", () => {
  const result = runDeployment({ failMigration: true, processAuthorization: "1" });

  assert.equal(result.status, 42);
  const migrateIndex = findLine(result.lines, (line) => line.includes(" run --rm --no-deps migrate"));
  assert.ok(migrateIndex >= 0, "the controlled migrator must be attempted");
  assert.equal(
    findLine(
      result.lines,
      (line, index) => index > migrateIndex
        && line.includes(" up -d --remove-orphans ")
        && !line.includes("--force-recreate"),
    ),
    -1,
    "queue participants must not restart after reconciliation fails",
  );
  assert.match(result.stderr, /queue producers and consumers remain stopped/u);
});

test("an env-file value cannot persist queue policy recreate authorization", () => {
  const result = runDeployment({ envFileAuthorization: "1" });

  assert.equal(result.status, 0, result.stderr);
  const migrateLine = result.lines.find((line) => line.includes(" run --rm --no-deps migrate"));
  assert.ok(migrateLine, "the controlled migrator must run");
  assert.match(migrateLine, /^allow=0 /u);
});

test("partial deployment rejects queue policy recreate authorization", () => {
  const result = runDeployment({ deployTarget: "api", processAuthorization: "1" });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /requires DEPLOY_TARGET=all, migrate, or rollback/u);
  assert.equal(findLine(result.lines, (line) => line.includes(" stop --timeout ")), -1);
  assert.equal(findLine(result.lines, (line) => line.includes(" run --rm --no-deps migrate")), -1);
});

test("rollback restores queue policy with the previous candidate before teardown", () => {
  const result = runDeployment({ deployTarget: "rollback" });

  assert.equal(result.status, 0, result.stderr);
  const stopIndex = findLine(result.lines, (line) => line.includes(" stop --timeout "));
  const rollbackMigrateIndex = findLine(
    result.lines,
    (line) => line.includes(result.rollbackEnv) && line.includes(" run --rm --no-deps migrate"),
  );
  const downIndex = findLine(result.lines, (line) => line.includes(" down --remove-orphans"));
  assert.ok(stopIndex >= 0, "rollback must stop the active queue participants");
  assert.ok(rollbackMigrateIndex > stopIndex, "the previous migrator must run after the active participants stop");
  assert.match(result.lines[rollbackMigrateIndex], /^allow=1 /u);
  assert.ok(downIndex > rollbackMigrateIndex, "rollback must restore the old queue policy before stack teardown");
});

test("rollback reconciliation failure keeps the active stack from teardown", () => {
  const result = runDeployment({ deployTarget: "rollback", failMigration: true });

  assert.equal(result.status, 42);
  const rollbackMigrateIndex = findLine(
    result.lines,
    (line) => line.includes(result.rollbackEnv) && line.includes(" run --rm --no-deps migrate"),
  );
  assert.ok(rollbackMigrateIndex >= 0, "rollback must attempt the previous candidate migrator");
  assert.equal(
    findLine(result.lines, (line) => line.includes(" down --remove-orphans")),
    -1,
    "the active stack must not be torn down when old queue policy restoration fails",
  );
  assert.match(result.stderr, /Rollback queue reconciliation failed closed/u);
});

test("legacy rollback recursively verifies the inventory and both production preflights", () => {
  const result = runDeployment({
    deployTarget: "rollback",
    manageDeerflowRuntime: true,
    rollbackSourceCommit: legacyValidatorNodeRollbackCommit,
  });

  assert.equal(result.status, 0, result.stderr);
  const inventoryIndexes = result.lines
    .map((line, index) => line.startsWith("inventory-verifier ") ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(inventoryIndexes.length, 2, result.commandLog);
  for (const index of inventoryIndexes) {
    assert.match(result.lines[index], new RegExp(`--expected-commit ${legacyValidatorNodeRollbackCommit}`, "u"));
    assert.ok(result.lines[index].includes(`--env-file ${result.rollbackEnv}`));
  }

  const mainPreflightIndex = findLine(result.lines, (line) => line === "main-preflight");
  const deerflowPreflightIndex = findLine(result.lines, (line) => line === "deerflow-preflight");
  assert.ok(inventoryIndexes[1] > inventoryIndexes[0], "recursive deployment must re-run inventory verification");
  assert.ok(mainPreflightIndex > inventoryIndexes[1], "main preflight must run after recursive inventory verification");
  assert.ok(deerflowPreflightIndex > mainPreflightIndex, "DeerFlow preflight must run after the main preflight");
  assert.equal(result.lines.filter((line) => line === "main-preflight").length, 1);
  assert.equal(result.lines.filter((line) => line === "deerflow-preflight").length, 1);
});

function runDeployment({
  deployTarget = "all",
  envFileAuthorization = "0",
  failMigration = false,
  manageDeerflowRuntime = false,
  processAuthorization,
  rollbackSourceCommit = "a".repeat(40),
} = {}) {
  const appDir = mkdtempSync(join(tmpdir(), "workbench-server-deploy-queue-"));
  const deployDir = join(appDir, "deploy");
  const fakeBinDir = join(appDir, "test-bin");
  const stateDir = join(appDir, "state");
  const commandLogPath = join(appDir, "commands.log");
  const envFile = join(deployDir, "workbench.env");
  const rollbackEnv = join(deployDir, "rollback.env");
  const composeFile = join(deployDir, "workbench-compose.yml");
  const rollbackCompose = join(deployDir, "rollback-compose.yml");
  const composeOverlay = join(deployDir, "workbench-validation-overlay.yml");
  const preflight = join(deployDir, "preflight.sh");
  const deerflowCompose = join(deployDir, "deerflow-runtime-compose.yml");
  const deerflowPreflight = join(deployDir, "deerflow-preflight.sh");
  const deerflowBaseConfig = join(deployDir, "deerflow-base.yaml");
  const deerflowEffectiveConfig = join(stateDir, "deerflow-config.yaml");
  const deerflowHome = join(stateDir, "deerflow-home");
  const inventory = join(deployDir, "production-image-manifest.json");
  const inventoryBundle = join(deployDir, "production-image-manifest.bundle.json");

  mkdirSync(deployDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(commandLogPath, "");
  writeFileSync(envFile, `WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=${envFileAuthorization}\n`);
  writeFileSync(composeFile, "name: workbench\nservices: {}\n");
  writeFileSync(rollbackCompose, "name: workbench\nservices: {}\n");
  writeFileSync(composeOverlay, "services: {}\n");
  writeFileSync(deerflowCompose, "name: workbench-runtime\nservices: {}\n");
  writeFileSync(deerflowBaseConfig, "models: []\n");
  writeFileSync(inventory, "{}\n");
  writeFileSync(inventoryBundle, "{}\n");
  writeFileSync(rollbackEnv, [
    "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=0",
    `WORKBENCH_SOURCE_COMMIT=${rollbackSourceCommit}`,
    `WORKBENCH_IMAGE_INVENTORY_PATH=${inventory}`,
    `WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH=${inventoryBundle}`,
    "WORKBENCH_COSIGN_CERTIFICATE_IDENTITY=https://example.test/workbench.yml@refs/heads/main",
    "WORKBENCH_COSIGN_OIDC_ISSUER=https://token.actions.githubusercontent.com",
    ...(manageDeerflowRuntime ? [
      `WORKBENCH_DEERFLOW_BASE_CONFIG_PATH=${deerflowBaseConfig}`,
      `DEER_FLOW_CONFIG_PATH=${deerflowEffectiveConfig}`,
      `DEER_FLOW_HOME=${deerflowHome}`,
      `WORKBENCH_DEERFLOW_IMAGE_REF=registry.example.test/workbench/deerflow@sha256:${"d".repeat(64)}`,
      "WORKBENCH_INTERNAL_NETWORK_NAME=workbench_internal",
      "WORKBENCH_DEERFLOW_HOST_PORT=2026",
    ] : []),
    "",
  ].join("\n"));
  writeExecutable(preflight, "#!/bin/sh\nprintf 'main-preflight\\n' >> \"$TEST_COMMAND_LOG\"\n");
  writeExecutable(deerflowPreflight, "#!/bin/sh\nprintf 'deerflow-preflight\\n' >> \"$TEST_COMMAND_LOG\"\n");
  writeExecutable(join(fakeBinDir, "node"), fakeNodeSource());
  writeExecutable(join(fakeBinDir, "cosign"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "chown"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "chmod"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "docker"), fakeDockerSource());

  const env = {
    ...process.env,
    APP_DIR: appDir,
    PATH: `${fakeBinDir}:${process.env.PATH}`,
    WORKBENCH_ENV_FILE: envFile,
    WORKBENCH_COMPOSE_FILE: composeFile,
    WORKBENCH_COMPOSE_OVERLAY: deployTarget === "rollback" ? "" : composeOverlay,
    WORKBENCH_PREFLIGHT_SCRIPT: preflight,
    WORKBENCH_DEERFLOW_COMPOSE_FILE: deerflowCompose,
    WORKBENCH_DEERFLOW_PREFLIGHT_SCRIPT: deerflowPreflight,
    WORKBENCH_DEPLOY_IMAGE_MODE: deployTarget === "rollback" ? "pinned" : "build",
    WORKBENCH_MANAGE_DEERFLOW_RUNTIME: manageDeerflowRuntime ? "1" : "0",
    WORKBENCH_DEPLOY_LOCK_FILE: join(appDir, "deploy.lock"),
    WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS: "5",
    WORKBENCH_RUNTIME_QUEUE_STOP_TIMEOUT_SECONDS: "5",
    WORKBENCH_ROLLBACK_ENV_FILE: rollbackEnv,
    WORKBENCH_ROLLBACK_COMPOSE_FILE: rollbackCompose,
    DEPLOY_TARGET: deployTarget,
    TEST_COMMAND_LOG: commandLogPath,
    TEST_FAIL_MIGRATION: failMigration ? "1" : "0",
    TEST_ROLLBACK_ENV: rollbackEnv,
    TEST_STATE_DIR: stateDir,
  };
  if (processAuthorization === undefined) {
    delete env.WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE;
  } else {
    env.WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE = processAuthorization;
  }

  let result;
  try {
    result = spawnSync("bash", [deployScript], { encoding: "utf8", env });
    const commandLog = readFileSync(commandLogPath, "utf8");
    return {
      ...result,
      commandLog,
      lines: commandLog.trim().split("\n").filter(Boolean),
      rollbackEnv,
    };
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}

function fakeNodeSource() {
  return [
    "#!/bin/sh",
    "case \"$1\" in",
    "  */scripts/production-image-inventory.mjs)",
    "    printf 'inventory-verifier %s\\n' \"$*\" >> \"$TEST_COMMAND_LOG\"",
    "    ;;",
    "  */scripts/merge-deerflow-config.mjs)",
    "    printf 'deerflow-config-merge %s\\n' \"$*\" >> \"$TEST_COMMAND_LOG\"",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

function fakeDockerSource() {
  return [
    "#!/bin/sh",
    "printf 'allow=%s docker %s\\n' \"${WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE:-unset}\" \"$*\" >> \"$TEST_COMMAND_LOG\"",
    "if [ \"$1\" != compose ]; then",
    "  if [ \"$1 $2\" = 'inspect --format' ]; then printf 'healthy\\n'; fi",
    "  exit 0",
    "fi",
    "last=",
    "for arg in \"$@\"; do last=$arg; done",
    "case \" $* \" in",
    "  *' stop --timeout '*)",
    "    : > \"$TEST_STATE_DIR/stopped\"",
    "    rm -f \"$TEST_STATE_DIR/started\"",
    "    exit 0",
    "    ;;",
    "  *' run --rm --no-deps migrate '*)",
    "    if [ \"$TEST_FAIL_MIGRATION\" = 1 ]; then exit 42; fi",
    "    : > \"$TEST_STATE_DIR/migrated\"",
    "    exit 0",
    "    ;;",
    "  *' down --remove-orphans '*)",
    "    : > \"$TEST_STATE_DIR/stopped\"",
    "    rm -f \"$TEST_STATE_DIR/started\"",
    "    exit 0",
    "    ;;",
    "  *' up -d postgres '*)",
    "    : > \"$TEST_STATE_DIR/postgres\"",
    "    exit 0",
    "    ;;",
    "  *' up '*)",
    "    : > \"$TEST_STATE_DIR/started\"",
    "    rm -f \"$TEST_STATE_DIR/stopped\"",
    "    exit 0",
    "    ;;",
    "  *' ps -q '*)",
    "    if [ \"$last\" = -q ]; then printf 'existing-id\\n'; exit 0; fi",
    "    if [ \"$last\" = postgres ]; then printf 'postgres-id\\n'; exit 0; fi",
    "    case \"$last\" in",
    "      workbench-api|workbench-worker|workbench-file-worker|workbench-import-worker|workbench-export-worker)",
    "        if [ -f \"$TEST_STATE_DIR/stopped\" ] && [ ! -f \"$TEST_STATE_DIR/started\" ]; then exit 0; fi",
    "        ;;",
    "    esac",
    "    printf '%s-id\\n' \"$last\"",
    "    exit 0",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

function findLine(lines, predicate) {
  return lines.findIndex((line, index) => predicate(line, index));
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}
