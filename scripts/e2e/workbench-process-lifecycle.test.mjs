import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import {
  runBoundedCleanup,
  stopProcessTree,
} from "./workbench-process-lifecycle.mjs";

test("bounds cleanup and records only a stable outcome", async () => {
  const never = new Promise(() => undefined);
  const startedAt = Date.now();
  const result = await runBoundedCleanup("browser-context", () => never, 20);

  assert.deepEqual(result, {
    label: "browser-context",
    status: "timed-out",
  });
  assert.ok(Date.now() - startedAt < 500, "bounded cleanup exceeded its test budget");
});

test("sanitizes cleanup failures without retaining exception messages or custom names", async () => {
  const secret = "postgresql://user:secret@host/database";
  const error = new Error(secret);
  error.name = secret;

  const result = await runBoundedCleanup("browser", () => Promise.reject(error), 100);
  const serialized = JSON.stringify(result);

  assert.deepEqual(result, {
    label: "browser",
    status: "failed",
    errorClass: "UnknownError",
  });
  assert.doesNotMatch(serialized, /secret|postgresql/u);
});

test("stops a detached process tree gracefully when the group exits", async () => {
  const signals = [];
  let running = true;
  const child = { pid: 42 };
  const exitPromise = Promise.resolve({ code: 0, signal: "SIGTERM" });

  const result = await stopProcessTree(child, exitPromise, {
    delayImpl: async () => undefined,
    isRunningImpl: () => running,
    signalImpl: (_child, signal) => {
      signals.push(signal);
      running = false;
    },
  });

  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(result, { forced: false, status: "stopped" });
});

test("force-kills descendants left behind after the wrapper process exits", async () => {
  const signals = [];
  let running = true;
  const child = { pid: 42 };
  const exitPromise = Promise.resolve({ code: 0, signal: "SIGTERM" });

  const result = await stopProcessTree(child, exitPromise, {
    delayImpl: async () => undefined,
    isRunningImpl: () => running,
    signalImpl: (_child, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") running = false;
    },
  });

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result, { forced: true, status: "stopped" });
});

test("terminates a real POSIX wrapper and its SIGTERM-resistant descendant", {
  skip: process.platform === "win32",
  timeout: 5_000,
}, async () => {
  const descendantSource = [
    'process.on("SIGTERM", () => undefined);',
    'process.send?.("ready");',
    "setInterval(() => undefined, 1_000);",
  ].join("");
  const wrapperSource = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], `,
    '{ stdio: ["ignore", "ignore", "ignore", "ipc"] });',
    'child.once("message", () => process.stdout.write(`${child.pid}\\n`));',
    "setInterval(() => undefined, 1_000);",
  ].join("");
  const wrapper = spawn(process.execPath, ["-e", wrapperSource], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exitPromise = once(wrapper, "exit");
  let descendantPid;

  try {
    const [chunk] = await once(wrapper.stdout, "data");
    descendantPid = Number.parseInt(String(chunk).trim(), 10);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

    const result = await stopProcessTree(wrapper, exitPromise, {
      graceMs: 100,
      killWaitMs: 1_000,
    });

    assert.deepEqual(result, { forced: true, status: "stopped" });
    assert.equal(processExists(wrapper.pid), false);
    assert.equal(processExists(descendantPid), false);
  } finally {
    try {
      process.kill(-wrapper.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}
