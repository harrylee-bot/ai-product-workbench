import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve("deploy/workbench-build-resources.sh");
const policy = resolve("deploy/workbench-buildkitd.toml");
const builderName = "workbench-validation-bounded";

test("new validation builder enforces a single bounded build, loads images, and stops without deleting its cache", () => {
  const result = runBuild({ services: ["workbench-web", "knowledge"] });
  assert.equal(result.status, 0, result.stderr);
  const create = find(result, "buildx", "create");
  assert.ok(create);
  for (const option of ["memory=6442450944", "memory-swap=6442450944", "cpu-period=100000", "cpu-quota=200000", "default-load=true"]) {
    assert.ok(create.args.includes(option), option);
  }
  assert.equal(create.args.includes("--use"), false);
  assert.equal(create.args.at(-1), "unix:///var/run/docker.sock");
  assert.deepEqual(builds(result).map(entry => entry.args), [[
    "compose", "--env-file", "/private/env", "-f", "/candidate/compose.yml",
    "--parallel", "1", "build", "--builder", builderName, "--with-dependencies", "workbench-web", "knowledge",
  ]]);
  assert.equal(builds(result)[0].bake, "false");
  assert.equal(builds(result)[0].buildkit, "1");
  assert.deepEqual(result.commands.at(-1).args, ["buildx", "stop", builderName]);
  assert.equal(result.commands.some(entry => entry.args.includes("rm") || entry.args.includes("up") || entry.args.includes("run")), false);
  assert.deepEqual(result.remainingTempFiles, []);
});

test("matching persistent builder is reused and an empty service list builds all services once", () => {
  const result = runBuild({ existing: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(find(result, "buildx", "create"), undefined);
  assert.equal(builds(result).length, 1);
  assert.equal(builds(result)[0].args.at(-1), "--with-dependencies");
});

test("bounded custom budgets and builder names are applied together", () => {
  const result = runBuild({ env: {
    WORKBENCH_BUILD_MEMORY_MIB: "3072",
    WORKBENCH_BUILD_RESERVE_MIB: "1024",
    WORKBENCH_BUILD_CPUS: "1",
    WORKBENCH_BUILD_BUILDER: "workbench-validation-small",
  } });
  assert.equal(result.status, 0, result.stderr);
  const create = find(result, "buildx", "create");
  assert.ok(create.args.includes("memory=3221225472"));
  assert.ok(create.args.includes("memory-swap=3221225472"));
  assert.ok(create.args.includes("cpu-quota=100000"));
  assert.ok(builds(result)[0].args.includes("workbench-validation-small"));
});

test("invalid budgets or an unowned builder namespace fail before Docker is called", () => {
  for (const env of [
    { WORKBENCH_BUILD_MEMORY_MIB: "0" },
    { WORKBENCH_BUILD_MEMORY_MIB: "-1" },
    { WORKBENCH_BUILD_MEMORY_MIB: "2048; true" },
    { WORKBENCH_BUILD_MEMORY_MIB: "65537" },
    { WORKBENCH_BUILD_RESERVE_MIB: "0" },
    { WORKBENCH_BUILD_CPUS: "2.5" },
    { WORKBENCH_BUILD_CPUS: "9" },
    { WORKBENCH_BUILD_BUILDER: "default" },
  ]) {
    const result = runBuild({ env });
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.deepEqual(result.commands, []);
  }
});

test("insufficient or unreadable MemAvailable fails closed without building", () => {
  for (const available of ["8388607", "unavailable", "invalid"]) {
    const result = runBuild({ available });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MemAvailable/u);
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.remainingTempFiles, []);
  }
  assert.equal(runBuild({ available: "8388608" }).status, 0);
});

test("the Linux guard and resource policy cannot be omitted", () => {
  for (const options of [{ os: "Darwin" }, { missingPolicy: true }, { malformedPolicy: true }, { noCompose: true }]) {
    const result = runBuild(options);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.equal(builds(result).length, 0);
  }
});

