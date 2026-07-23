import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./assert-runtime-provider-state-test-database.mjs", import.meta.url));
const shared = "postgresql://runtime:secret@127.0.0.1:5432/workbench_test?schema=workbench";

test("accepts a test schema isolated from the shared PostgreSQL target", () => {
  const result = run({
    WORKBENCH_TEST_DATABASE_URL: shared,
    WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL:
      "postgresql://runtime:secret@127.0.0.1:5432/workbench_test?schema=runtime_provider_state_test",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workbench_test\/runtime_provider_state_test/u);
  assert.doesNotMatch(result.stdout, /secret/u);
});

test("rejects the shared target and targets without a test identity", () => {
  const sharedResult = run({
    WORKBENCH_TEST_DATABASE_URL: shared,
    WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL: shared,
  });
  assert.notEqual(sharedResult.status, 0);
  assert.match(sharedResult.stderr, /RUNTIME_PROVIDER_STATE_TEST_DATABASE_NOT_ISOLATED/u);

  const productionResult = run({
    WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL:
      "postgresql://runtime:secret@127.0.0.1:5432/workbench?schema=workbench",
  });
  assert.notEqual(productionResult.status, 0);
  assert.match(productionResult.stderr, /isolated test database or schema/u);
});

function run(environment) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });
}
