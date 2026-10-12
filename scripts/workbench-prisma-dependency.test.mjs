import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadConfigFromFile } from "@prisma/config";

// Resolve through the actual consumer so a nested vulnerable copy cannot pass.
const requireFromPrisma = createRequire(import.meta.resolve("@prisma/config"));
const merge = await import(pathToFileURL(requireFromPrisma.resolve("deepmerge-ts")).href);

test("Prisma's merge implementation handles recursive records without exhausting the stack", { timeout: 5_000 }, () => {
  for (const fn of [merge.deepmerge, merge.deepmergeCustom({})]) {
    const left = { left: true }; left.self = left;
    const right = { right: true }; right.self = right;
    const result = fn(left, right);
    assert.equal(result.self, result);
    assert.equal(result.left, true);
    assert.equal(result.right, true);
    assert.equal(left.self, left);
    assert.equal(right.self, right);
  }
  for (const fn of [merge.deepmergeInto, merge.deepmergeIntoCustom({})]) {
    const target = { left: true }; target.self = target;
    const source = { right: true }; source.self = source;
    fn(target, source);
    assert.equal(target.self, target);
    assert.equal(target.left, true);
    assert.equal(target.right, true);
    assert.deepEqual(Object.keys(source).sort(), ["right", "self"]);
    assert.equal(source.self, source);
  }
});

test("plain nested Prisma configuration retains arrays and defined values without mutating inputs", () => {
  const first = { schema: "schema.prisma", migrations: { path: "migrations" }, include: ["one"], options: { enabled: true } };
  const second = { schema: undefined, migrations: { seed: "node seed.mjs" }, include: ["two"] };
  const before = structuredClone(first);
  assert.deepEqual(merge.deepmerge(first, second), {
    schema: "schema.prisma", migrations: { path: "migrations", seed: "node seed.mjs" },
    include: ["one", "two"], options: { enabled: true },
  });
  assert.deepEqual(first, before);
});

test("the installed Prisma loader reads a real TypeScript config using its upgraded c12 merger", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "workbench-prisma-config-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "prisma.config.ts"), `export default {
    schema: './schema.prisma',
    migrations: { path: './migrations', seed: 'node seed.mjs' },
    engine: 'classic',
    datasource: { url: 'postgresql://fixture@127.0.0.1:1/isolated_fixture' },
  };\n`);
  const result = await loadConfigFromFile({ configRoot: directory });
  assert.equal(result.error, undefined, result.error?._tag);
  assert.equal(result.config.schema, path.join(directory, "schema.prisma"));
  assert.equal(result.config.migrations.path, path.join(directory, "migrations"));
  assert.equal(result.config.migrations.seed, "node seed.mjs");
  assert.equal(result.config.datasource.url, "postgresql://fixture@127.0.0.1:1/isolated_fixture");
});
