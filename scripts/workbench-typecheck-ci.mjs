#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  glob,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const DEFAULT_HEAP_MIB = 4096;
const DEFAULT_PASSES = 2;
// A nominal 16 GiB Linux host exposes slightly less after kernel and hypervisor reservations.
const DEFAULT_CI_MINIMUM_MEMORY_MIB = 15 * 1024;
const RSS_SAMPLE_INTERVAL_MS = 50;

export async function discoverWorkspaceInventory(repoRoot) {
  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const configuredWorkspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;

  if (!Array.isArray(configuredWorkspaces) || configuredWorkspaces.length === 0) {
    throw new Error("Root package.json must define at least one npm workspace pattern");
  }

  const includePatterns = [];
  const excludePatterns = [];
  for (const configuredPattern of configuredWorkspaces) {
    if (typeof configuredPattern !== "string" || configuredPattern.trim() === "") {
      throw new Error("Every npm workspace pattern must be a non-empty string");
    }
    const excluded = configuredPattern.startsWith("!");
    const normalized = normalizeWorkspacePattern(excluded ? configuredPattern.slice(1) : configuredPattern);
    (excluded ? excludePatterns : includePatterns).push(`${normalized}/package.json`);
  }

  const packageJsonPaths = new Set();
  for (const includePattern of includePatterns) {
    for await (const packageJsonPath of glob(includePattern, {
      cwd: repoRoot,
      exclude: excludePatterns,
    })) {
      packageJsonPaths.add(packageJsonPath.replaceAll(path.sep, "/"));
    }
  }

  const workspaces = [];
  const workspaceNames = new Set();
  for (const packageJsonPath of [...packageJsonPaths].sort(compareStrings)) {
    const absolutePackageJsonPath = path.resolve(repoRoot, packageJsonPath);
    assertPathWithin(repoRoot, absolutePackageJsonPath);
    const packageData = JSON.parse(await readFile(absolutePackageJsonPath, "utf8"));
    if (typeof packageData.name !== "string" || packageData.name.trim() === "") {
      throw new Error(`Workspace ${packageJsonPath} must declare a non-empty package name`);
    }
    if (workspaceNames.has(packageData.name)) {
      throw new Error(`Duplicate npm workspace name: ${packageData.name}`);
    }
    workspaceNames.add(packageData.name);

    const typecheckCommand = packageData.scripts?.typecheck;
    workspaces.push({
      name: packageData.name,
      location: path.posix.dirname(packageJsonPath),
      typecheckCommand: typeof typecheckCommand === "string" && typecheckCommand.trim() !== ""
        ? typecheckCommand
        : null,
    });
  }

  if (workspaces.length === 0) {
    throw new Error("The npm workspace patterns did not resolve to any package.json files");
  }

  workspaces.sort((left, right) => compareStrings(left.name, right.name));
  return {
    workspaces,
    typecheckWorkspaces: workspaces.filter((workspace) => workspace.typecheckCommand !== null),
  };
}

