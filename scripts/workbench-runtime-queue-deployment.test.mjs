import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const root = new URL("../", import.meta.url);

test("Runtime provider-state PostgreSQL tests activate only after their dedicated migration", async () => {
  const workflow = YAML.parse(await readFile(new URL(".github/workflows/workbench-ci.yml", root), "utf8"));
  const key = "WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL";
  const quality = workflow.jobs.quality;
  const integration = quality.steps.find((step) => step.name === "Run Runtime provider-state PostgreSQL integration");
  assert.equal(workflow.env?.[key], undefined);
  assert.equal(quality.env?.[key], undefined);
  assert.equal(integration?.env?.[key],
    "postgresql://postgres:postgres@127.0.0.1:${{ job.services.postgres.ports[5432] }}/workbench_test?schema=runtime_provider_state_test");
  assert(quality.steps.indexOf(integration) > quality.steps.findIndex((step) => step.run === "npm test"));
  assert.match(integration.run,
    /WORKBENCH_DATABASE_URL="\$WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL"[\s\S]+migrate:deploy[\s\S]+workbench-worker run test:postgres/u);
  for (const step of quality.steps.filter((step) => step !== integration)) {
    assert(!JSON.stringify(step).includes(key), "the Runtime integration switch must not leak through GITHUB_ENV into ordinary tests");
  }
  assert(!JSON.stringify(workflow.jobs["real-stack-browser"]).includes(key), "the browser job must not enable unrelated Runtime integration tests");
  const adminKey = "WORKBENCH_POSTGRES_ADMIN_URL";
  const provision = quality.steps.find((step) => step.name === "Provision database extensions as CI infrastructure admin");
  assert.equal(workflow.env?.[adminKey], undefined);
  assert.equal(quality.env?.[adminKey], undefined);
  assert.equal(provision?.env?.[adminKey],
    "postgresql://postgres:postgres@127.0.0.1:${{ job.services.postgres.ports[5432] }}/workbench_test");
  for (const step of quality.steps.filter((step) => step !== provision)) {
    assert(!JSON.stringify(step).includes(adminKey), "quality admin credentials must not activate database-role integration tests during npm test");
  }
  assert(workflow.jobs["real-stack-browser"].steps.some((step) => step.run?.includes(adminKey)),
    "the browser job must keep its existing database administration scope");
});