test("remote Docker contexts and mismatched daemon hostnames are refused", () => {
  for (const options of [
    { endpoint: "ssh://production" },
    { endpoint: "tcp://127.0.0.1:2375" },
    { env: { DOCKER_HOST: "ssh://production" } },
    { daemonHostname: "another-host" },
  ]) {
    const result = runBuild(options);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.equal(find(result, "buildx", "create"), undefined);
    assert.equal(builds(result).length, 0);
  }
});

test("missing Docker cgroup capabilities fail before creating or starting a builder", () => {
  for (const capability of ["MemoryLimit", "SwapLimit", "CpuCfsPeriod", "CpuCfsQuota"]) {
    const result = runBuild({ absentCapability: capability });
    assert.notEqual(result.status, 0);
    assert.equal(find(result, "buildx", "create"), undefined);
    assert.equal(find(result, "buildx", "inspect"), undefined);
  }
});

test("existing builder drift is not started, modified, or removed", () => {
  for (const drift of ["driver", "nodes", "endpoint", "memory", "swap", "cpu", "load", "config", "unknown-option", "flags-config", "flags-worker"]) {
    const result = runBuild({ existing: true, drift });
    assert.notEqual(result.status, 0, drift);
    assert.match(result.stderr, /builder settings differ/u);
    assert.equal(find(result, "buildx", "create"), undefined);
    assert.equal(find(result, "buildx", "inspect"), undefined);
    assert.equal(find(result, "buildx", "stop"), undefined);
    assert.equal(builds(result).length, 0);
  }
});

test("active container resource or BuildKit policy drift prevents builds and stops the verified builder", () => {
  for (const activeDrift of ["memory", "swap", "cpu", "period", "stopped", "config", "command-config", "command-worker", "command-repeat"]) {
    const result = runBuild({ existing: true, activeDrift });
    assert.notEqual(result.status, 0, activeDrift);
    assert.equal(builds(result).length, 0);
    assert.ok(find(result, "buildx", "stop"));
    assert.deepEqual(result.remainingTempFiles, []);
  }
});

test("the only permitted buildkitd flags are absent or Docker's default network entitlement", () => {
  for (const flags of [[], ["--allow-insecure-entitlement=network.host"], ["--allow-insecure-entitlement", "network.host"]]) {
    const result = runBuild({ existing: true, flags });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(builds(result).length, 1);
  }
});

test("build errors propagate and cleanup releases the builder without removing cache", () => {
  const result = runBuild({ buildExit: 37 });
  assert.equal(result.status, 37, result.stderr);
  assert.equal(builds(result).length, 1);
  assert.deepEqual(result.commands.at(-1).args, ["buildx", "stop", builderName]);
  assert.deepEqual(result.remainingTempFiles, []);
});

test("failed builder bootstrap is cleaned up and failed cleanup is not reported as success", () => {
  const bootstrap = runBuild({ fail: "bootstrap" });
  assert.notEqual(bootstrap.status, 0);
  assert.equal(builds(bootstrap).length, 0);
  assert.ok(find(bootstrap, "buildx", "stop"));
  const stop = runBuild({ fail: "stop" });
  assert.notEqual(stop.status, 0);
  assert.match(stop.stderr, /could not stop/u);
  assert.deepEqual(stop.remainingTempFiles, []);
});

test("inventory and creation errors fail closed", () => {
  for (const fail of ["inventory", "inventory-json", "create", "container-inspect", "active-config"]) {
    const result = runBuild({ fail });
    assert.notEqual(result.status, 0, fail);
    assert.equal(builds(result).length, 0);
    assert.deepEqual(result.remainingTempFiles, []);
  }
});

test("a fixed host-wide flock serializes different builder names before any Docker operation", () => {
  const result = runBuild({ lockBusy: true, env: { WORKBENCH_BUILD_BUILDER: "workbench-validation-other" } });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /host-wide lock/u);
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.lockCommands[0].slice(0, 4), ["--nonblock", "--conflict-exit-code", "75", "/run/lock/workbench-validation-build.lock"]);
});

test("flock execution failure cannot fall back to an unbounded build", () => {
  const result = runBuild({ lockFailure: true });
  assert.equal(result.status, 69);
  assert.deepEqual(result.commands, []);
});

function find(result, ...prefix) {
  return result.commands.find(entry => prefix.every((value, index) => entry.args[index] === value));
}