export function parseConfiguration({ argv, env, memoryLimitMiB, platform = process.platform }) {
  let configuredPasses = env.WORKBENCH_TYPECHECK_PASSES;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--passes") {
      configuredPasses = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--passes=")) {
      configuredPasses = argument.slice("--passes=".length);
      continue;
    }
    throw new Error(`Unknown typecheck option: ${argument}`);
  }

  const heapMiB = parsePositiveInteger(
    env.WORKBENCH_TYPECHECK_HEAP_MIB?.trim() || String(DEFAULT_HEAP_MIB),
    "WORKBENCH_TYPECHECK_HEAP_MIB",
  );
  const passes = parsePositiveInteger(
    configuredPasses?.trim() || String(DEFAULT_PASSES),
    "WORKBENCH_TYPECHECK_PASSES/--passes",
  );
  const ci = parseBoolean(env.CI ?? "false", "CI");
  const requireCleanBaseline = ci
    || parseBoolean(env.WORKBENCH_TYPECHECK_REQUIRE_CLEAN ?? "false", "WORKBENCH_TYPECHECK_REQUIRE_CLEAN");
  const minimumMemoryMiB = ci
    ? parsePositiveInteger(
      env.WORKBENCH_TYPECHECK_MIN_MEMORY_MIB?.trim() || String(DEFAULT_CI_MINIMUM_MEMORY_MIB),
      "WORKBENCH_TYPECHECK_MIN_MEMORY_MIB",
    )
    : null;

  if (Number.isInteger(memoryLimitMiB) && memoryLimitMiB > 0 && heapMiB >= memoryLimitMiB) {
    throw new Error(
      `WORKBENCH_TYPECHECK_HEAP_MIB (${heapMiB}) must be below available memory (${memoryLimitMiB} MiB)`,
    );
  }
  if (ci && platform !== "linux") {
    throw new Error(`CI typecheck requires Linux; detected ${platform}`);
  }
  if (ci && (!Number.isInteger(memoryLimitMiB) || memoryLimitMiB < minimumMemoryMiB)) {
    throw new Error(
      `CI typecheck requires at least ${minimumMemoryMiB} MiB effective memory on a nominal 16 GiB host; detected ${memoryLimitMiB} MiB`,
    );
  }

  return { heapMiB, passes, requireCleanBaseline, minimumMemoryMiB };
}

export function createNodeOptions(existingNodeOptions, heapMiB) {
  return [existingNodeOptions?.trim(), `--max-old-space-size=${heapMiB}`]
    .filter(Boolean)
    .join(" ");
}

export function createBaselineCleanGate({ dirty, required }) {
  return {
    gate: "baseline-clean",
    pass: 0,
    status: required && dirty ? "FAIL" : "PASS",
    required,
    dirty,
  };
}

export function parsePeakRssKiB(metrics, platform) {
  if (platform === "linux") {
    const match = metrics.match(/Maximum resident set size \(kbytes\):\s*([0-9]+)/u);
    return match ? Number.parseInt(match[1], 10) : null;
  }
  if (platform === "darwin") {
    const match = metrics.match(/^\s*([0-9]+)\s+maximum resident set size\s*$/mu);
    return match ? Math.ceil(Number.parseInt(match[1], 10) / 1024) : null;
  }
  return null;
}

export async function captureGitSourceSnapshot(repoRoot) {
  const [{ stdout: fileListOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync("git", [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--deduplicate",
    ], { cwd: repoRoot, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }),
    execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);
  const filePaths = fileListOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort(compareStrings);
  const hash = createHash("sha256");
  hash.update("workbench-typecheck-source-v1\0");
  hash.update(statusOutput);

  for (const relativePath of filePaths) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    assertPathWithin(repoRoot, absolutePath);
    hash.update(`path\0${relativePath}\0`);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        hash.update("missing\0");
        continue;
      }
      throw error;
    }
    hash.update(`mode\0${stats.mode.toString(8)}\0`);
    if (stats.isSymbolicLink()) {
      hash.update(`symlink\0${await readlink(absolutePath)}\0`);
    } else if (stats.isFile()) {
      hash.update("file\0");
      for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
      hash.update("\0");
    } else {
      hash.update(`other\0${stats.size}\0`);
    }
  }

  return {
    digest: `sha256:${hash.digest("hex")}`,
    dirty: statusOutput.length > 0,
    fileCount: filePaths.length,
  };
}

