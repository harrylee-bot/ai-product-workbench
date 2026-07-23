import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("launch configuration references only repository-owned npm scripts", async () => {
  const [launch, packageJson] = await Promise.all([
    readJson(".claude/launch.json"),
    readJson("package.json"),
  ]);
  assert.equal(launch.version, "0.0.1");
  assert.deepEqual(
    launch.configurations.map((entry) => entry.name),
    ["web", "api"],
  );

  for (const entry of launch.configurations) {
    assert.equal(entry.runtimeExecutable, "npm");
    assert.equal(entry.runtimeArgs[0], "run");
    assert.equal(typeof packageJson.scripts[entry.runtimeArgs[1]], "string");
    if (entry.cwd === undefined) continue;
    const resolved = path.resolve(root, entry.cwd);
    assert.equal(
      resolved === root || resolved.startsWith(`${root}${path.sep}`),
      true,
      `launch cwd escapes the repository: ${entry.name}`,
    );
  }
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