test("the migrator reconciles Runtime queues before services start", async () => {
  const [
    dockerfile,
    migrate,
    compose,
    envExample,
    apiQueue,
    runtimeWorker,
    importWorker,
    exportWorker,
    fileWorker,
    workflowSource,
    postgresHttpE2e,
    fileWorkerPostgres,
  ] = await Promise.all([
    readFile(new URL("apps/workbench-api/Dockerfile", root), "utf8"),
    readFile(new URL("deploy/workbench-migrate.sh", root), "utf8"),
    readFile(new URL("deploy/workbench-compose.yml", root), "utf8"),
    readFile(new URL("deploy/workbench.env.example", root), "utf8"),
    readFile(new URL("apps/workbench-api/src/platform/queue/workbench-queue.service.ts", root), "utf8"),
    readFile(new URL("apps/workbench-worker/src/main.ts", root), "utf8"),
    readFile(new URL("apps/workbench-import-worker/src/main.ts", root), "utf8"),
    readFile(new URL("apps/workbench-export-worker/src/main.ts", root), "utf8"),
    readFile(new URL("apps/workbench-file-worker/src/main.ts", root), "utf8"),
    readFile(new URL(".github/workflows/workbench-ci.yml", root), "utf8"),
    readFile(new URL("scripts/workbench-postgres-http-e2e.mjs", root), "utf8"),
    readFile(new URL("scripts/workbench-file-worker-postgres-integration.mjs", root), "utf8"),
  ]);

  assert.match(dockerfile, /COPY scripts\/reconcile-workbench-runtime-queues\.mjs/u);
  assert.ok(
    migrate.indexOf("prisma/build/index.js migrate deploy") >= 0
      && migrate.indexOf("prisma/build/index.js migrate deploy") < migrate.indexOf("reconcile-workbench-runtime-queues.mjs"),
    "Prisma migrations must complete before queue reconciliation",
  );
  assert.match(
    compose,
    /WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE: \$\{WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE:-0\}/u,
  );
  assert.match(envExample, /^WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=0$/mu);
  for (const source of [apiQueue, runtimeWorker, importWorker, exportWorker, fileWorker]) {
    assert.match(source, /migrate: false/u);
    assert.match(source, /createSchema: false/u);
  }
  assert.match(compose, /WORKBENCH_MIGRATOR_DATABASE_URL/u);
  assert.match(compose, /WORKBENCH_POSTGRES_ADMIN_URL/u);

  const workflow = YAML.parse(workflowSource);
  const qualitySteps = workflow.jobs?.quality?.steps ?? [];
  const reconcileIndex = qualitySteps.findIndex((step) => step.name === "Reconcile runtime queue schema and policies");
  const testIndex = qualitySteps.findIndex((step) => step.run === "npm test");
  assert.ok(reconcileIndex >= 0, "CI quality must reconcile queues through the production migrator entrypoint");
  assert.ok(testIndex >= 0 && reconcileIndex < testIndex, "CI queue reconciliation must complete before npm test");
  assert.equal(qualitySteps[reconcileIndex].run, "sh deploy/workbench-migrate.sh");
  assert.equal(
    qualitySteps[reconcileIndex].env?.WORKBENCH_MIGRATOR_DATABASE_URL,
    "${{ env.WORKBENCH_DATABASE_URL }}",
  );
  const fileWorkerPostgresStep = qualitySteps.find(
    (step) => step.name === "Run candidate-bound File Worker PostgreSQL integration",
  );
  assert.ok(fileWorkerPostgresStep, "CI quality must run the File Worker PostgreSQL integration");
  assert.equal(
    fileWorkerPostgresStep.run,
    "npm --workspace @workbench/workbench-file-worker run test:postgres",
  );
  assert.equal(
    fileWorkerPostgresStep.env?.WORKBENCH_SCHEMA_RESET_CONFIRM,
    "workbench_test",
    "the destructive integration reset must be explicitly bound to the CI test database",
  );
  const realStackBrowser = workflow.jobs?.["real-stack-browser"];
  assert(realStackBrowser, "CI must include an isolated real-stack browser lane");
  assert.deepEqual(realStackBrowser.needs, ["quality"]);
  assert.equal(realStackBrowser.permissions?.contents, "read");
  assert.equal(
    realStackBrowser.env?.WORKBENCH_E2E_CONTROLLED_PROVIDER,
    "controlled-local-deerflow",
    "real-stack browser must declare the controlled provider evidence level",
  );
  assert.equal(realStackBrowser.env?.WORKBENCH_E2E_REAL_STACK_BROWSER_ONLY, "1");
  assert.equal(realStackBrowser.env?.WORKBENCH_E2E_RECOVERY_TIMEOUT_MS, "360000");
  const realStackPrepareIndex = realStackBrowser.steps?.findIndex(
    (step) => step.name === "Prepare contracts and generated clients",
  );
  assert.ok(realStackPrepareIndex >= 0, "real-stack browser must prepare shared Workbench packages");
  const realStackRun = realStackBrowser.steps?.find((step) => step.name === "Run real-stack browser-only smoke");
  const realStackRunIndex = realStackBrowser.steps?.findIndex(
    (step) => step.name === "Run real-stack browser-only smoke",
  );
  const chromiumInstallIndex = realStackBrowser.steps?.findIndex(
    (step) => step.name === "Install Chromium runtime",
  );
  const viewportTestIndex = realStackBrowser.steps?.findIndex(
    (step) => step.name === "Test browser viewport stabilization",
  );
  assert.ok(
    realStackRunIndex > realStackPrepareIndex,
    "real-stack browser preparation must finish before browser smoke",
  );
  assert.ok(chromiumInstallIndex >= 0, "real-stack browser must install Chromium before browser tests");
  assert.ok(
    viewportTestIndex > chromiumInstallIndex && viewportTestIndex < realStackRunIndex,
    "viewport stabilization regression must run after Chromium installation and before browser smoke",
  );
  assert.equal(
    realStackBrowser.steps?.[viewportTestIndex]?.run,
    "node --test scripts/e2e/workbench-browser-viewport.test.mjs scripts/e2e/workbench-browser-motion.test.mjs",
  );
  assert.equal(realStackBrowser.steps?.[realStackPrepareIndex]?.run, "npm run workbench:prepare");
  assert.equal(realStackRun?.run, "npm run e2e:web:real-stack:browser-only");
  assert.match(postgresHttpE2e, /WORKBENCH_E2E_RECOVERY_TIMEOUT_MS/u);
  for (const [name, source] of [
    ["PostgreSQL HTTP E2E", postgresHttpE2e],
    ["File Worker PostgreSQL integration", fileWorkerPostgres],
  ]) {
    assert.match(
      source,
      /async function migrateDatabase\(\) \{[\s\S]{0,1200}deploy\/workbench-migrate\.sh/u,
      `${name} must initialize pg-boss through the production migrator entrypoint`,
    );
  }
});
