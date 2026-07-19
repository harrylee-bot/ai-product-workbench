import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  WORKBENCH_RUNTIME_TOOL_NAMES,
  WORKBENCH_RUNTIME_TOOLS,
  WORKBENCH_TOOL_GROUP,
} from "./deerflow-workbench-tool-contract.mjs";

const scriptPath = fileURLToPath(new URL("./merge-deerflow-config.mjs", import.meta.url));

test("merges the canonical Workbench entries without replacing DeerFlow configuration", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const result = runMerge(fixture);
  assert.equal(result.status, 0, result.stderr);
  const merged = YAML.parse(await readFile(fixture.outputPath, "utf8"));
  assert.equal(merged.models[0].name, "primary");
  assert.deepEqual(merged.tool_groups.map(({ name }) => name), ["web", "workbench"]);
  assert.deepEqual(merged.tools.map(({ name }) => name), [
    "web_search",
    ...WORKBENCH_RUNTIME_TOOL_NAMES,
  ]);
  assert.equal((await stat(fixture.outputPath)).mode & 0o777, 0o600);

  const check = runMerge(fixture, ["--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, "current");
});

test("is idempotent when the exact entries already exist", async (t) => {
  const fixture = await createFixture({ includeWorkbench: true });
  t.after(fixture.cleanup);

  const result = runMerge(fixture);
  assert.equal(result.status, 0, result.stderr);
  const merged = YAML.parse(await readFile(fixture.outputPath, "utf8"));
  assert.equal(merged.tool_groups.filter(({ name }) => name === "workbench").length, 1);
  for (const name of WORKBENCH_RUNTIME_TOOL_NAMES) {
    assert.equal(merged.tools.filter((tool) => tool.name === name).length, 1, name);
  }
});

for (const conflictingToolName of ["workbench_knowledge_retrieve", "rename_screen"]) {
  test(`fails closed on a same-name conflicting tool: ${conflictingToolName}`, async (t) => {
    const fixture = await createFixture({ conflictingToolName });
    t.after(fixture.cleanup);

    const result = runMerge(fixture);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`DEERFLOW_CONFIG_NAME_CONFLICT:tools:${conflictingToolName}`),
    );
    await assert.rejects(readFile(fixture.outputPath), { code: "ENOENT" });
  });
}

for (const [invalidFragment, article] of [["missing", "a"], ["extra", "an"]]) {
  test(`rejects ${article} ${invalidFragment} canonical Workbench tool`, async (t) => {
    const fixture = await createFixture({ invalidFragment });
    t.after(fixture.cleanup);

    const result = runMerge(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DEERFLOW_CONFIG_FRAGMENT_WORKBENCH_TOOL_INVALID/);
    await assert.rejects(readFile(fixture.outputPath), { code: "ENOENT" });
  });
}

test("rejects fragment fields outside tool_groups and tools", async (t) => {
  const fixture = await createFixture({ extraFragmentKey: true });
  t.after(fixture.cleanup);

  const result = runMerge(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEERFLOW_CONFIG_FRAGMENT_KEYS_INVALID/);
});

test("check mode rejects stale or overly broad output permissions", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  await writeFile(fixture.outputPath, "stale: true\n", { mode: 0o600 });
  let result = runMerge(fixture, ["--check"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEERFLOW_EFFECTIVE_CONFIG_STALE/);

  assert.equal(runMerge(fixture).status, 0);
  await chmod(fixture.outputPath, 0o644);
  result = runMerge(fixture, ["--check"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEERFLOW_EFFECTIVE_CONFIG_MODE_INVALID/);
});

async function createFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-deerflow-config-"));
  const basePath = path.join(root, "config.yaml");
  const fragmentPath = path.join(root, "fragment.yaml");
  const outputPath = path.join(root, "effective.yaml");
  const workbenchGroup = structuredClone(WORKBENCH_TOOL_GROUP);
  const canonicalTools = structuredClone(WORKBENCH_RUNTIME_TOOLS);
  const baseWorkbenchTools = canonicalTools.map((tool) => (
    tool.name === options.conflictingToolName
      ? { ...tool, use: "untrusted.module:tool" }
      : tool
  ));
  const fragmentTools = canonicalTools
    .filter((tool) => options.invalidFragment !== "missing" || tool.name !== "navigate_canvas");
  if (options.invalidFragment === "extra") {
    fragmentTools.push({
      name: "untrusted_extra_tool",
      group: "workbench",
      use: "untrusted.module:tool",
    });
  }
  const base = {
    models: [{ name: "primary", use: "provider:model" }],
    sandbox: { use: "provider:sandbox" },
    tool_groups: [{ name: "web" }, ...(options.includeWorkbench || options.conflictingToolName ? [workbenchGroup] : [])],
    tools: [
      { name: "web_search", group: "web", use: "provider:web_search" },
      ...(options.includeWorkbench || options.conflictingToolName
        ? baseWorkbenchTools
        : []),
    ],
  };
  const fragment = {
    tool_groups: [workbenchGroup],
    tools: fragmentTools,
    ...(options.extraFragmentKey ? { models: [] } : {}),
  };
  await Promise.all([
    writeFile(basePath, YAML.stringify(base), "utf8"),
    writeFile(fragmentPath, YAML.stringify(fragment), "utf8"),
  ]);
  return {
    basePath,
    fragmentPath,
    outputPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function runMerge(fixture, extraArgs = []) {
  return spawnSync(process.execPath, [
    scriptPath,
    "--base", fixture.basePath,
    "--fragment", fixture.fragmentPath,
    "--output", fixture.outputPath,
    ...extraArgs,
  ], { encoding: "utf8" });
}
