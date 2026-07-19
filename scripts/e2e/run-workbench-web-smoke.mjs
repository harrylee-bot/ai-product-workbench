#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";

const repoRoot = new URL("../../", import.meta.url);
const configuredOrigin = process.env.WORKBENCH_E2E_WEB_ORIGIN;
const existingDevOrigin = configuredOrigin ? null : await activeProjectDevOrigin();
const managedWebPort = configuredOrigin || existingDevOrigin ? null : await reservePort();
const origin = configuredOrigin ?? existingDevOrigin ?? `http://127.0.0.1:${managedWebPort}`;
const previewOrigin = process.env.WORKBENCH_E2E_PREVIEW_ORIGIN ?? "http://127.0.0.1:4300";
const server = managedWebPort === null
  ? null
  : spawn(
      "npm",
      [
        "--workspace",
        "@workbench/web",
        "exec",
        "--",
        "next",
        "dev",
        "--turbo",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(managedWebPort),
      ],
      {
        cwd: repoRoot,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          WORKBENCH_E2E_WEB_ORIGIN: origin,
          WORKBENCH_E2E_PREVIEW_ORIGIN: previewOrigin,
          WORKBENCH_PREVIEW_ORIGIN: previewOrigin,
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

const serverExit = server
  ? new Promise((resolve) => {
      server.once("exit", (code, signal) => resolve({ code, signal }));
    })
  : null;

try {
  await waitForServer(origin, serverExit);
  await run("node", ["scripts/e2e/workbench-run-preview-smoke.mjs"]);
  await run("node", ["scripts/e2e/workbench-approval-preferences-smoke.mjs"]);
  await run("node", ["scripts/e2e/workbench-board-tools-smoke.mjs"]);
  for (const browserName of ["chromium", "firefox", "webkit"]) {
    await run(
      "node",
      ["scripts/e2e/workbench-navigation-guard-smoke.mjs"],
      { WORKBENCH_E2E_BROWSER: browserName },
    );
  }
  await run("node", ["scripts/e2e/workbench-design-system-import-smoke.mjs"]);
  await run("node", ["scripts/e2e/workbench-export-recovery-smoke.mjs"]);
  await run("node", ["scripts/e2e/workbench-isolated-preview-smoke.mjs"]);
} finally {
  if (server && serverExit) await stopServer(server, serverExit);
}

async function waitForServer(baseUrl, exitPromise) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const probes = [
      fetch(`${baseUrl}/login`, { redirect: "manual" })
        .then((response) => ({ kind: "response", response }))
        .catch(() => ({ kind: "retry" })),
    ];
    if (exitPromise) {
      probes.push(exitPromise.then((result) => ({ kind: "exit", result })));
    }
    const state = await Promise.race(probes);
    if (state.kind === "exit") {
      throw new Error(`Workbench Web exited before E2E startup: ${JSON.stringify(state.result)}`);
    }
    if (state.kind === "response" && state.response.status < 500) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for Workbench Web at ${baseUrl}`);
}

async function run(command, args, environment = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKBENCH_E2E_WEB_ORIGIN: origin,
      WORKBENCH_E2E_PREVIEW_ORIGIN: previewOrigin,
      ...environment,
    },
    stdio: "inherit",
  });
  const result = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${JSON.stringify(result)}`);
  }
}

async function stopServer(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child, "SIGTERM");
  const result = await Promise.race([
    exitPromise,
    delay(5_000).then(() => null),
  ]);
  if (result === null && child.exitCode === null && child.signalCode === null) {
    signalProcessGroup(child, "SIGKILL");
    await exitPromise;
  }
}

function signalProcessGroup(child, signal) {
  if (process.platform === "win32") child.kill(signal);
  else process.kill(-child.pid, signal);
}

async function reservePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    listener.close();
    throw new Error("Unable to reserve a Workbench Web E2E port");
  }
  await new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function activeProjectDevOrigin() {
  try {
    const lock = JSON.parse(await readFile(
      new URL("apps/web/.next/dev/lock", repoRoot),
      "utf8",
    ));
    if (!Number.isInteger(lock.pid) || typeof lock.appUrl !== "string") return null;
    process.kill(lock.pid, 0);
    const response = await fetch(`${lock.appUrl}/login`, { redirect: "manual" });
    if (response.status >= 500) return null;
    return lock.appUrl;
  } catch {
    return null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
