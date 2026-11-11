import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const deployScript = resolve("deploy/server-deploy.sh");
const queueParticipants = [
  "workbench-api",
  "workbench-worker",
  "workbench-file-worker",
  "workbench-import-worker",
  "workbench-export-worker",
];

test("direct build finishes before queue cutover and never removes unrelated Compose services", () => {
  const result = runDeployment({ processAuthorization: "1" });
  assert.equal(result.status, 0, result.stderr);
  const buildIndex = result.lines.findIndex((line) => line === "direct-build all");
  const stopIndex = result.lines.findIndex((line) => line.includes(" stop --timeout "));
  assert.ok(buildIndex >= 0 && buildIndex < stopIndex, result.commandLog);
  assert.ok(result.lines.indexOf("main-preflight") < buildIndex, result.commandLog);
  assert.doesNotMatch(result.commandLog, /--remove-orphans/u);
  assert.doesNotMatch(result.commandLog, / up .*--build/u);
});

test("a failed direct build leaves the running stack untouched", () => {
  const result = runDeployment({ failBuild: true });
  assert.equal(result.status, 43, result.stderr);
  assert.match(result.commandLog, /direct-build all/u);
  assert.doesNotMatch(result.commandLog, / (?:stop|up|run|down) /u);
});

test("stop does not initialize a direct builder", () => {
  const result = runDeployment({ deployTarget: "stop" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commandLog, / down\n/u);
  assert.doesNotMatch(result.commandLog, /direct-build|--build\b/u);
  assert.doesNotMatch(result.commandLog, /--remove-orphans/u);
});

for (const deployTarget of ["all", "runtime-worker", "deerflow-runtime"]) {
  test(`${deployTarget} resolves DeerFlow before deployment side effects`, () => {
    const result = runDeployment({ deployTarget, manageDeerflowRuntime: true, deerflowImagePresent: false });
    assert.equal(result.status, 0, result.stderr);
    const pullIndex = result.lines.findIndex((line) => line.includes("docker pull "));
    const mutationIndex = result.lines.findIndex((line) => / (?:stop|up|run|down) /u.test(line));
    assert.ok(pullIndex >= 0 && pullIndex < mutationIndex, result.commandLog);
    assert.equal(result.lines.filter((line) => line.includes("docker pull ")).length, 1);
    assert.ok(pullIndex < result.lines.findIndex((line) => line.startsWith("deerflow-config-merge ")));
  });
}

test("full deployment stops every queue participant before the authorized migrator", () => {
  const result = runDeployment({ processAuthorization: "1" });
  assert.equal(result.status, 0, result.stderr);
  const stopIndex = result.lines.findIndex((line) => line.includes(" stop --timeout "));
  const migrateIndex = result.lines.findIndex((line) => line.includes(" run --rm --no-deps migrate"));
  const startIndex = result.lines.findIndex((line) => / up -d --no-build(?: |$)/u.test(line) && !line.includes(" postgres") && !line.includes("--force-recreate"));
  assert.ok(stopIndex >= 0);
  for (const service of queueParticipants) assert(result.lines[stopIndex].includes(service), service);
  assert.ok(migrateIndex > stopIndex);
  assert.match(result.lines[migrateIndex], /^allow=1 /u);
  assert.ok(startIndex > migrateIndex);
});

test("failed queue reconciliation leaves producers and consumers stopped", () => {
  const result = runDeployment({ failMigration: true, processAuthorization: "1" });
  assert.equal(result.status, 42);
  const migrateIndex = result.lines.findIndex((line) => line.includes(" run --rm --no-deps migrate"));
  assert.ok(migrateIndex >= 0);
  assert.equal(
    result.lines.findIndex((line, index) => index > migrateIndex && / up -d --no-build(?: |$)/u.test(line) && !line.includes(" postgres") && !line.includes("--force-recreate")),
    -1,
  );
  assert.match(result.stderr, /queue producers and consumers remain stopped/u);
});

test("an env-file value cannot persist queue policy recreate authorization", () => {
  const result = runDeployment({ envFileAuthorization: "1" });
  assert.equal(result.status, 0, result.stderr);
  const migrateLine = result.lines.find((line) => line.includes(" run --rm --no-deps migrate"));
  assert.match(migrateLine, /^allow=0 /u);
});

test("partial deployment rejects queue policy recreate authorization", () => {
  const result = runDeployment({ deployTarget: "api", processAuthorization: "1" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /requires DEPLOY_TARGET=all or migrate/u);
  assert.equal(result.lines.findIndex((line) => line.includes(" stop --timeout ")), -1);
});

for (const [deployTarget, services] of [
  ["api", "workbench-api"],
  ["web", "workbench-web knowledge"],
  ["runtime-worker", "workbench-worker"],
  ["file-worker", "workbench-file-worker"],
  ["import-worker", "workbench-import-worker"],
  ["export-worker", "workbench-export-worker"],
  ["preview", "workbench-preview preview-gateway"],
  ["knowledge", "knowledge"],
  ["migrate", "migrate"],
]) {
  test(`${deployTarget} builds its target before deployment side effects`, () => {
    const result = runDeployment({ deployTarget });
    assert.equal(result.status, 0, result.stderr);
    const buildIndex = result.lines.indexOf(`direct-build ${services}`);
    const mutationIndex = result.lines.findIndex((line) => / (?:stop|up|run|down) /u.test(line));
    assert.ok(buildIndex >= 0 && buildIndex < mutationIndex, result.commandLog);
  });
}

function runDeployment({
  deployTarget = "all",
  envFileAuthorization = "0",
  failBuild = false,
  failMigration = false,
  manageDeerflowRuntime = false,
  deerflowImagePresent = true,
  failDeerflowPull = false,
  processAuthorization,
} = {}) {
  const appDir = mkdtempSync(join(tmpdir(), "workbench-server-deploy-queue-"));
  const deployDir = join(appDir, "deploy");
  const fakeBinDir = join(appDir, "test-bin");
  const stateDir = join(appDir, "state");
  const commandLogPath = join(appDir, "commands.log");
  const envFile = join(deployDir, "workbench.env");
  const composeFile = join(deployDir, "workbench-compose.yml");
  const preflight = join(deployDir, "workbench-production-preflight.sh");
  const deerflowCompose = join(deployDir, "deerflow-runtime-compose.yml");
  const deerflowPreflight = join(deployDir, "deerflow-preflight.sh");
  const deerflowBaseConfig = join(deployDir, "deerflow-base.yaml");
  const deerflowEffectiveConfig = join(stateDir, "deerflow-config.yaml");
  const testDeployScript = join(deployDir, "server-deploy.sh");

  mkdirSync(deployDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(commandLogPath, "");
  writeFileSync(envFile, [
    `WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=${envFileAuthorization}`,
    `WORKBENCH_SOURCE_COMMIT=${"b".repeat(40)}`,
    "WORKBENCH_RUNTIME_WORKER_IMAGE_REF=workbench-runtime-worker:test",
    ...manageDeerflowRuntime ? [
      `WORKBENCH_DEERFLOW_BASE_CONFIG_PATH=${deerflowBaseConfig}`,
      `DEER_FLOW_CONFIG_PATH=${deerflowEffectiveConfig}`,
      `DEER_FLOW_HOME=${join(stateDir, "deerflow-home")}`,
      `WORKBENCH_DEERFLOW_IMAGE_REF=registry.example.test/workbench/deerflow@sha256:${"d".repeat(64)}`,
      "WORKBENCH_INTERNAL_NETWORK_NAME=workbench_internal",
      "WORKBENCH_DEERFLOW_HOST_PORT=2026",
    ] : [],
    "",
  ].join("\n"));
  writeFileSync(composeFile, "name: workbench\nservices: {}\n");
  writeFileSync(deerflowCompose, "name: workbench-runtime\nservices: {}\n");
  writeFileSync(deerflowBaseConfig, "models: []\n");
  writeExecutable(preflight, "#!/bin/sh\nprintf 'main-preflight\\n' >> \"$TEST_COMMAND_LOG\"\n");
  writeExecutable(testDeployScript, readFileSync(deployScript, "utf8"));
  writeFileSync(join(deployDir, "workbench-build-resources.sh"), [
    "direct_build_images() {",
    "  printf 'direct-build %s\\n' \"${*:-all}\" >> \"$TEST_COMMAND_LOG\"",
    "  if [ \"$TEST_FAIL_BUILD\" = 1 ]; then return 43; fi",
    "}",
    "",
  ].join("\n"));
  writeExecutable(deerflowPreflight, "#!/bin/sh\nprintf 'deerflow-preflight\\n' >> \"$TEST_COMMAND_LOG\"\n");
  writeExecutable(join(fakeBinDir, "node"), fakeNodeSource());
  writeExecutable(join(fakeBinDir, "chown"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "chmod"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "docker"), fakeDockerSource());

  const env = {
    ...process.env,
    APP_DIR: appDir,
    PATH: `${fakeBinDir}:${process.env.PATH}`,
    WORKBENCH_ENV_FILE: envFile,
    WORKBENCH_COMPOSE_FILE: composeFile,
    WORKBENCH_DEERFLOW_COMPOSE_FILE: deerflowCompose,
    WORKBENCH_DEERFLOW_PREFLIGHT_SCRIPT: deerflowPreflight,
    WORKBENCH_MANAGE_DEERFLOW_RUNTIME: manageDeerflowRuntime ? "1" : "0",
    WORKBENCH_DEPLOY_LOCK_FILE: join(appDir, "deploy.lock"),
    WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS: "5",
    WORKBENCH_RUNTIME_QUEUE_STOP_TIMEOUT_SECONDS: "5",
    DEPLOY_TARGET: deployTarget,
    TEST_COMMAND_LOG: commandLogPath,
    TEST_STATE_DIR: stateDir,
    TEST_FAIL_BUILD: failBuild ? "1" : "0",
    TEST_FAIL_MIGRATION: failMigration ? "1" : "0",
    TEST_DEERFLOW_IMAGE_PRESENT: deerflowImagePresent ? "1" : "0",
    TEST_FAIL_DEERFLOW_PULL: failDeerflowPull ? "1" : "0",
  };
  if (processAuthorization === undefined) delete env.WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE;
  else env.WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE = processAuthorization;

  try {
    const result = spawnSync("bash", [testDeployScript], { encoding: "utf8", env });
    const commandLog = readFileSync(commandLogPath, "utf8");
    return { ...result, commandLog, lines: commandLog.trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}

function fakeNodeSource() {
  return [
    "#!/bin/sh",
    "case \"$1\" in",
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
    "  if [ \"$1 $2\" = 'image inspect' ] && [ \"$TEST_DEERFLOW_IMAGE_PRESENT\" != 1 ] && [ ! -f \"$TEST_STATE_DIR/deerflow-image\" ] && [ \"$3\" != '--format' ]; then exit 1; fi",
    "  if [ \"$1\" = pull ]; then",
    "    if [ \"$TEST_FAIL_DEERFLOW_PULL\" = 1 ]; then exit 44; fi",
    "    : > \"$TEST_STATE_DIR/deerflow-image\"",
    "  fi",
    "  if [ \"$1 $2\" = 'image inspect' ] && [ \"$3\" = '--format' ]; then printf 'registry.example.test/workbench-runtime@sha256:%064d\\n' 1; fi",
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
    "  *' down '*)",
    "    : > \"$TEST_STATE_DIR/stopped\"",
    "    rm -f \"$TEST_STATE_DIR/started\"",
    "    exit 0",
    "    ;;",
    "  *' up -d --no-build postgres '*)",
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

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}