function builds(result) {
  return result.commands.filter(entry => entry.args[0] === "compose" && entry.args.includes("build"));
}

function runBuild(options = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "workbench-build-resources-test-"));
  const bin = join(fixture, "bin");
  const deploy = join(fixture, "deploy");
  const scratch = join(fixture, "scratch");
  const log = join(fixture, "commands.jsonl");
  mkdirSync(bin);
  mkdirSync(deploy);
  mkdirSync(scratch);
  writeFileSync(log, "");
  writeFileSync(join(fixture, "lock.jsonl"), "");
  copyFileSync(script, join(deploy, "build.sh"));
  if (!options.missingPolicy) copyFileSync(policy, join(deploy, "workbench-buildkitd.toml"));
  if (options.malformedPolicy) appendFileSync(join(deploy, "workbench-buildkitd.toml"), "[worker.containerd]\nmax-parallelism = 8\n");
  const config = {
    endpoint: "unix:///var/run/docker.sock", available: "16777216", os: "Linux", daemonHostname: "build-host",
    ...options,
  };
  writeFileSync(join(fixture, "options.json"), JSON.stringify(config));
  writeExecutable(join(bin, "uname"), '#!/bin/sh\nif [ "$1" = -s ]; then printf "%s\\n" "$MOCK_OS"; else printf "build-host\\n"; fi\n');
  writeExecutable(join(bin, "awk"), '#!/bin/sh\n[ "$MOCK_AVAILABLE" != unavailable ] || exit 1\nprintf "%s\\n" "$MOCK_AVAILABLE"\n');
  writeFileSync(join(bin, "docker.cjs"), dockerMock);
  writeFileSync(join(bin, "flock.cjs"), flockMock);
  const nodeLauncher = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -- "$0.cjs" "$@"\n`;
  writeExecutable(join(bin, "docker"), nodeLauncher);
  writeExecutable(join(bin, "flock"), nodeLauncher);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("WORKBENCH_BUILD_") || ["DOCKER_HOST", "DOCKER_CONTEXT", "BUILDX_BUILDER"].includes(key)) delete env[key];
  }
  try {
    const result = spawnSync("bash", ["-c", [
      'set -Eeuo pipefail',
      'source "$1"',
      options.noCompose ? "unset COMPOSE" : 'COMPOSE=(docker compose --env-file /private/env -f /candidate/compose.yml)',
      'shift',
      'validation_build_images "$@"',
    ].join("\n"), "test", join(deploy, "build.sh"), ...(options.services ?? [])], {
      encoding: "utf8",
      env: {
        ...env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch,
        MOCK_FIXTURE: fixture, MOCK_OS: config.os, MOCK_AVAILABLE: config.available,
        COMPOSE_BAKE: "true", DOCKER_BUILDKIT: "0", ...(options.env ?? {}),
      },
      timeout: 10000,
    });
    return {
      ...result,
      commands: readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)),
      lockCommands: readFileSync(join(fixture, "lock.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)),
      remainingTempFiles: readdirSync(scratch),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function writeExecutable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

const dockerMock = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.MOCK_FIXTURE;
const options = JSON.parse(fs.readFileSync(path.join(root, "options.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ args, bake: process.env.COMPOSE_BAKE, buildkit: process.env.DOCKER_BUILDKIT }) + "\n");
const is = (...prefix) => prefix.every((value, index) => args[index] === value);
const name = process.env.WORKBENCH_BUILD_BUILDER || "workbench-validation-bounded";
const memory = Number(process.env.WORKBENCH_BUILD_MEMORY_MIB || 6144) * 1024 * 1024;
const quota = Number(process.env.WORKBENCH_BUILD_CPUS || 2) * 100000;
const stateFile = path.join(root, "created");
const policy = "[worker]\n  [worker.oci]\n    max-parallelism = 1\n";
const output = value => console.log(typeof value === "string" ? value : JSON.stringify(value));
if (is("context", "show")) output("default");
else if (is("context", "inspect")) output(options.endpoint);
else if (is("info")) {
  const info = { OSType: "linux", Name: options.daemonHostname, MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true };
  if (options.absentCapability) info[options.absentCapability] = false;
  output(info);
} else if (is("buildx", "ls")) {
  if (options.fail === "inventory") process.exit(3);
  if (options.fail === "inventory-json") { output("not json"); process.exit(0); }
  if (options.existing || fs.existsSync(stateFile)) {
    const node = { Name: name + "0", Endpoint: options.endpoint,
      Flags: options.flags || ["--allow-insecure-entitlement=network.host"],
      DriverOpts: { memory: String(memory), "memory-swap": String(memory), "cpu-period": "100000", "cpu-quota": String(quota), "default-load": "true" },
      Files: { "buildkitd.toml": Buffer.from(policy).toString("base64") },
    };
    const builder = { Name: name, Driver: "docker-container", Nodes: [node] };
    if (options.drift === "driver") builder.Driver = "docker";
    if (options.drift === "nodes") builder.Nodes.push({ ...node, Name: name + "1" });
    if (options.drift === "endpoint") node.Endpoint = "ssh://another-host";
    if (options.drift === "memory") node.DriverOpts.memory = "999";
    if (options.drift === "swap") node.DriverOpts["memory-swap"] = "-1";
    if (options.drift === "cpu") node.DriverOpts["cpu-quota"] = "-1";
    if (options.drift === "load") delete node.DriverOpts["default-load"];
    if (options.drift === "config") node.Files["buildkitd.toml"] = Buffer.from(policy.replace("= 1", "= 8")).toString("base64");
    if (options.drift === "unknown-option") node.DriverOpts.network = "host";
    if (options.drift === "flags-config") node.Flags = ["--config", "/tmp/unbounded.toml"];
    if (options.drift === "flags-worker") node.Flags = ["--oci-worker=false", "--containerd-worker=true"];
    output(builder);
  }
} else if (is("buildx", "create")) {
  if (options.fail === "create") process.exit(4);
  fs.writeFileSync(stateFile, "created");
  output(name);
} else if (is("buildx", "inspect")) {
  if (options.fail === "bootstrap") process.exit(5);
} else if (is("inspect", "--type", "container")) {
  if (options.fail === "container-inspect") process.exit(6);
  const limits = { Memory: memory, MemorySwap: memory, CpuPeriod: 100000, CpuQuota: quota };
  if (options.activeDrift === "memory") limits.Memory = 0;
  if (options.activeDrift === "swap") limits.MemorySwap = -1;
  if (options.activeDrift === "period") limits.CpuPeriod = 0;
  if (options.activeDrift === "cpu") limits.CpuQuota = 0;
  const command = ["--config", "/etc/buildkit/buildkitd.toml", ...(options.flags || ["--allow-insecure-entitlement=network.host"])];
  if (options.activeDrift === "command-config") command[1] = "/tmp/unbounded.toml";
  if (options.activeDrift === "command-worker") command.push("--oci-worker=false");
  if (options.activeDrift === "command-repeat") command.push("--config", "/etc/buildkit/buildkitd.toml");
  output([{ State: { Running: options.activeDrift !== "stopped" }, HostConfig: limits, Config: { Cmd: command } }]);
} else if (is("exec")) {
  if (options.fail === "active-config") process.exit(7);
  output(options.activeDrift === "config" ? policy.replace("= 1", "= 8") : policy);
} else if (is("compose")) {
  if (!args.includes("build")) process.exit(88);
  process.exit(options.buildExit || 0);
} else if (is("buildx", "stop")) {
  if (options.fail === "stop") process.exit(8);
} else {
  console.error("Unexpected Docker invocation: " + JSON.stringify(args));
  process.exit(99);
}
`;

const flockMock = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.env.MOCK_FIXTURE;
const options = JSON.parse(fs.readFileSync(path.join(root, "options.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "lock.jsonl"), JSON.stringify(args) + "\n");
if (JSON.stringify(args.slice(0, 4)) !== JSON.stringify(["--nonblock", "--conflict-exit-code", "75", "/run/lock/workbench-validation-build.lock"])) process.exit(98);
if (options.lockBusy) process.exit(75);
if (options.lockFailure) process.exit(69);
const result = spawnSync(args[4], args.slice(5), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 97);
`;