export async function detectEffectiveMemoryLimitMiB() {
  let limitBytes = BigInt(totalmem());
  if (process.platform === "linux") {
    for (const limitPath of [
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ]) {
      try {
        const rawLimit = (await readFile(limitPath, "utf8")).trim();
        if (/^[1-9][0-9]*$/u.test(rawLimit)) {
          const candidate = BigInt(rawLimit);
          if (candidate < limitBytes) limitBytes = candidate;
        }
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
      }
    }
  }
  return Number(limitBytes / (1024n * 1024n));
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const memoryLimitMiB = await detectEffectiveMemoryLimitMiB();
  const configuration = parseConfiguration({
    argv: process.argv.slice(2),
    env: process.env,
    memoryLimitMiB,
    platform: process.platform,
  });
  const initialInventory = await discoverWorkspaceInventory(repoRoot);
  const initialInventoryDigest = inventoryDigest(initialInventory);
  const baselineSource = await captureGitSourceSnapshot(repoRoot);
  const candidateSha = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  })).stdout.trim();
  const measurementStrategy = await resolveMeasurementStrategy();
  const npmEnvironment = {
    ...process.env,
    NODE_OPTIONS: createNodeOptions(process.env.NODE_OPTIONS, configuration.heapMiB),
  };

  logEvent("TYPECHECK_RUN", {
    candidateSha,
    startedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    heapMiB: configuration.heapMiB,
    availableMemoryMiB: memoryLimitMiB,
    minimumMemoryMiB: configuration.minimumMemoryMiB,
    passes: configuration.passes,
    measurementStrategy,
    baselineSourceDigest: baselineSource.digest,
    baselineDirty: baselineSource.dirty,
    requireCleanBaseline: configuration.requireCleanBaseline,
  });
  logEvent("TYPECHECK_INVENTORY", {
    workspaceCount: initialInventory.workspaces.length,
    typecheckWorkspaceCount: initialInventory.typecheckWorkspaces.length,
    workspaces: initialInventory.typecheckWorkspaces.map(({ name, location }) => ({ name, location })),
    withoutTypecheck: initialInventory.workspaces
      .filter((workspace) => workspace.typecheckCommand === null)
      .map(({ name, location }) => ({ name, location })),
    inventoryDigest: initialInventoryDigest,
  });

  const commandResults = [];
  const gateResults = [createBaselineCleanGate({
    dirty: baselineSource.dirty,
    required: configuration.requireCleanBaseline,
  })];
  logEvent("TYPECHECK_GATE", gateResults[0]);
  for (let pass = 1; pass <= configuration.passes; pass += 1) {
    gateResults.push(await checkInventoryGate({
      repoRoot,
      pass,
      expectedDigest: initialInventoryDigest,
    }));

    commandResults.push(await runNpmTarget({
      args: ["run", "workbench:prepare"],
      env: npmEnvironment,
      kind: "prepare",
      measurementStrategy,
      pass,
      target: "workbench:prepare",
    }));

    for (const workspace of initialInventory.typecheckWorkspaces) {
      commandResults.push(await runNpmTarget({
        args: ["--workspace", workspace.name, "run", "typecheck"],
        env: npmEnvironment,
        kind: "workspace",
        location: workspace.location,
        measurementStrategy,
        pass,
        target: workspace.name,
      }));
    }

    gateResults.push(await checkSourceDriftGate({
      baselineSource,
      pass,
      repoRoot,
    }));
  }

  const expectedTargets = [];
  for (let pass = 1; pass <= configuration.passes; pass += 1) {
    expectedTargets.push(`${pass}:workbench:prepare`);
    for (const workspace of initialInventory.typecheckWorkspaces) {
      expectedTargets.push(`${pass}:${workspace.name}`);
    }
  }
  const executedTargets = new Set(commandResults.map((result) => `${result.pass}:${result.target}`));
  const notExecuted = expectedTargets.filter((target) => !executedTargets.has(target));
  const failedCommands = commandResults.filter((result) => result.status === "FAIL");
  const failedGates = gateResults.filter((result) => result.status === "FAIL");
  const aggregatePassed = failedCommands.length === 0 && failedGates.length === 0 && notExecuted.length === 0;

  logEvent("TYPECHECK_SUMMARY", {
    status: aggregatePassed ? "PASS" : "FAIL",
    candidateSha,
    finishedAt: new Date().toISOString(),
    passes: configuration.passes,
    commandsExpected: expectedTargets.length,
    commandsExecuted: commandResults.length,
    commandsPassed: commandResults.length - failedCommands.length,
    commandsFailed: failedCommands.length,
    gatesFailed: failedGates.length,
    exit134Count: commandResults.filter((result) => result.exit134).length,
    oomSuspectedCount: commandResults.filter((result) => result.oomSuspected).length,
    maxPeakRssKiB: Math.max(...commandResults.map((result) => result.peakRssKiB ?? 0)),
    failedTargets: failedCommands.map((result) => `${result.pass}:${result.target}`),
    notExecuted,
  });

  if (!aggregatePassed) process.exitCode = 1;
}

