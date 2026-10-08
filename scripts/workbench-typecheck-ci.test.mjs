import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  captureGitSourceSnapshot,
  createBaselineCleanGate,
  createNodeOptions,
  discoverWorkspaceInventory,
  parseConfiguration,
  parsePeakRssKiB,
} from "./workbench-typecheck-ci.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const typecheckScript = fileURLToPath(new URL("./workbench-typecheck-ci.mjs", import.meta.url));

test("defaults to two 4096 MiB passes and validates configured memory", () => {
  assert.deepEqual(
    parseConfiguration({ argv: [], env: {}, memoryLimitMiB: 16 * 1024 }),
    { heapMiB: 4096, passes: 2, requireCleanBaseline: false },
  );
  assert.deepEqual(
    parseConfiguration({
      argv: ["--passes=1"],
      env: { WORKBENCH_TYPECHECK_HEAP_MIB: "6144", WORKBENCH_TYPECHECK_PASSES: "3" },
      memoryLimitMiB: 16 * 1024,
    }),
    { heapMiB: 6144, passes: 1, requireCleanBaseline: false },
  );
  assert.equal(
    parseConfiguration({ argv: [], env: { CI: "true" }, memoryLimitMiB: 16 * 1024 }).requireCleanBaseline,
    true,
  );
  assert.equal(
    parseConfiguration({
      argv: [],
      env: { CI: "true", WORKBENCH_TYPECHECK_REQUIRE_CLEAN: "false" },
      memoryLimitMiB: 16 * 1024,
    }).requireCleanBaseline,
    true,
  );
  assert.throws(
    () => parseConfiguration({
      argv: [],
      env: { WORKBENCH_TYPECHECK_HEAP_MIB: "16384" },
      memoryLimitMiB: 16 * 1024,
    }),
    /must be below available memory/u,
  );
  assert.throws(
    () => parseConfiguration({ argv: ["--unknown"], env: {}, memoryLimitMiB: 16 * 1024 }),
    /Unknown typecheck option/u,
  );
});

test("preserves existing Node options while applying the configured heap", () => {
  assert.equal(
    createNodeOptions("--enable-source-maps", 4096),
    "--enable-source-maps --max-old-space-size=4096",
  );
  assert.equal(createNodeOptions(undefined, 4096), "--max-old-space-size=4096");
});

test("fails closed on a dirty CI baseline without blocking local drift checks", () => {
  assert.equal(createBaselineCleanGate({ dirty: true, required: true }).status, "FAIL");
  assert.equal(createBaselineCleanGate({ dirty: true, required: false }).status, "PASS");
  assert.equal(createBaselineCleanGate({ dirty: false, required: true }).status, "PASS");
});

test("parses GNU and Darwin peak RSS evidence into KiB", () => {
  assert.equal(parsePeakRssKiB("Maximum resident set size (kbytes): 123456\n", "linux"), 123456);
  assert.equal(parsePeakRssKiB("  10485760  maximum resident set size\n", "darwin"), 10240);
  assert.equal(parsePeakRssKiB("", "linux"), null);
});

test("derives the typecheck inventory from npm workspace package manifests", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-typecheck-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, "package.json"), {
    private: true,
    workspaces: ["packages/*", "!packages/excluded"],
  });
  await writeJson(path.join(root, "packages", "typed", "package.json"), {
    name: "@fixture/typed",
    scripts: { typecheck: "tsc --noEmit" },
  });
  await writeJson(path.join(root, "packages", "untyped", "package.json"), {
    name: "@fixture/untyped",
  });
  await writeJson(path.join(root, "packages", "excluded", "package.json"), {
    name: "@fixture/excluded",
    scripts: { typecheck: "false" },
  });

  const inventory = await discoverWorkspaceInventory(root);
  assert.deepEqual(inventory.workspaces.map((workspace) => workspace.name), [
    "@fixture/typed",
    "@fixture/untyped",
  ]);
  assert.deepEqual(inventory.typecheckWorkspaces.map((workspace) => workspace.name), ["@fixture/typed"]);
});

test("the repository inventory includes every current typecheck workspace", async () => {
  const inventory = await discoverWorkspaceInventory(repoRoot);
  assert.equal(inventory.workspaces.length, 17);
  assert.equal(inventory.typecheckWorkspaces.length, 15);
  assert(inventory.typecheckWorkspaces.some(({ name }) => name === "@workbench/workbench-contracts"));
  assert(inventory.typecheckWorkspaces.some(({ name }) => name === "@workbench/workbench-canvas-tools"));
  assert.deepEqual(
    inventory.workspaces.filter(({ typecheckCommand }) => typecheckCommand === null).map(({ name }) => name),
    ["@workbench/grist-auth-gateway", "@workbench/workbench-db"],
  );
});

