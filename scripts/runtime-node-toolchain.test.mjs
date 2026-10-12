import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeNodePackageManagers } from "../deploy/remove-node-package-managers.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("runtime cleanup removes package installers and preserves installed application code", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-runtime-toolchain-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const removed = ["usr/local/lib/node_modules/npm/index.js", "usr/local/lib/node_modules/corepack/index.js", "opt/yarn-v1.22.22/index.js", "root/.npm/cache"];
  const preserved = ["usr/local/bin/node", "usr/local/bin/docker-entrypoint.sh", "app/node_modules/prisma/build/index.js", "opt/workbench/asset"];
  for (const name of [...removed, ...preserved]) {
    await mkdir(path.dirname(path.join(fixture, name)), { recursive: true });
    await writeFile(path.join(fixture, name), "retained application bytes");
  }
  for (const name of ["npm", "npx", "yarn", "yarnpkg", "corepack", "pnpm", "pnpx"]) {
    await symlink("node", path.join(fixture, "usr/local/bin", name));
  }
  removeNodePackageManagers(fixture);
  for (const name of removed) assert.equal(existsSync(path.join(fixture, name)), false, name);
  for (const name of preserved) assert.equal(await readFile(path.join(fixture, name), "utf8"), "retained application bytes", name);
  for (const name of ["npm", "npx", "yarn", "yarnpkg", "corepack", "pnpm", "pnpx"]) assert.equal(existsSync(path.join(fixture, "usr/local/bin", name)), false);
});

for (const placement of ["hoisted", "workspace"]) {
  test(`installed CLI launcher resolves ${placement} packages without npm and preserves arguments and workspace`, async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-installed-cli-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const workspace = path.join(fixture, "packages/application");
    const packageRoot = path.join(placement === "hoisted" ? fixture : workspace, "node_modules/test-cli");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "package.json"), '{"name":"application"}');
    await writeFile(path.join(packageRoot, "package.json"), '{"name":"test-cli","version":"1.0.0"}');
    await writeFile(path.join(packageRoot, "cli.cjs"), 'if(require.main !== module) throw new Error("CLI must execute as the main module"); console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),entry:process.argv[1]}))');
    const result = spawnSync(process.execPath, [path.join(root, "deploy/run-workspace-cli.mjs"), workspace, "test-cli/cli.cjs", "migrate", "deploy", "--schema", "prisma/schema.prisma"], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: realpathSync(workspace), args: ["migrate", "deploy", "--schema", "prisma/schema.prisma"], entry: realpathSync(path.join(packageRoot, "cli.cjs")) });
  });
}

test("CLI failures remain failures and container termination reaches the running server", { timeout: 10000 }, async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-cli-lifecycle-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, "node_modules/test-cli"), { recursive: true });
  await writeFile(path.join(fixture, "package.json"), '{"name":"application"}');
  await writeFile(path.join(fixture, "node_modules/test-cli/cli.cjs"), 'if(process.argv[2] === "fail") process.exit(17); process.on("SIGTERM",()=>{console.log("terminated");process.exit(0)}); setInterval(()=>{},1000); console.log("ready");');
  const args = [path.join(root, "deploy/run-workspace-cli.mjs"), fixture, "test-cli/cli.cjs"];
  assert.equal(spawnSync(process.execPath, [...args, "fail"], { encoding: "utf8" }).status, 17);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (value) => { output += value; });
  await once(child.stdout, "data");
  const completed = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await completed, [0, null]);
  assert.equal(output, "ready\nterminated\n");
});
