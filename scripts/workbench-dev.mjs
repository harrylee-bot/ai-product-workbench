import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export const WORKBENCH_DEV_SERVICES = Object.freeze([
  Object.freeze({ name: "api", workspace: "@workbench/workbench-api" }),
  Object.freeze({ name: "runtime-worker", workspace: "@workbench/workbench-worker" }),
  Object.freeze({ name: "web", workspace: "@workbench/web" }),
]);

export function npmArgsForService(service) {
  return ["--workspace", service.workspace, "run", "dev"];
}

export function loadLocalEnvironment(root = repoRoot) {
  // Loading .env.local first gives it precedence because loadEnvFile preserves
  // values already present in process.env.
  for (const filename of [".env.local", ".env"]) {
    const envPath = path.join(root, filename);
    if (existsSync(envPath)) loadEnvFile(envPath);
  }
}

export function runWorkbenchDev({
  root = repoRoot,
  spawnProcess = spawn,
} = {}) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const children = new Map();
  let remaining = WORKBENCH_DEV_SERVICES.length;
  let shuttingDown = false;
  let exitCode = 0;
  let forceTimer;

  return new Promise((resolve) => {
    const finish = () => {
      if (remaining !== 0) return;
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(exitCode);
    };

    const shutdown = (code, signal, failedService) => {
      if (shuttingDown) return;
      shuttingDown = true;
      exitCode = code;
      if (failedService) {
        console.error(`[dev] ${failedService} stopped; shutting down the remaining Workbench services.`);
      }
      for (const child of children.values()) {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      }
      forceTimer = setTimeout(() => {
        for (const child of children.values()) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      }, 5_000);
      forceTimer.unref();
    };

    const onSigint = () => shutdown(130, "SIGINT");
    const onSigterm = () => shutdown(143, "SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    for (const service of WORKBENCH_DEV_SERVICES) {
      const child = spawnProcess(npmCommand, npmArgsForService(service), {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      });
      children.set(service.name, child);
      child.once("error", (error) => {
        console.error(`[dev] failed to start ${service.name}:`, error);
        shutdown(1, "SIGTERM", service.name);
      });
      child.once("close", (code) => {
        remaining -= 1;
        if (!shuttingDown) shutdown(code && code > 0 ? code : 1, "SIGTERM", service.name);
        finish();
      });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  loadLocalEnvironment();
  process.exitCode = await runWorkbenchDev();
}