test("source snapshots ignore ignored outputs and detect Git-visible drift", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-typecheck-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), "generated/\n");
  await writeFile(path.join(root, "source.txt"), "stable\n");
  await git(root, ["init", "--quiet"]);
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Typecheck Test", "-c", "user.email=typecheck@example.invalid", "commit", "--quiet", "-m", "fixture"]);

  const baseline = await captureGitSourceSnapshot(root);
  await mkdir(path.join(root, "generated"), { recursive: true });
  await writeFile(path.join(root, "generated", "output.txt"), "ignored\n");
  assert.equal((await captureGitSourceSnapshot(root)).digest, baseline.digest);

  await writeFile(path.join(root, "source.txt"), "drifted\n");
  assert.notEqual((await captureGitSourceSnapshot(root)).digest, baseline.digest);
});

test("the aggregate continues after a workspace failure and reports every target", {
  skip: process.platform === "win32",
}, async (t) => {
  const outerRoot = await mkdtemp(path.join(tmpdir(), "workbench-typecheck-cli-"));
  t.after(() => rm(outerRoot, { recursive: true, force: true }));
  const fixtureRoot = path.join(outerRoot, "repo");
  const binRoot = path.join(outerRoot, "bin");
  const npmLog = path.join(outerRoot, "npm.log");
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await writeJson(path.join(fixtureRoot, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
    scripts: { "workbench:prepare": "fixture" },
  });
  await writeJson(path.join(fixtureRoot, "packages", "fail", "package.json"), {
    name: "@fixture/fail",
    scripts: { typecheck: "fixture" },
  });
  await writeJson(path.join(fixtureRoot, "packages", "pass", "package.json"), {
    name: "@fixture/pass",
    scripts: { typecheck: "fixture" },
  });
  const fakeNpm = path.join(binRoot, "npm");
  await writeFile(fakeNpm, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$NPM_LOG\"",
    "sleep 0.1",
    "case \"$*\" in",
    "  *'@fixture/fail'*) exit 7 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  await chmod(fakeNpm, 0o755);
  await git(fixtureRoot, ["init", "--quiet"]);
  await git(fixtureRoot, ["add", "."]);
  await git(fixtureRoot, ["-c", "user.name=Typecheck Test", "-c", "user.email=typecheck@example.invalid", "commit", "--quiet", "-m", "fixture"]);

  let failure;
  try {
    await execFileAsync(process.execPath, [typecheckScript, "--passes=1"], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        NPM_LOG: npmLog,
        PATH: `${binRoot}${path.delimiter}${process.env.PATH}`,
        WORKBENCH_TYPECHECK_HEAP_MIB: "128",
      },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (error) {
    failure = error;
  }
  assert(failure, "the aggregate must fail when one workspace fails");
  assert.equal(failure.code, 1);
  const events = String(failure.stdout)
    .split("\n")
    .filter((line) => line.startsWith("TYPECHECK_RESULT "))
    .map((line) => JSON.parse(line.slice("TYPECHECK_RESULT ".length)));
  assert.deepEqual(events.map(({ target }) => target), [
    "workbench:prepare",
    "@fixture/fail",
    "@fixture/pass",
  ]);
  assert.equal(events.find(({ target }) => target === "@fixture/fail").exitCode, 7);
  assert.equal(events.find(({ target }) => target === "@fixture/pass").status, "PASS");
  assert(events.every(({ peakRssKiB }) => Number.isInteger(peakRssKiB) && peakRssKiB > 0));
  assert.match(String(failure.stdout), /TYPECHECK_SUMMARY .*"commandsFailed":1/u);
  assert.deepEqual((await readFile(npmLog, "utf8")).trim().split("\n"), [
    "run workbench:prepare",
    "--workspace @fixture/fail run typecheck",
    "--workspace @fixture/pass run typecheck",
  ]);
});

test("root typecheck scripts share the dynamic orchestrator", async () => {
  const packageData = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageData.scripts.typecheck, "node scripts/workbench-typecheck-ci.mjs --passes=1");
  assert.equal(packageData.scripts["typecheck:ci"], "node scripts/workbench-typecheck-ci.mjs");
  assert.match(packageData.scripts["dev:workbench:test"], /workbench-typecheck-ci\.test\.mjs/u);
});

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}
