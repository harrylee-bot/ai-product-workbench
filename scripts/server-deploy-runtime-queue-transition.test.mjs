import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const deployScript = resolve("deploy/server-deploy.sh");
const prepareRuntimeWorkerPrivateKeyScript = resolve(
  "scripts/prepare-runtime-worker-execution-private-key.mjs",
);
const sealedProductionReleaseScript = resolve("scripts/assert-sealed-production-release.mjs");
const currentContractCommit = "a".repeat(40);
const releaseOwnerUid = process.getuid?.() ?? 0;
const productionSystemPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
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
  assert.ok(
    result.lines[startIndex].includes("--scale workbench-worker=1"),
    "the full deployment must apply the Runtime Worker replica count",
  );
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

test("full deployment applies and waits for every signed Runtime Worker replica", () => {
  const result = runDeployment({ runtimeWorkerReplicas: 3 });

  assert.equal(result.status, 0, result.stderr);
  const start = result.lines.find((line) => (
    line.includes(" up -d --remove-orphans ") && !line.includes("--force-recreate")
  ));
  assert.ok(start?.includes("--scale workbench-worker=3"));
  for (const index of [1, 2, 3]) {
    assert.ok(
      result.lines.some((line) => line.includes(`inspect --format`) && line.includes(`workbench-worker-${index}-id`)),
      `replica ${index} must pass readiness inspection`,
    );
  }
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

test("pinned deployment rejects a partial service target", () => {
  const result = runDeployment({
    deployTarget: "api",
    ambientOverrides: { WORKBENCH_DEPLOY_IMAGE_MODE: "pinned" },
  });

  assert.equal(result.status, 64);
  assert.match(
    result.stderr,
    /pinned production deployment requires DEPLOY_TARGET=all, migrate, stop, or rollback/u,
  );
  assert.equal(result.lines.length, 0);
});

test("pinned deployment rejects an ambient release owner mismatch before mutation", () => {
  const result = runDeployment({
    deployTarget: "rollback",
    ambientOverrides: {
      WORKBENCH_RELEASE_OWNER_UID: String(releaseOwnerUid === 0 ? 1 : 0),
    },
  });

  assert.equal(result.status, 65);
  assert.match(result.stderr, /must match the signed deployment environment/u);
  assertNoDestructiveCommands(result, "owner mismatch");
});

test("pinned deployment rejects quoted current release owner UIDs before mutation", () => {
  for (const quote of ["'", '"']) {
    const result = runDeployment({
      currentOwnerValue: `${quote}${releaseOwnerUid}${quote}`,
      deployTarget: "rollback",
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /WORKBENCH_RELEASE_OWNER_UID must be a numeric UID/u);
    assertNoDestructiveCommands(result, `${quote}-quoted current owner`);
  }
});

test("rollback rejects quoted release owner UIDs before mutation", () => {
  for (const quote of ["'", '"']) {
    const result = runDeployment({
      deployTarget: "rollback",
      rollbackOwnerValue: `${quote}${releaseOwnerUid}${quote}`,
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /Rollback WORKBENCH_RELEASE_OWNER_UID must be a numeric UID/u);
    assertNoDestructiveCommands(result, `${quote}-quoted rollback owner`);
  }
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

test("rollback rejects an out-of-tree Compose file before stopping the active stack", () => {
  const result = runDeployment({ deployTarget: "rollback", rollbackComposeOutsideCandidate: true });

  assert.equal(result.status, 65);
  assert.match(result.stderr, /must be the source-verified candidate file/u);
  assert.equal(findLine(result.lines, (line) => line.includes(" stop --timeout ")), -1);
  assert.equal(findLine(result.lines, (line) => line.includes(" run --rm --no-deps migrate")), -1);
});

test("rollback rejects an out-of-tree DeerFlow Compose file before stopping the active stack", () => {
  const result = runDeployment({ deployTarget: "rollback", deerflowComposeOutsideCandidate: true });

  assert.equal(result.status, 65);
  assert.match(result.stderr, /DeerFlow Compose file must be the source-verified candidate file/u);
  assert.equal(findLine(result.lines, (line) => line.includes(" stop --timeout ")), -1);
});

test("pinned deployment rejects disabling the signed DeerFlow runtime", () => {
  const result = runDeployment({ deployTarget: "rollback", manageDeerflowRuntime: false });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /requires WORKBENCH_MANAGE_DEERFLOW_RUNTIME=1/u);
  assert.equal(findLine(result.lines, (line) => line.includes(" stop --timeout ")), -1);
});

test("pinned Compose commands ignore ambient image and endpoint overrides", () => {
  const result = runDeployment({
    deployTarget: "rollback",
    ambientOverrides: {
      WORKBENCH_RUNTIME_WORKER_IMAGE_REF: "attacker.example.test/runtime:latest",
      WORKBENCH_DEERFLOW_GATEWAY_URL: "https://attacker.example.test",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const composeCommands = result.lines.filter((line) => (
    line.includes(" docker compose ") && line.includes(" --env-file ")
  ));
  assert.ok(composeCommands.length > 0);
  for (const command of composeCommands) {
    assert.match(command, /image=unset endpoint=unset/u);
  }
});

test("pinned deployment ignores hostile ambient command and Bash startup paths", () => {
  const result = runDeployment({ deployTarget: "rollback", hostileAmbientPath: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.hostileCommandLog, "");
  assert.ok(result.lines.some((line) => line.startsWith("deployment-config-verifier ")));
  assert.ok(result.lines.some((line) => line.includes(" down --remove-orphans")));
});

test("pinned deployment rejects an interpreter invocation that bypasses the privileged shebang", () => {
  const result = runDeployment({ deployTarget: "rollback", invokeThroughBash: true });

  assert.equal(result.status, 64);
  assert.match(
    result.stderr,
    /must execute deploy\/server-deploy\.sh directly so \/bin\/bash -p is enforced/u,
  );
  assertNoDestructiveCommands(result, "non-privileged Bash invocation");
});

test("current-contract rollback recursively verifies the inventory and both production preflights", () => {
  const rollbackOwnerUid = releaseOwnerUid === 0 ? 1 : 0;
  const result = runDeployment({
    deployTarget: "rollback",
    manageDeerflowRuntime: true,
    rollbackOwnerUid,
    rollbackSourceCommit: currentContractCommit,
  });

  assert.equal(result.status, 0, result.stderr);
  const inventoryIndexes = result.lines
    .map((line, index) => line.startsWith("inventory-verifier ") ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(inventoryIndexes.length, 2, result.commandLog);
  for (const index of inventoryIndexes) {
    assert.match(result.lines[index], new RegExp(`--expected-commit ${currentContractCommit}`, "u"));
    assert.ok(result.lines[index].includes(`--env-file ${result.rollbackEnv}`));
  }

  const mainPreflightIndex = findLine(result.lines, (line) => line === "main-preflight");
  const deerflowPreflightIndex = findLine(result.lines, (line) => line === "deerflow-preflight");
  const deploymentConfigIndexes = result.lines
    .map((line, index) => line.startsWith("deployment-config-verifier ") ? index : -1)
    .filter((index) => index >= 0);
  const stopIndex = findLine(result.lines, (line) => line.includes(" stop --timeout "));
  const privateKeyPrepareIndex = findLine(
    result.lines,
    (line) => line.startsWith("runtime-key-prepare "),
  );
  const currentSealIndex = findLine(result.lines, (line) => (
    line.startsWith("sealed-release-verifier ")
      && line.includes(`--env-file ${result.envFile}`)
  ));
  const rollbackSealIndex = findLine(result.lines, (line) => (
    line.startsWith("sealed-release-verifier ")
      && line.includes(`--env-file ${result.rollbackEnv}`)
  ));
  assert.equal(deploymentConfigIndexes.length, 3, result.commandLog);
  assert.ok(currentSealIndex >= 0, "the active candidate must be checked as a sealed release");
  assert.ok(rollbackSealIndex >= 0, "the rollback candidate must be checked as a sealed release");
  assert.ok(
    currentSealIndex < stopIndex && rollbackSealIndex < stopIndex,
    "both candidates must be sealed before the active queue is stopped",
  );
  assert.ok(result.lines[rollbackSealIndex].includes(`--owner-uid ${rollbackOwnerUid}`));
  assert.ok(
    deploymentConfigIndexes[0] < deploymentConfigIndexes[1]
      && deploymentConfigIndexes[1] < stopIndex,
    "the rollback candidate must be source-verified before the active queue is stopped",
  );
  assert.ok(result.lines[deploymentConfigIndexes[1]].includes(`--env-file ${result.rollbackEnv}`));
  assert.ok(
    privateKeyPrepareIndex > deploymentConfigIndexes[2],
    "the signed deployment configuration must be verified before private-key metadata is mutated",
  );
  assert.ok(inventoryIndexes[1] > inventoryIndexes[0], "recursive deployment must re-run inventory verification");
  assert.ok(mainPreflightIndex > inventoryIndexes[1], "main preflight must run after recursive inventory verification");
  assert.ok(deerflowPreflightIndex > mainPreflightIndex, "DeerFlow preflight must run after the main preflight");
  assert.equal(result.lines.filter((line) => line === "main-preflight").length, 1);
  assert.equal(result.lines.filter((line) => line === "deerflow-preflight").length, 1);
});

function runDeployment({
  ambientOverrides = {},
  currentOwnerValue,
  deerflowComposeOutsideCandidate = false,
  deployTarget = "all",
  envFileAuthorization = "0",
  failMigration = false,
  hostileAmbientPath = false,
  invokeThroughBash = false,
  manageDeerflowRuntime,
  processAuthorization,
  rollbackComposeOutsideCandidate = false,
  rollbackOwnerUid = releaseOwnerUid,
  rollbackOwnerValue,
  rollbackSourceCommit = "a".repeat(40),
  runtimeWorkerReplicas,
} = {}) {
  const manageDeerflow = manageDeerflowRuntime ?? deployTarget === "rollback";
  const appDir = mkdtempSync(join(tmpdir(), "workbench-server-deploy-queue-"));
  const deployDir = join(appDir, "deploy");
  const fakeBinDir = join(appDir, "test-bin");
  const hostileBinDir = join(appDir, "hostile-bin");
  const stateDir = join(appDir, "state");
  const commandLogPath = join(appDir, "commands.log");
  const hostileCommandLogPath = join(appDir, "hostile-commands.log");
  const envFile = join(deployDir, "workbench.env");
  const rollbackEnv = join(deployDir, "rollback.env");
  const composeFile = join(deployDir, "workbench-compose.yml");
  const rollbackCompose = rollbackComposeOutsideCandidate
    ? join(deployDir, "unsigned-rollback-compose.yml")
    : composeFile;
  const composeOverlay = join(deployDir, "workbench-validation-overlay.yml");
  const preflight = join(deployDir, "workbench-production-preflight.sh");
  const deerflowCompose = deerflowComposeOutsideCandidate
    ? join(deployDir, "unsigned-deerflow-runtime-compose.yml")
    : join(deployDir, "deerflow-runtime-compose.yml");
  const candidateDeerflowCompose = join(deployDir, "deerflow-runtime-compose.yml");
  const deerflowPreflight = join(deployDir, "deerflow-production-preflight.sh");
  const deerflowBaseConfig = join(deployDir, "deerflow-base.yaml");
  const deerflowEffectiveConfig = join(stateDir, "deerflow-config.yaml");
  const deerflowHome = join(stateDir, "deerflow-home");
  const inventory = join(deployDir, "production-image-manifest.json");
  const inventoryBundle = join(deployDir, "production-image-manifest.bundle.json");
  const runtimeWorkerPrivateKey = join(stateDir, "runtime-worker-execution-private-key.pem");

  mkdirSync(deployDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(hostileBinDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(appDir, "scripts"), { recursive: true });
  writeFileSync(commandLogPath, "");
  writeFileSync(hostileCommandLogPath, "");
  writeFileSync(envFile, [
    `WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=${envFileAuthorization}`,
    `WORKBENCH_RELEASE_OWNER_UID=${currentOwnerValue ?? releaseOwnerUid}`,
    ...(runtimeWorkerReplicas === undefined
      ? []
      : [`WORKBENCH_RUNTIME_WORKER_REPLICAS=${runtimeWorkerReplicas}`]),
    "",
  ].join("\n"));
  writeFileSync(composeFile, "name: workbench\nservices: {}\n");
  if (rollbackComposeOutsideCandidate) {
    writeFileSync(rollbackCompose, "name: unsigned-rollback\nservices: {}\n");
  }
  const candidateDeployScript = join(deployDir, "server-deploy.sh");
  writeExecutable(candidateDeployScript, deployScriptSourceForTest(fakeBinDir));
  writeFileSync(join(appDir, "scripts", "assert-production-deployment-config.mjs"), "// test fixture\n");
  writeFileSync(
    join(appDir, "scripts", "assert-sealed-production-release.mjs"),
    readFileSync(sealedProductionReleaseScript, "utf8"),
  );
  writeFileSync(
    join(appDir, "scripts", "prepare-runtime-worker-execution-private-key.mjs"),
    readFileSync(prepareRuntimeWorkerPrivateKeyScript, "utf8"),
  );
  writeFileSync(composeOverlay, "services: {}\n");
  writeFileSync(candidateDeerflowCompose, "name: workbench-runtime\nservices: {}\n");
  if (deerflowComposeOutsideCandidate) {
    writeFileSync(deerflowCompose, "name: unsigned-runtime\nservices: {}\n");
  }
  writeFileSync(deerflowBaseConfig, "models: []\n");
  writeFileSync(deerflowEffectiveConfig, "models: []\n");
  const deerflowConfigSha256 = createHash("sha256").update("models: []\n").digest("hex");
  writeFileSync(inventory, "{}\n");
  writeFileSync(inventoryBundle, "{}\n");
  writeFileSync(runtimeWorkerPrivateKey, "test-runtime-worker-private-key\n", { mode: 0o600 });
  writeFileSync(rollbackEnv, [
    "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=0",
    `WORKBENCH_RELEASE_OWNER_UID=${rollbackOwnerValue ?? rollbackOwnerUid}`,
    `WORKBENCH_SOURCE_COMMIT=${rollbackSourceCommit}`,
    `WORKBENCH_IMAGE_INVENTORY_PATH=${inventory}`,
    `WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH=${inventoryBundle}`,
    "WORKBENCH_COSIGN_CERTIFICATE_IDENTITY=https://example.test/workbench.yml@refs/heads/main",
    "WORKBENCH_COSIGN_OIDC_ISSUER=https://token.actions.githubusercontent.com",
    `WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_HOST_PATH=${runtimeWorkerPrivateKey}`,
    `WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID=sha256:${"e".repeat(64)}`,
    "WORKBENCH_RUNTIME_WORKER_UID=1000",
    "WORKBENCH_RUNTIME_WORKER_GID=1000",
    "WORKBENCH_RUNTIME_WORKER_REPLICAS=1",
    ...(manageDeerflow ? [
      `WORKBENCH_DEERFLOW_BASE_CONFIG_PATH=${deerflowBaseConfig}`,
      `WORKBENCH_DEERFLOW_BASE_CONFIG_SHA256=${deerflowConfigSha256}`,
      `DEER_FLOW_CONFIG_PATH=${deerflowEffectiveConfig}`,
      `WORKBENCH_DEERFLOW_EFFECTIVE_CONFIG_SHA256=${deerflowConfigSha256}`,
      `DEER_FLOW_HOME=${deerflowHome}`,
      `WORKBENCH_DEERFLOW_IMAGE_REF=registry.example.test/workbench/deerflow@sha256:${"d".repeat(64)}`,
      "WORKBENCH_INTERNAL_NETWORK_NAME=workbench_internal",
      "WORKBENCH_DEERFLOW_HOST_PORT=2026",
    ] : []),
    "",
  ].join("\n"));
  writeExecutable(preflight, `#!/bin/sh\nprintf 'main-preflight\\n' >> ${shellQuote(commandLogPath)}\n`);
  writeExecutable(deerflowPreflight, `#!/bin/sh\nprintf 'deerflow-preflight\\n' >> ${shellQuote(commandLogPath)}\n`);
  writeExecutable(join(fakeBinDir, "node"), fakeNodeSource(commandLogPath));
  writeExecutable(join(fakeBinDir, "cosign"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "chown"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "chmod"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "docker"), fakeDockerSource({
    commandLogPath,
    failMigration,
    runtimeWorkerReplicas: runtimeWorkerReplicas ?? 1,
    stateDir,
  }));
  for (const command of ["node", "cosign", "docker", "grep", "sed", "sha256sum"]) {
    writeExecutable(join(hostileBinDir, command), [
      "#!/bin/sh",
      `printf '%s\\n' ${shellQuote(command)} >> ${shellQuote(hostileCommandLogPath)}`,
      "exit 97",
      "",
    ].join("\n"));
  }
  const bashEnvironment = join(hostileBinDir, "bash-env.sh");
  writeFileSync(bashEnvironment, `printf 'BASH_ENV\\n' >> ${shellQuote(hostileCommandLogPath)}\n`);

  const env = {
    ...process.env,
    APP_DIR: appDir,
    PATH: hostileAmbientPath
      ? `${hostileBinDir}:${process.env.PATH}`
      : `${fakeBinDir}:${process.env.PATH}`,
    WORKBENCH_ENV_FILE: envFile,
    WORKBENCH_COMPOSE_FILE: composeFile,
    WORKBENCH_COMPOSE_OVERLAY: deployTarget === "rollback" ? "" : composeOverlay,
    WORKBENCH_PREFLIGHT_SCRIPT: preflight,
    WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PREPARE_SCRIPT:
      join(appDir, "scripts", "prepare-runtime-worker-execution-private-key.mjs"),
    WORKBENCH_DEERFLOW_COMPOSE_FILE: deerflowCompose,
    WORKBENCH_DEERFLOW_PREFLIGHT_SCRIPT: deerflowPreflight,
    WORKBENCH_DEPLOY_IMAGE_MODE: deployTarget === "rollback" ? "pinned" : "build",
    WORKBENCH_MANAGE_DEERFLOW_RUNTIME: manageDeerflow ? "1" : "0",
    WORKBENCH_DEPLOY_LOCK_FILE: join(appDir, "deploy.lock"),
    WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS: "5",
    WORKBENCH_RUNTIME_QUEUE_STOP_TIMEOUT_SECONDS: "5",
    WORKBENCH_ROLLBACK_ENV_FILE: rollbackEnv,
    WORKBENCH_ROLLBACK_COMPOSE_FILE: rollbackCompose,
    WORKBENCH_ROLLBACK_APP_DIR: appDir,
    DEPLOY_TARGET: deployTarget,
    TEST_COMMAND_LOG: commandLogPath,
    TEST_FAIL_MIGRATION: failMigration ? "1" : "0",
    TEST_ROLLBACK_ENV: rollbackEnv,
    TEST_RUNTIME_WORKER_REPLICAS: String(runtimeWorkerReplicas ?? 1),
    TEST_STATE_DIR: stateDir,
    ...(hostileAmbientPath ? { BASH_ENV: bashEnvironment } : {}),
    ...ambientOverrides,
  };
  if (processAuthorization === undefined) {
    delete env.WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE;
  } else {
    env.WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE = processAuthorization;
  }
  if (!hostileAmbientPath) {
    delete env.BASH_ENV;
  }

  let result;
  try {
    result = invokeThroughBash
      ? spawnSync("/bin/bash", [candidateDeployScript], { encoding: "utf8", env })
      : spawnSync(candidateDeployScript, [], { encoding: "utf8", env });
    const commandLog = readFileSync(commandLogPath, "utf8");
    return {
      ...result,
      commandLog,
      envFile,
      lines: commandLog.trim().split("\n").filter(Boolean),
      rollbackEnv,
      hostileCommandLog: readFileSync(hostileCommandLogPath, "utf8"),
    };
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}

function deployScriptSourceForTest(fakeBinDir) {
  const source = readFileSync(deployScript, "utf8");
  const productionAssignment = `readonly WORKBENCH_TRUSTED_SYSTEM_PATH="${productionSystemPath}"`;
  assert(source.includes(productionAssignment), "server deploy must define one fixed production system PATH");
  return source.replace(
    productionAssignment,
    `readonly WORKBENCH_TRUSTED_SYSTEM_PATH="${fakeBinDir}:${productionSystemPath}"`,
  );
}

function fakeNodeSource(commandLogPath) {
  return [
    "#!/bin/sh",
    `COMMAND_LOG=${shellQuote(commandLogPath)}`,
    "case \"$1\" in",
    "  */scripts/assert-sealed-production-release.mjs)",
    "    printf 'sealed-release-verifier %s\\n' \"$*\" >> \"$COMMAND_LOG\"",
    "    ;;",
    "  */scripts/assert-production-deployment-config.mjs)",
    "    printf 'deployment-config-verifier %s\\n' \"$*\" >> \"$COMMAND_LOG\"",
    "    ;;",
    "  */scripts/prepare-runtime-worker-execution-private-key.mjs)",
    "    printf 'runtime-key-prepare %s\\n' \"$*\" >> \"$COMMAND_LOG\"",
    "    ;;",
    "  */scripts/production-image-inventory.mjs)",
    "    printf 'inventory-verifier %s\\n' \"$*\" >> \"$COMMAND_LOG\"",
    "    ;;",
    "  */scripts/merge-deerflow-config.mjs)",
    "    printf 'deerflow-config-merge %s\\n' \"$*\" >> \"$COMMAND_LOG\"",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

function fakeDockerSource({ commandLogPath, failMigration, runtimeWorkerReplicas, stateDir }) {
  return [
    "#!/bin/sh",
    `COMMAND_LOG=${shellQuote(commandLogPath)}`,
    `STATE_DIR=${shellQuote(stateDir)}`,
    `FAIL_MIGRATION=${failMigration ? "1" : "0"}`,
    `RUNTIME_WORKER_REPLICAS=${runtimeWorkerReplicas}`,
    "printf 'allow=%s image=%s endpoint=%s docker %s\\n' \"${WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE:-unset}\" \"${WORKBENCH_RUNTIME_WORKER_IMAGE_REF:-unset}\" \"${WORKBENCH_DEERFLOW_GATEWAY_URL:-unset}\" \"$*\" >> \"$COMMAND_LOG\"",
    "if [ \"$1\" != compose ]; then",
    "  if [ \"$1 $2\" = 'inspect --format' ]; then printf 'healthy\\n'; fi",
    "  exit 0",
    "fi",
    "last=",
    "for arg in \"$@\"; do last=$arg; done",
    "case \" $* \" in",
    "  *' stop --timeout '*)",
    "    : > \"$STATE_DIR/stopped\"",
    "    rm -f \"$STATE_DIR/started\"",
    "    exit 0",
    "    ;;",
    "  *' run --rm --no-deps migrate '*)",
    "    if [ \"$FAIL_MIGRATION\" = 1 ]; then exit 42; fi",
    "    : > \"$STATE_DIR/migrated\"",
    "    exit 0",
    "    ;;",
    "  *' down --remove-orphans '*)",
    "    : > \"$STATE_DIR/stopped\"",
    "    rm -f \"$STATE_DIR/started\"",
    "    exit 0",
    "    ;;",
    "  *' up -d postgres '*)",
    "    : > \"$STATE_DIR/postgres\"",
    "    exit 0",
    "    ;;",
    "  *' up '*)",
    "    : > \"$STATE_DIR/started\"",
    "    rm -f \"$STATE_DIR/stopped\"",
    "    exit 0",
    "    ;;",
    "  *' ps -q '*)",
    "    if [ \"$last\" = -q ]; then printf 'existing-id\\n'; exit 0; fi",
    "    if [ \"$last\" = postgres ]; then printf 'postgres-id\\n'; exit 0; fi",
    "    case \"$last\" in",
    "      workbench-api|workbench-worker|workbench-file-worker|workbench-import-worker|workbench-export-worker)",
    "        if [ -f \"$STATE_DIR/stopped\" ] && [ ! -f \"$STATE_DIR/started\" ]; then exit 0; fi",
    "        ;;",
    "    esac",
    "    if [ \"$last\" = workbench-worker ]; then",
    "      index=1",
    "      while [ \"$index\" -le \"$RUNTIME_WORKER_REPLICAS\" ]; do",
    "        printf 'workbench-worker-%s-id\\n' \"$index\"",
    "        index=$((index + 1))",
    "      done",
    "      exit 0",
    "    fi",
    "    printf '%s-id\\n' \"$last\"",
    "    exit 0",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function findLine(lines, predicate) {
  return lines.findIndex((line, index) => predicate(line, index));
}

function assertNoDestructiveCommands(result, label) {
  assert.equal(
    findLine(result.lines, (line) => (
      line.includes(" stop --timeout ")
      || line.includes(" down --remove-orphans")
      || line.includes(" run --rm --no-deps migrate")
    )),
    -1,
    `${label} must fail before stop, down, or migration`,
  );
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}
