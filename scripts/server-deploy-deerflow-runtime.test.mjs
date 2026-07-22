import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const deployScript = resolve("deploy/server-deploy.sh");

test("DeerFlow deployment transfers private runtime paths to UID/GID 65532", () => {
  const result = runDeployment();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.permissionCommands, [
    `chown -R 65532:65532 ${result.runtimeHome}`,
    `chmod 0700 ${result.runtimeHome}`,
    `chown 65532:65532 ${result.effectiveConfig}`,
    `chmod 0600 ${result.effectiveConfig}`,
  ]);
  assert.ok(
    result.commandLog.indexOf(`chmod 0600 ${result.effectiveConfig}`) < result.commandLog.indexOf("deerflow-preflight"),
    "ownership and mode transfer must finish before DeerFlow preflight",
  );
});

test("DeerFlow deployment fails closed when ownership transfer fails", () => {
  const result = runDeployment({ failChownTarget: "config.effective.yaml" });

  assert.equal(result.status, 23);
  assert.match(result.commandLog, /chown 65532:65532 .*config\.effective\.yaml/u);
  assert.doesNotMatch(result.commandLog, /deerflow-preflight/u);
});

function runDeployment({ failChownTarget = "" } = {}) {
  const appDir = mkdtempSync(join(tmpdir(), "workbench-server-deploy-deerflow-"));
  const deployDir = join(appDir, "deploy");
  const configDir = join(appDir, "etc/workbench/deerflow");
  const runtimeDir = join(appDir, "var/lib/workbench/deerflow");
  const runtimeHome = join(runtimeDir, "home");
  const effectiveConfig = join(runtimeDir, "config.effective.yaml");
  const fakeBinDir = join(appDir, "test-bin");
  const commandLogPath = join(appDir, "commands.log");
  const envFile = join(deployDir, "workbench.env");
  const composeFile = join(deployDir, "workbench-compose.yml");
  const composeOverlay = join(deployDir, "workbench-validation-overlay.yml");
  const deerflowComposeFile = join(deployDir, "deerflow-runtime-compose.yml");
  const workbenchPreflight = join(deployDir, "workbench-preflight.sh");
  const deerflowPreflight = join(deployDir, "deerflow-preflight.sh");

  mkdirSync(deployDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(runtimeHome, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(join(configDir, "config.base.yaml"), "models: []\n");
  writeFileSync(effectiveConfig, "models: []\n");
  writeFileSync(composeFile, "services: {}\n");
  writeFileSync(composeOverlay, "services: {}\n");
  writeFileSync(deerflowComposeFile, "services: {}\n");
  writeFileSync(commandLogPath, "");
  writeFileSync(envFile, [
    `WORKBENCH_DEERFLOW_BASE_CONFIG_PATH=${join(configDir, "config.base.yaml")}`,
    `DEER_FLOW_CONFIG_PATH=${effectiveConfig}`,
    `DEER_FLOW_HOME=${runtimeHome}`,
    `WORKBENCH_DEERFLOW_IMAGE_REF=registry.example.test/workbench/deerflow@sha256:${"c".repeat(64)}`,
    "WORKBENCH_INTERNAL_NETWORK_NAME=workbench_internal",
    "WORKBENCH_DEERFLOW_HOST_PORT=2026",
    "",
  ].join("\n"));

  writeExecutable(workbenchPreflight, "#!/bin/sh\nprintf 'workbench-preflight\\n' >> \"$TEST_COMMAND_LOG\"\n");
  writeExecutable(deerflowPreflight, "#!/bin/sh\nprintf 'deerflow-preflight\\n' >> \"$TEST_COMMAND_LOG\"\n");
  writeExecutable(join(fakeBinDir, "node"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(fakeBinDir, "docker"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"compose\" ]; then",
    "  case \" $* \" in",
    "    *' ps -q postgres '*) printf 'postgres-id\\n' ;;",
    "    *' ps -q deerflow '*) printf 'deerflow-id\\n' ;;",
    "  esac",
    "  exit 0",
    "fi",
    "case \"$1 $2\" in",
    "  'inspect --format') printf 'healthy\\n' ;;",
    "  'ps --filter') exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  writeExecutable(join(fakeBinDir, "chown"), [
    "#!/bin/sh",
    "printf 'chown %s\\n' \"$*\" >> \"$TEST_COMMAND_LOG\"",
    "case \"$*\" in",
    "  *\"$TEST_FAIL_CHOWN_TARGET\"*) [ -z \"$TEST_FAIL_CHOWN_TARGET\" ] || exit 23 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  writeExecutable(join(fakeBinDir, "chmod"), [
    "#!/bin/sh",
    "printf 'chmod %s\\n' \"$*\" >> \"$TEST_COMMAND_LOG\"",
    "exec /bin/chmod \"$@\"",
    "",
  ].join("\n"));

  let result;
  try {
    result = spawnSync("bash", [deployScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        APP_DIR: appDir,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        WORKBENCH_ENV_FILE: envFile,
        WORKBENCH_COMPOSE_FILE: composeFile,
        WORKBENCH_COMPOSE_OVERLAY: composeOverlay,
        WORKBENCH_DEERFLOW_COMPOSE_FILE: deerflowComposeFile,
        WORKBENCH_PREFLIGHT_SCRIPT: workbenchPreflight,
        WORKBENCH_DEERFLOW_PREFLIGHT_SCRIPT: deerflowPreflight,
        WORKBENCH_DEPLOY_IMAGE_MODE: "build",
        WORKBENCH_MANAGE_DEERFLOW_RUNTIME: "1",
        WORKBENCH_DEPLOY_LOCK_FILE: join(appDir, "deploy.lock"),
        WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS: "5",
        DEPLOY_TARGET: "deerflow-runtime",
        TEST_COMMAND_LOG: commandLogPath,
        TEST_FAIL_CHOWN_TARGET: failChownTarget,
      },
    });
    const commandLog = readFileSync(commandLogPath, "utf8");
    return {
      ...result,
      commandLog,
      permissionCommands: commandLog.split("\n").filter((line) => /^(?:chown|chmod) /u.test(line)),
      runtimeHome,
      effectiveConfig,
    };
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}
