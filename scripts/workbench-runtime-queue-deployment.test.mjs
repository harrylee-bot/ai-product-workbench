import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the migrator reconciles Runtime queues before services start", async () => {
  const [dockerfile, migrate, compose, envExample] = await Promise.all([
    readFile(new URL("apps/workbench-api/Dockerfile", root), "utf8"),
    readFile(new URL("deploy/workbench-migrate.sh", root), "utf8"),
    readFile(new URL("deploy/workbench-compose.yml", root), "utf8"),
    readFile(new URL("deploy/workbench.env.example", root), "utf8"),
  ]);

  assert.match(dockerfile, /COPY scripts\/reconcile-workbench-runtime-queues\.mjs/u);
  assert.ok(
    migrate.indexOf("migrate:deploy") < migrate.indexOf("reconcile-workbench-runtime-queues.mjs"),
    "Prisma migrations must complete before queue reconciliation",
  );
  assert.match(
    compose,
    /WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE: \$\{WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE:-0\}/u,
  );
  assert.match(envExample, /^WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=0$/mu);
});
