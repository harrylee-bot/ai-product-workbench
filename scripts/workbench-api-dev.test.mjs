import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createWorkbenchApiDevRunner,
  WORKBENCH_API_ENTRYPOINT,
  WORKBENCH_API_ROOT,
} from "./workbench-api-dev.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    this.signalCode = signal;
    this.emit("close", null, signal);
    return true;
  }
}

function createHarness() {
  const processTarget = new EventEmitter();
  const runtimes = [];
  const spawnCalls = [];
  const logMessages = [];
  let buildComplete;
  let watcherCloseCount = 0;

  const runner = createWorkbenchApiDevRunner({
    createCompilerWatch: ({ onBuildComplete }) => {
      buildComplete = onBuildComplete;
      return {
        close() {
          watcherCloseCount += 1;
        },
      };
    },
    spawnRuntime: (command, args, options) => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      spawnCalls.push({ args, command, options });
      return runtime;
    },
    processTarget,
    logger: {
      error: (...parts) => logMessages.push(parts.join(" ")),
      info: (...parts) => logMessages.push(parts.join(" ")),
    },
  });

  return {
    build: (success) => buildComplete({ diagnostics: [], success }),
    logMessages,
    processTarget,
    runner,
    runtimes,
    spawnCalls,
    watcherCloseCount: () => watcherCloseCount,
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("does not start the runtime before the first successful build", async () => {
  const harness = createHarness();

  harness.build(false);
  await settle();

  assert.equal(harness.spawnCalls.length, 0);
  await harness.runner.close();
});

test("starts dist/main.js after the first successful build", async () => {
  const harness = createHarness();

  harness.build(true);
  await settle();

  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].command, process.execPath);
  assert.deepEqual(harness.spawnCalls[0].args, [
    "--enable-source-maps",
    WORKBENCH_API_ENTRYPOINT,
  ]);
  assert.equal(harness.spawnCalls[0].options.cwd, WORKBENCH_API_ROOT);
  await harness.runner.close();
});

test("restarts exactly once after one later successful build", async () => {
  const harness = createHarness();

  harness.build(true);
  await settle();
  harness.build(true);
  await settle();

  assert.equal(harness.spawnCalls.length, 2);
  assert.deepEqual(harness.runtimes[0].killSignals, ["SIGTERM"]);
  assert.deepEqual(harness.runtimes[1].killSignals, []);
  await harness.runner.close();
});

test("keeps the current runtime after a diagnostic failure", async () => {
  const harness = createHarness();

  harness.build(true);
  await settle();
  harness.build(false);
  await settle();

  assert.equal(harness.spawnCalls.length, 1);
  assert.deepEqual(harness.runtimes[0].killSignals, []);
  await harness.runner.close();
});

test("shutdown closes the watcher, signal listeners, and runtime", async () => {
  const harness = createHarness();

  harness.build(true);
  await settle();
  harness.processTarget.emit("SIGTERM");

  assert.equal(await harness.runner.finished, 143);
  assert.equal(harness.watcherCloseCount(), 1);
  assert.deepEqual(harness.runtimes[0].killSignals, ["SIGTERM"]);
  assert.equal(harness.processTarget.listenerCount("SIGINT"), 0);
  assert.equal(harness.processTarget.listenerCount("SIGTERM"), 0);
});

test("an unexpected runtime exit closes the compiler watch and fails", async () => {
  const harness = createHarness();

  harness.build(true);
  await settle();
  harness.runtimes[0].exitCode = 23;
  harness.runtimes[0].emit("close", 23, null);

  assert.equal(await harness.runner.finished, 23);
  assert.equal(harness.watcherCloseCount(), 1);
});

test("package scripts use the compiler-backed API watcher in local dev and CI", async () => {
  const rootPackage = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const apiPackage = JSON.parse(
    await readFile(path.join(repoRoot, "apps/workbench-api/package.json"), "utf8"),
  );

  assert.match(apiPackage.scripts.dev, /scripts\/workbench-api-dev\.mjs/u);
  assert.doesNotMatch(apiPackage.scripts.dev, /tsx|src\/main\.ts/u);
  assert.match(
    rootPackage.scripts["dev:workbench:test"],
    /scripts\/workbench-dev\.test\.mjs/u,
  );
  assert.match(
    rootPackage.scripts["dev:workbench:test"],
    /scripts\/workbench-api-dev\.test\.mjs/u,
  );
  assert.match(
    rootPackage.scripts.test,
    /^npm run workbench:prepare && npm run remediation:r0:test && npm run dev:workbench:test &&/u,
  );
});