async function checkInventoryGate({ repoRoot, pass, expectedDigest }) {
  let actualDigest = null;
  let errorMessage = null;
  try {
    actualDigest = inventoryDigest(await discoverWorkspaceInventory(repoRoot));
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  const status = actualDigest === expectedDigest ? "PASS" : "FAIL";
  const result = {
    gate: "workspace-inventory",
    pass,
    status,
    expectedDigest,
    actualDigest,
    error: errorMessage,
  };
  logEvent("TYPECHECK_GATE", result);
  return result;
}

async function checkSourceDriftGate({ baselineSource, pass, repoRoot }) {
  let actualSource = null;
  let errorMessage = null;
  try {
    actualSource = await captureGitSourceSnapshot(repoRoot);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  const status = actualSource?.digest === baselineSource.digest ? "PASS" : "FAIL";
  const result = {
    gate: "source-drift",
    pass,
    status,
    expectedDigest: baselineSource.digest,
    actualDigest: actualSource?.digest ?? null,
    baselineDirty: baselineSource.dirty,
    actualDirty: actualSource?.dirty ?? null,
    error: errorMessage,
  };
  logEvent("TYPECHECK_GATE", result);
  return result;
}

async function runNpmTarget({
  args,
  env,
  kind,
  location = null,
  measurementStrategy,
  pass,
  target,
}) {
  const startedAt = new Date().toISOString();
  logEvent("TYPECHECK_START", { pass, target, kind, location, startedAt });
  let measurement;
  try {
    measurement = await measureCommand({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args,
      env,
      strategy: measurementStrategy,
    });
  } catch (error) {
    measurement = {
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
      exitCode: null,
      peakRssKiB: null,
      signal: null,
    };
  }

  const commandPassed = measurement.exitCode === 0 && measurement.signal === null && measurement.error === null;
  const metricsAvailable = Number.isInteger(measurement.peakRssKiB) && measurement.peakRssKiB > 0;
  const exit134 = measurement.exitCode === 134;
  const oomSuspected = exit134
    || measurement.exitCode === 137
    || measurement.signal === "SIGABRT"
    || measurement.signal === "SIGKILL";
  const result = {
    pass,
    target,
    kind,
    location,
    status: commandPassed && metricsAvailable ? "PASS" : "FAIL",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: measurement.durationMs,
    peakRssKiB: measurement.peakRssKiB,
    peakRssMiB: metricsAvailable ? Number((measurement.peakRssKiB / 1024).toFixed(1)) : null,
    exitCode: measurement.exitCode,
    signal: measurement.signal,
    exit134,
    oomSuspected,
    failureClass: !commandPassed
      ? "COMMAND_FAILED"
      : !metricsAvailable
        ? "RSS_EVIDENCE_MISSING"
        : null,
    error: measurement.error,
  };
  logEvent("TYPECHECK_RESULT", result);
  return result;
}

async function measureCommand({ command, args, env, strategy }) {
  if (strategy === "gnu-time" || strategy === "darwin-time") {
    return measureWithSystemTime({ command, args, env, strategy });
  }
  return measureWithProcessSampling({ command, args, env });
}

async function measureWithSystemTime({ command, args, env, strategy }) {
  const metricsDirectory = await mkdtemp(path.join(tmpdir(), "workbench-typecheck-rss-"));
  const metricsPath = path.join(metricsDirectory, "time.txt");
  const timeArguments = strategy === "gnu-time"
    ? ["-v", "-o", metricsPath]
    : ["-l", "-o", metricsPath];
  const started = performance.now();
  try {
    const completion = await spawnCompletion("/usr/bin/time", [...timeArguments, command, ...args], {
      env,
      stdio: "inherit",
    });
    let metrics = "";
    try {
      metrics = await readFile(metricsPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return {
      durationMs: Math.round(performance.now() - started),
      error: completion.error,
      exitCode: completion.exitCode,
      peakRssKiB: parsePeakRssKiB(metrics, strategy === "gnu-time" ? "linux" : "darwin"),
      signal: completion.signal,
    };
  } finally {
    await rm(metricsDirectory, { recursive: true, force: true });
  }
}

async function measureWithProcessSampling({ command, args, env }) {
  const started = performance.now();
  const child = spawn(command, args, { env, stdio: "inherit" });
  let finished = false;
  let peakRssKiB = 0;
  let samplingError = null;
  const sampler = (async () => {
    while (!finished) {
      try {
        peakRssKiB = Math.max(peakRssKiB, await processTreeRssKiB(child.pid));
      } catch (error) {
        samplingError ??= error instanceof Error ? error.message : String(error);
      }
      if (!finished) await delay(RSS_SAMPLE_INTERVAL_MS);
    }
  })();
  const completion = await waitForChild(child);
  finished = true;
  await sampler;
  return {
    durationMs: Math.round(performance.now() - started),
    error: completion.error ?? samplingError,
    exitCode: completion.exitCode,
    peakRssKiB: peakRssKiB || null,
    signal: completion.signal,
  };
}

async function processTreeRssKiB(rootPid) {
  if (!Number.isInteger(rootPid)) return 0;
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const processes = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10)))
    .filter(([pid, parentPid, rss]) => Number.isInteger(pid) && Number.isInteger(parentPid) && Number.isInteger(rss));
  const childrenByParent = new Map();
  const rssByPid = new Map();
  for (const [pid, parentPid, rss] of processes) {
    rssByPid.set(pid, rss);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  let totalRssKiB = 0;
  const pending = [rootPid];
  const visited = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    totalRssKiB += rssByPid.get(pid) ?? 0;
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return totalRssKiB;
}

async function resolveMeasurementStrategy() {
  if (process.platform === "linux" || process.platform === "darwin") {
    try {
      await access("/usr/bin/time");
      return process.platform === "linux" ? "gnu-time" : "darwin-time";
    } catch {
      // Fall through to process-tree sampling.
    }
  }
  return "process-tree-sampling";
}

function spawnCompletion(command, args, options) {
  return waitForChild(spawn(command, args, options));
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let spawnError = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
      finish({ error: spawnError, exitCode: null, signal: null });
    });
    child.once("close", (exitCode, signal) => {
      finish({ error: spawnError, exitCode, signal });
    });
  });
}

function inventoryDigest(inventory) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(inventory.workspaces))
    .digest("hex")}`;
}

function normalizeWorkspacePattern(configuredPattern) {
  const normalized = configuredPattern.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (normalized === "" || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe npm workspace pattern: ${configuredPattern}`);
  }
  return normalized;
}

function parsePositiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the supported integer range`);
  return parsed;
}

function parseBoolean(value, label) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no", ""].includes(normalized)) return false;
  throw new Error(`${label} must be true/false or 1/0`);
}

function assertPathWithin(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  if (relativePath.startsWith(`..${path.sep}`) || relativePath === ".." || path.isAbsolute(relativePath)) {
    throw new Error(`Workspace path escapes the repository root: ${candidatePath}`);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logEvent(event, payload) {
  console.log(`${event} ${JSON.stringify(payload)}`);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    logEvent("TYPECHECK_FATAL", {
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
    });
    process.exitCode = 1;
  });
}
