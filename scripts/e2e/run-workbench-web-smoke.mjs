#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  managedWorkbenchWebDistDir,
  waitForWorkbenchWeb,
  warmWorkbenchProtectedRoutes,
} from "./workbench-web-startup.mjs";

const repoRoot = new URL("../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);
const webRootPath = path.join(repoRootPath, "apps/web");
const configuredOrigin = process.env.WORKBENCH_E2E_WEB_ORIGIN;
const managedWebPort = configuredOrigin ? null : await reservePort();
const origin = configuredOrigin ?? `http://127.0.0.1:${managedWebPort}`;
const previewOrigin = process.env.WORKBENCH_E2E_PREVIEW_ORIGIN ?? "http://127.0.0.1:4300";
const managedDistDir = managedWebPort === null
  ? null
  : managedWorkbenchWebDistDir(process.pid, managedWebPort);
const managedDistDirPath = managedDistDir === null
  ? null
  : path.join(webRootPath, managedDistDir);
const managedTsconfigRelativePath = managedDistDir === null
  ? null
  : `tsconfig.e2e-${process.pid}-${managedWebPort}.json`;
const managedTsconfigPath = managedTsconfigRelativePath === null
  ? null
  : path.join(webRootPath, managedTsconfigRelativePath);
const sourceTsconfigPath = path.join(webRootPath, "tsconfig.json");
const sourceNextEnvPath = path.join(webRootPath, "next-env.d.ts");
const sourceTsconfig = managedWebPort === null ? null : await readFile(sourceTsconfigPath);
const sourceNextEnv = managedWebPort === null ? null : await readFile(sourceNextEnvPath);

console.log("[fixture-browser] This lane intercepts auth, API, and SSE routes; it is not real-stack evidence.");

if (managedDistDirPath && managedTsconfigPath) {
  await mkdir(managedDistDirPath, { recursive: true });
  await writeFile(
    managedTsconfigPath,
    sourceTsconfig,
    "utf8",
  );
}

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
          WORKBENCH_E2E_EVIDENCE_LEVEL: "fixture",
          WORKBENCH_PREVIEW_ORIGIN: previewOrigin,
          WORKBENCH_NEXT_DIST_DIR: managedDistDir,
          WORKBENCH_NEXT_TSCONFIG_PATH: managedTsconfigRelativePath,
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

const serverExit = server
  ? new Promise((resolve) => {
      server.once("exit", (code, signal) => resolve({ code, signal }));
    })
  : null;

let cleanupPromise;
let signalHandled = false;
let completedSmokeCount = 0;
const cleanupManagedFiles = () => {
  cleanupPromise ??= (async () => {
    if (sourceTsconfig && sourceNextEnv) {
      await writeFile(sourceTsconfigPath, sourceTsconfig);
      await writeFile(sourceNextEnvPath, sourceNextEnv);
    }
    if (managedDistDirPath) {
      // Next/Turbopack can finish a filesystem write just after the dev
      // process exits. Retry recursive removal so a late cache entry cannot
      // turn an otherwise successful fixture run into a CI failure.
      await rm(managedDistDirPath, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      });
      try {
        await rmdir(path.dirname(managedDistDirPath));
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
      }
    }
    if (managedTsconfigPath) {
      await rm(managedTsconfigPath, { force: true });
    }
  })();
  return cleanupPromise;
};
const handleSignal = (signal) => {
  if (signalHandled) return;
  signalHandled = true;
  void (async () => {
    if (server && serverExit) await stopServer(server, serverExit);
    await cleanupManagedFiles();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  })();
};
process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

try {
  await waitForWorkbenchWeb(origin, serverExit);
  if (serverExit) {
    const warmedPaths = await warmWorkbenchProtectedRoutes(origin, serverExit);
    console.log(`Workbench Web E2E protected routes ready: ${warmedPaths.join(", ")}`);
  }
  await run("node", ["scripts/e2e/workbench-prd-remediation-smoke.mjs"]);
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
  if (completedSmokeCount === 0) throw new Error("No browser smoke test matched WORKBENCH_E2E_SMOKE_FILTER");
} finally {
  if (server && serverExit) await stopServer(server, serverExit);
  await cleanupManagedFiles();
}

async function run(command, args, environment = {}) {
  // A local diagnostic filter still uses the same isolated server lifecycle.
  const filter = process.env.WORKBENCH_E2E_SMOKE_FILTER;
  if (filter && !args.some((argument) => argument.includes(filter))) return;
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKBENCH_E2E_WEB_ORIGIN: origin,
      WORKBENCH_E2E_PREVIEW_ORIGIN: previewOrigin,
      WORKBENCH_E2E_EVIDENCE_LEVEL: "fixture",
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
  completedSmokeCount += 1;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
