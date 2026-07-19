import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  npmArgsForService,
  WORKBENCH_DEV_SERVICES,
} from "./workbench-dev.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("root dev starts only the greenfield API, runtime worker, and Web", async () => {
  assert.deepEqual(
    WORKBENCH_DEV_SERVICES.map((service) => service.workspace),
    [
      "@workbench/workbench-api",
      "@workbench/workbench-worker",
      "@workbench/web",
    ],
  );
  assert.equal(WORKBENCH_DEV_SERVICES.some((service) => service.workspace === "@workbench/api"), false);

  for (const service of WORKBENCH_DEV_SERVICES) {
    assert.deepEqual(npmArgsForService(service), ["--workspace", service.workspace, "run", "dev"]);
  }

  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(rootPackage.scripts["dev:api"], undefined);
  assert.match(rootPackage.scripts.dev, /workbench:prepare/u);
  assert.match(rootPackage.scripts.dev, /scripts\/workbench-dev\.mjs/u);
  assert.doesNotMatch(rootPackage.scripts.dev, /@workbench\/api|dev:api/u);
});
