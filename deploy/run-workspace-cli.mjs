#!/usr/bin/env node

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";

const [workspace, moduleName, ...args] = process.argv.slice(2);
if (!workspace || !moduleName) throw new Error("workspace and installed CLI module are required");
const directory = path.resolve(workspace);
const cli = createRequire(path.join(directory, "package.json")).resolve(moduleName);
// Run as the main module: Prisma intentionally does nothing when imported.
const child = spawn(process.execPath, [cli, ...args], { cwd: directory, stdio: "inherit" });
const signals = new Map(["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => [signal, () => child.kill(signal)]));
for (const [signal, forward] of signals) process.on(signal, forward);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  for (const [name, forward] of signals) process.removeListener(name, forward);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
