import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve("deploy/workbench-build.sh");

test("build CLI validates Compose then delegates only selected services to the bounded builder", () => {
  const result = runBuild({ services: ["workbench-web", "knowledge"], overlay: true, profiles: "local-storage local-identity" });
  assert.equal(result.status, 0, result.stderr);
  const compose = [
    "docker", "compose", "--env-file", result.envFile, "-f", result.composeFile,
    "-f", result.overlayFile, "--profile", "local-storage", "--profile", "local-identity",
  ];
  assert.deepEqual(result.commands, [
    { kind: "docker", cwd: result.appDir, args: [...compose.slice(1), "config", "--quiet"] },
    { kind: "guard", cwd: result.appDir, compose, services: ["workbench-web", "knowledge"] },
  ]);
});

test("build CLI defaults to the project's Compose file and preserves an empty service list", () => {
  const result = runBuild({ defaultCompose: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands[0].args, [
    "compose", "--env-file", result.envFile, "-f", join(result.appDir, "deploy/workbench-compose.yml"), "config", "--quiet",
  ]);
  assert.deepEqual(result.commands[1].services, []);
});

test("build CLI help requires no project, helper, or Docker", () => {
  const result = runBuild({ services: ["--help"], missingApp: true, missingEnv: true, missingHelper: true, noDocker: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: APP_DIR=/u);
  assert.deepEqual(result.commands, []);
});

test("build CLI rejects flags and malformed service arguments before Docker", () => {
  for (const services of [["--push"], ["--build"], ["--help", "web"], ["--"], ["bad name"], ["$(touch file)"], [""]]) {
    const result = runBuild({ services });
    assert.equal(result.status, 64, JSON.stringify(services));
    assert.deepEqual(result.commands, []);
  }
});

test("build CLI requires explicit project and environment and readable configuration files", () => {
  for (const options of [
    { missingApp: true }, { missingEnv: true }, { invalidApp: true }, { missingCompose: true },
    { missingEnvFile: true }, { missingOverlay: true, overlay: true }, { missingHelper: true },
    { relativeApp: true }, { relativeEnv: true }, { relativeCompose: true },
    { profiles: "--push" },
  ]) {
    const result = runBuild(options);
    assert.equal(result.status, 64, JSON.stringify(options));
    assert.deepEqual(result.commands, [], JSON.stringify(options));
  }
});

test("invalid Compose configuration prevents invoking the builder", () => {
  const result = runBuild({ configStatus: 17 });
  assert.equal(result.status, 17, result.stderr);
  assert.deepEqual(result.commands.map(command => command.kind), ["docker"]);
  assert.deepEqual(result.commands[0].args.slice(-2), ["config", "--quiet"]);
});

test("a builder failure is preserved without any application operation", () => {
  const result = runBuild({ guardStatus: 75, services: ["workbench-api"] });
  assert.equal(result.status, 75, result.stderr);
  assert.deepEqual(result.commands.map(command => command.kind), ["docker", "guard"]);
  assert.deepEqual(result.commands[0].args.slice(-2), ["config", "--quiet"]);
  assert.deepEqual(result.commands[1].services, ["workbench-api"]);
});

function runBuild(options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-build-cli-")));
  const appDir = join(root, "project with spaces");
  const bundleDir = join(root, "ops-bundle");
  const binDir = join(root, "bin");
  const commandFile = join(root, "commands.jsonl");
  const envFile = join(root, "private env");
  const composeFile = join(appDir, "deploy", options.defaultCompose ? "workbench-compose.yml" : "custom.yml");
  const overlayFile = join(root, "overlay.yml");
  for (const dir of [join(appDir, "deploy"), bundleDir, binDir]) mkdirSync(dir, { recursive: true });
  copyFileSync(script, join(bundleDir, "workbench-build.sh"));
  writeFileSync(commandFile, "");
  if (!options.missingEnvFile) writeFileSync(envFile, "EXAMPLE=value\n");
  if (!options.missingCompose) writeFileSync(composeFile, "services: {}\n");
  if (!options.missingOverlay) writeFileSync(overlayFile, "services: {}\n");
  if (!options.missingHelper) writeFileSync(join(bundleDir, "workbench-build-resources.sh"), [
    "validation_build_images() {",
    '  "$TEST_NODE" - "${COMPOSE[@]}" -- "$@" <<\'NODE\'',
    'const fs = require("node:fs"); const args = process.argv.slice(2); const separator = args.indexOf("--");',
    'fs.appendFileSync(process.env.TEST_COMMAND_FILE, JSON.stringify({ kind: "guard", cwd: process.cwd(), compose: args.slice(0, separator), services: args.slice(separator + 1) }) + "\\n");',
    "NODE",
    '  return "$TEST_GUARD_STATUS"',
    "}", "",
  ].join("\n"));
  if (!options.noDocker) writeFileSync(join(binDir, "docker"), [
    "#!/bin/sh",
    '"$TEST_NODE" - "$@" <<\'NODE\'',
    'const fs = require("node:fs");',
    'fs.appendFileSync(process.env.TEST_COMMAND_FILE, JSON.stringify({ kind: "docker", cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");',
    "NODE",
    'exit "$TEST_CONFIG_STATUS"', "",
  ].join("\n"), { mode: 0o755 });
  const env = { ...process.env };
  for (const key of ["APP_DIR", "WORKBENCH_ENV_FILE", "WORKBENCH_COMPOSE_FILE", "WORKBENCH_COMPOSE_OVERLAY", "WORKBENCH_COMPOSE_PROFILES"]) delete env[key];
  Object.assign(env, {
    PATH: `${binDir}:${process.env.PATH}`,
    TEST_NODE: process.execPath,
    TEST_COMMAND_FILE: commandFile,
    TEST_CONFIG_STATUS: String(options.configStatus ?? 0),
    TEST_GUARD_STATUS: String(options.guardStatus ?? 0),
  });
  if (!options.missingApp) env.APP_DIR = options.relativeApp ? "relative-project" : options.invalidApp ? join(root, "missing") : appDir;
  if (!options.missingEnv) env.WORKBENCH_ENV_FILE = options.relativeEnv ? "relative.env" : envFile;
  if (!options.defaultCompose) env.WORKBENCH_COMPOSE_FILE = options.relativeCompose ? "relative.yml" : composeFile;
  if (options.overlay) env.WORKBENCH_COMPOSE_OVERLAY = overlayFile;
  if (options.profiles) env.WORKBENCH_COMPOSE_PROFILES = options.profiles;
  try {
    const result = spawnSync("bash", [join(bundleDir, "workbench-build.sh"), ...(options.services ?? [])], { env, encoding: "utf8" });
    const commands = readFileSync(commandFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { ...result, commands, appDir, envFile, composeFile, overlayFile };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
