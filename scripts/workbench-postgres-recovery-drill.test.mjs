import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  RecoveryDrillError,
  assertReceiptContainsNoSecrets,
  parseTableInventory,
  performRecoveryDrill,
  prepareRecoveryPlan,
  recoveryPlanDocument,
  sealRecoveryDrillReceipt,
  validateExecutionEnvironment,
  validateRecoveryDrillReceiptSeal,
  verifyRepositoryBinding,
  writeRecoveryDrillReceipt,
} from "./workbench-postgres-recovery-drill.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "scripts/workbench-postgres-recovery-drill.mjs");
const sourceCommit = "1".repeat(40);
const candidateId = `sha256:${"2".repeat(64)}`;

test("quality runs and hashes the real isolated PostgreSQL recovery regression", async () => {
  const packageData = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    packageData.scripts["g5:postgres-recovery:test"],
    "node --test scripts/workbench-postgres-recovery-drill.test.mjs scripts/workbench-postgres-recovery-drill.postgres.test.mjs",
  );
  const workflow = YAML.parse(await readFile(
    path.join(repoRoot, ".github/workflows/workbench-ci.yml"),
    "utf8",
  ));
  const quality = workflow.jobs.quality;
  const recovery = quality.steps.find((step) => step.id === "postgres_recovery");
  assert.equal(
    recovery.env.WORKBENCH_G5_DRILL_TEST_ADMIN_URL,
    "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
  );
  assert.match(recovery.run, /npm run g5:postgres-recovery:test 2>&1 \| tee/u);
  assert.match(recovery.run, /sha256sum .*postgres-recovery\.log/u);
  const upload = quality.steps.find((step) => step.name === "Upload isolated PostgreSQL recovery evidence");
  assert.match(upload.if, /always\(\).*steps\.postgres_recovery\.outcome != 'skipped'/u);
  assert.equal(upload.with["if-no-files-found"], "error");

  assert.equal(
    packageData.scripts["runtime:provider-state:migration-upgrade:test"],
    "node --test scripts/workbench-runtime-migration-upgrade.postgres.test.mjs",
  );
  assert.match(
    packageData.scripts["remediation:runtime:baseline:test"],
    /workbench-postgres-recovery-drill\.test\.mjs/u,
  );
  const upgrade = quality.steps.find((step) => step.id === "runtime_migration_upgrade");
  assert.equal(
    upgrade.env.WORKBENCH_RUNTIME_MIGRATION_UPGRADE_TEST_ADMIN_URL,
    "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
  );
  assert.match(upgrade.run, /npm run runtime:provider-state:migration-upgrade:test 2>&1 \| tee/u);
  assert.match(upgrade.run, /sha256sum .*runtime-migration-upgrade\.log/u);
  const upgradeUpload = quality.steps.find((step) => step.name === "Upload Runtime migration upgrade evidence");
  assert.match(upgradeUpload.if, /always\(\).*steps\.runtime_migration_upgrade\.outcome != 'skipped'/u);
  assert.equal(upgradeUpload.with["if-no-files-found"], "error");
});

test("plan mode performs no database or Git commands and needs no secrets", async (t) => {
  const fixture = await outputFixture(t);
  const options = validArguments(fixture.output);
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...options], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: "/path-with-no-postgres-or-git-tools",
    },
  });
  assert.equal(stderr, "");
  const plan = JSON.parse(stdout);
  assert.equal(plan.mode, "PLAN");
  assert.equal(plan.executionRequested, false);
  assert.equal(plan.candidate.migrationCount, 68);
  assert.match(plan.requiredConfirmation, /^G5-RECOVERY-DRILL:/u);
  await assert.rejects(stat(fixture.output), { code: "ENOENT" });
});

test("rejects protected, production, ambiguous, and same database names", async (t) => {
  const fixture = await outputFixture(t);
  for (const [field, value, code, extraOverrides] of [
    ["sourceDatabase", "postgres", "PROTECTED_DATABASE_REJECTED"],
    ["sourceDatabase", "workbench_prod_test", "PRODUCTION_DATABASE_REJECTED"],
    ["sourceDatabase", "workbench_source", "ISOLATED_DATABASE_NAME_REQUIRED"],
    ["restoreDatabase", "workbench_restore", "RESTORE_DATABASE_CONFIRMATION_INVALID", {
      confirmRestoreDatabase: "workbench_g5_restore_test",
    }],
  ]) {
    await assertRejectsCode(
      prepareRecoveryPlan(validOptions(fixture.output, { [field]: value, ...(extraOverrides ?? {}) })),
      code,
    );
  }
  await assertRejectsCode(prepareRecoveryPlan(validOptions(fixture.output, {
    sourceDatabase: "workbench_g5_test",
    restoreDatabase: "workbench_g5_test",
    confirmRestoreDatabase: "workbench_g5_test",
  })), "DATABASES_MUST_DIFFER");
});

test("rejects URL database mismatch, cross-server admin URL, and invalid confirmation", async (t) => {
  const fixture = await outputFixture(t);
  const plan = await prepareRecoveryPlan(validOptions(fixture.output));
  const validEnvironment = executionEnvironment(plan);

  assert.throws(() => validateExecutionEnvironment(plan, {
    ...validEnvironment,
    WORKBENCH_G5_DRILL_CONFIRM: "wrong-confirmation",
  }), hasCode("EXECUTION_CONFIRMATION_INVALID"));
  assert.throws(() => validateExecutionEnvironment(plan, {
    ...validEnvironment,
    WORKBENCH_G5_SOURCE_DATABASE_URL: "postgresql://backup:secret@127.0.0.1:5432/another_g5_test?schema=workbench",
  }), hasCode("SOURCE_DATABASE_URL_MISMATCH"));
  assert.throws(() => validateExecutionEnvironment(plan, {
    ...validEnvironment,
    WORKBENCH_G5_ADMIN_DATABASE_URL: "postgresql://admin:secret@127.0.0.2:5432/postgres",
  }), hasCode("DATABASE_SERVER_MISMATCH"));
  assert.throws(() => validateExecutionEnvironment(plan, {
    ...validEnvironment,
    WORKBENCH_G5_SOURCE_DATABASE_URL: "postgresql://backup:secret@127.0.0.1:5432/workbench_g5_source_test",
  }), hasCode("SOURCE_SCHEMA_INVALID"));
  assert.throws(() => validateExecutionEnvironment(plan, {
    ...validEnvironment,
    WORKBENCH_G5_ADMIN_DATABASE_URL: "postgresql://admin:secret@127.0.0.1:5432/postgres?service=unexpected",
  }), hasCode("DATABASE_URL_PARAMETER_UNSUPPORTED"));
  assert.throws(() => validateExecutionEnvironment(plan, {
    ...validEnvironment,
    WORKBENCH_G5_DRILL_CONFIRM: "",
  }), hasCode("EXECUTION_ENVIRONMENT_REQUIRED"));
});

test("rejects a pre-existing receipt or checksum sidecar", async (t) => {
  const fixture = await outputFixture(t);
  await writeFile(fixture.output, "existing\n", { mode: 0o600 });
  await assertRejectsCode(
    prepareRecoveryPlan(validOptions(fixture.output)),
    "OUTPUT_ALREADY_EXISTS",
  );
  await rm(fixture.output);
  await writeFile(`${fixture.output}.sha256`, "existing\n", { mode: 0o600 });
  await assertRejectsCode(
    prepareRecoveryPlan(validOptions(fixture.output)),
    "OUTPUT_ALREADY_EXISTS",
  );
});

test("requires evidence output outside the repository", async () => {
  await assertRejectsCode(prepareRecoveryPlan(validOptions(
    path.join(repoRoot, "g5-recovery-contract-output.json"),
  )), "OUTPUT_INSIDE_REPOSITORY");
});

test("repository binding rejects wrong HEAD and a dirty worktree before tag checks", async () => {
  const wrongHeadRunner = fakeGitRunner({ head: "3".repeat(40), status: Buffer.alloc(0) });
  await assertRejectsCode(verifyRepositoryBinding({
    repoRoot,
    sourceCommit,
    signedTag: "workbench-rc-test",
    commandRunner: wrongHeadRunner,
  }), "SOURCE_COMMIT_MISMATCH");
  assert.deepEqual(wrongHeadRunner.commandIds, ["repository.top-level", "repository.head"]);

  const dirtyRunner = fakeGitRunner({ head: sourceCommit, status: Buffer.from("?? local-secret\0") });
  await assertRejectsCode(verifyRepositoryBinding({
    repoRoot,
    sourceCommit,
    signedTag: "workbench-rc-test",
    commandRunner: dirtyRunner,
  }), "DIRTY_WORKTREE");
  assert.deepEqual(dirtyRunner.commandIds, [
    "repository.top-level",
    "repository.head",
    "repository.status",
  ]);
});

test("refuses a restore database that already exists without mutating it", async (t) => {
  const fixture = await outputFixture(t);
  const plan = await prepareRecoveryPlan(validOptions(fixture.output));
  const calls = [];
  const driver = passingDriver(plan, calls, { restoreExistsInitially: true });
  const result = await performRecoveryDrill({
    plan,
    repositoryBinding: repositoryBinding(),
    driver,
    now: timestampSequence("2026-07-20T00:00:00.000Z", "2026-07-20T00:00:01.000Z"),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "RESTORE_DATABASE_ALREADY_EXISTS");
  assert.equal(result.receipt.payload.cleanup.restoreDatabase, "NOT_REQUIRED");
  assert.equal(calls.includes("createRestoreDatabase"), false);
  assert.equal(calls.includes("dropRestoreDatabase"), false);
  assert.equal(calls.at(-1), "removeArchive");
});

test("a complete recovery drill seals PASS only after target and archive cleanup", async (t) => {
  const fixture = await outputFixture(t);
  const plan = await prepareRecoveryPlan(validOptions(fixture.output));
  const calls = [];
  const result = await performRecoveryDrill({
    plan,
    repositoryBinding: repositoryBinding(),
    driver: passingDriver(plan, calls),
    now: timestampSequence("2026-07-20T00:00:00.000Z", "2026-07-20T00:00:20.000Z"),
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.receipt.payload.objectives.rpo.observedSeconds, 5);
  assert.equal(result.receipt.payload.objectives.rto.observedSeconds, 5);
  assert.equal(result.receipt.payload.cleanup.status, "PASS");
  assert.equal(result.receipt.payload.archive.deleted, true);
  assert.equal(result.receipt.payload.forwardRepair.status, "PASS");
  assert.equal(validateRecoveryDrillReceiptSeal(result.receipt), true);
  assert.ok(calls.indexOf("dropRestoreDatabase") > calls.indexOf("collectDataManifest:restore"));
});

test("archive checksum mismatch fails before creating the restore database", async (t) => {
  const fixture = await outputFixture(t);
  const plan = await prepareRecoveryPlan(validOptions(fixture.output));
  const calls = [];
  const result = await performRecoveryDrill({
    plan,
    repositoryBinding: repositoryBinding(),
    driver: passingDriver(plan, calls, { archiveVerificationFailure: true }),
    now: timestampSequence("2026-07-20T00:00:00.000Z", "2026-07-20T00:00:20.000Z"),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "ARCHIVE_CHECKSUM_MISMATCH");
  assert.equal(result.receipt.payload.archive.verifiedBeforeRestore, false);
  assert.equal(calls.includes("createRestoreDatabase"), false);
  assert.equal(result.receipt.payload.cleanup.restoreDatabase, "NOT_REQUIRED");
  assert.equal(result.receipt.payload.cleanup.archive, "PASS");
});

test("does not drop a restore database when CREATE ownership is ambiguous", async (t) => {
  const fixture = await outputFixture(t);
  const plan = await prepareRecoveryPlan(validOptions(fixture.output));
  const calls = [];
  const result = await performRecoveryDrill({
    plan,
    repositoryBinding: repositoryBinding(),
    driver: passingDriver(plan, calls, { createFailureUnknown: true }),
    now: timestampSequence("2026-07-20T00:00:00.000Z", "2026-07-20T00:00:20.000Z"),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "CLEANUP_FAILED");
  assert.equal(result.receipt.payload.cleanup.restoreDatabase, "FAIL");
  assert.equal(calls.includes("dropRestoreDatabase"), false);
});

test("cleanup failure overrides success and cannot produce a PASS receipt", async (t) => {
  const fixture = await outputFixture(t);
  const plan = await prepareRecoveryPlan(validOptions(fixture.output));
  const result = await performRecoveryDrill({
    plan,
    repositoryBinding: repositoryBinding(),
    driver: passingDriver(plan, [], { dropFailure: true }),
    now: timestampSequence("2026-07-20T00:00:00.000Z", "2026-07-20T00:00:20.000Z"),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "CLEANUP_FAILED");
  assert.equal(result.receipt.payload.cleanup.restoreDatabase, "FAIL");
  assert.equal(result.receipt.payload.cleanup.status, "FAIL");
  assert.throws(
    () => validateRecoveryDrillReceiptSeal({
      ...result.receipt,
      payload: { ...result.receipt.payload, status: "PASS", failure: null },
    }),
    /payloadSha256/u,
  );
});

test("receipt seals are deterministic and tamper evident", () => {
  const payload = {
    status: "FAIL",
    cleanup: { status: "PASS" },
    archive: { deleted: true },
    failure: { code: "FIXTURE", message: "fixture", details: {} },
    nested: { zebra: 1, alpha: 2 },
  };
  const first = sealRecoveryDrillReceipt(payload);
  const second = sealRecoveryDrillReceipt(structuredClone(payload));
  assert.deepEqual(first, second);
  assert.equal(validateRecoveryDrillReceiptSeal(first), true);
  const tampered = structuredClone(first);
  tampered.payload.nested.alpha = 3;
  assert.throws(() => validateRecoveryDrillReceiptSeal(tampered), /payloadSha256/u);
});

test("receipt and errors never retain database URLs or passwords", async (t) => {
  const fixture = await outputFixture(t);
  const plan = await prepareRecoveryPlan(validOptions(fixture.output));
  const sourcePassword = "source-password-unique-8472";
  const adminPassword = "admin-password-unique-1946";
  const environment = executionEnvironment(plan, { sourcePassword, adminPassword });
  const connections = validateExecutionEnvironment(plan, environment);
  const driver = passingDriver(plan, [], {
    inspectFailure: new Error(`postgresql://backup:${sourcePassword}@127.0.0.1/source`),
  });
  const result = await performRecoveryDrill({
    plan,
    repositoryBinding: repositoryBinding(),
    driver,
    now: timestampSequence("2026-07-20T00:00:00.000Z", "2026-07-20T00:00:01.000Z"),
  });
  assert.equal(result.receipt.payload.failure.code, "RECOVERY_DRILL_INTERNAL_ERROR");
  assertReceiptContainsNoSecrets(result.receipt, connections.secretValues);
  assert.equal(result.receiptJson.includes(sourcePassword), false);
  assert.equal(result.receiptJson.includes(adminPassword), false);
  assert.equal(result.receiptJson.includes("postgresql://"), false);
  assert.throws(
    () => assertReceiptContainsNoSecrets({ secret: sourcePassword }, [sourcePassword]),
    hasCode("RECEIPT_SECRET_DETECTED"),
  );
});

test("writes immutable mode-0600 receipt and sidecar without overwriting", async (t) => {
  const fixture = await outputFixture(t);
  const receipt = sealRecoveryDrillReceipt({
    status: "FAIL",
    cleanup: { status: "PASS" },
    archive: { deleted: true },
    failure: { code: "FIXTURE", message: "fixture", details: {} },
  });
  const written = await writeRecoveryDrillReceipt(fixture.output, receipt);
  assert.match(await readFile(written.sidecarPath, "utf8"), /^[a-f0-9]{64}  receipt\.json\n$/u);
  assert.equal((await stat(fixture.output)).mode & 0o777, 0o600);
  assert.equal((await stat(written.sidecarPath)).mode & 0o777, 0o600);
  await assertRejectsCode(
    writeRecoveryDrillReceipt(fixture.output, receipt),
    "OUTPUT_ALREADY_EXISTS",
  );
});

test("receipt writer rejects a database URL even without an explicit secret list", async (t) => {
  const fixture = await outputFixture(t);
  const receipt = sealRecoveryDrillReceipt({
    status: "FAIL",
    cleanup: { status: "PASS" },
    archive: { deleted: true },
    connection: "postgresql://redacted.example.invalid/workbench_g5_test",
    failure: { code: "FIXTURE", message: "fixture", details: {} },
  });
  await assertRejectsCode(
    writeRecoveryDrillReceipt(fixture.output, receipt),
    "RECEIPT_DATABASE_URL_DETECTED",
  );
  await assert.rejects(stat(fixture.output), { code: "ENOENT" });
});

test("plan document binds the exact execution confirmation", async (t) => {
  const fixture = await outputFixture(t);
  const plan = await prepareRecoveryPlan(validOptions(fixture.output));
  const document = recoveryPlanDocument(plan);
  assert.equal(document.requiredConfirmation, plan.requiredConfirmation);
  assert.deepEqual(document.requiredEnvironmentVariables, [
    "WORKBENCH_G5_SOURCE_DATABASE_URL",
    "WORKBENCH_G5_ADMIN_DATABASE_URL",
    "WORKBENCH_G5_DRILL_CONFIRM",
  ]);
});

test("table inventory accepts canonical PostgreSQL identifiers that start with underscore", () => {
  assert.deepEqual(parseTableInventory(Buffer.from([
    "workbench\t_prisma_migrations",
    "workbench\tprincipals",
    "workbench_jobs\tjob_archive",
    "",
  ].join("\r\n"), "utf8")), [
    { schema: "workbench", table: "_prisma_migrations" },
    { schema: "workbench", table: "principals" },
    { schema: "workbench_jobs", table: "job_archive" },
  ]);

  for (const inventory of [
    "workbench\tunsafe-name\n",
    "workbench\tMixedCase\n",
    "workbench\tvalid\textra\n",
  ]) {
    assert.throws(() => parseTableInventory(inventory), hasCode("TABLE_INVENTORY_INVALID"));
  }
});

function passingDriver(plan, calls, {
  restoreExistsInitially = false,
  dropFailure = false,
  inspectFailure = null,
  archiveVerificationFailure = false,
  createFailureUnknown = false,
} = {}) {
  let existenceChecks = 0;
  const dataManifest = {
    digest: "d".repeat(64),
    tableCount: 3,
    totalRows: "7",
    entries: [],
  };
  return {
    async collectToolVersions() {
      calls.push("collectToolVersions");
      return {
        npm: "10.0.0",
        pgDump: "pg_dump 16.1",
        pgRestore: "pg_restore 16.1",
        psql: "psql 16.1",
      };
    },
    async inspectSource() {
      calls.push("inspectSource");
      if (inspectFailure) throw inspectFailure;
      return {
        database: plan.sourceDatabase,
        serverVersion: "16.1",
        encoding: "UTF8",
        collation: "C",
        ctype: "C",
      };
    },
    async restoreDatabaseExists() {
      calls.push("restoreDatabaseExists");
      existenceChecks += 1;
      return existenceChecks === 1 ? restoreExistsInitially : createFailureUnknown;
    },
    async collectMigrationManifest(scope) {
      calls.push(`collectMigrationManifest:${scope}`);
      return structuredClone(plan.candidateMigrations);
    },
    async captureDatabaseClock(scope) {
      calls.push(`captureDatabaseClock:${scope}`);
      if (scope === "source") return "2026-07-20T00:00:00.000Z";
      if (scope === "admin") return "2026-07-20T00:00:05.000Z";
      return "2026-07-20T00:00:10.000Z";
    },
    async collectDataManifest(scope) {
      calls.push(`collectDataManifest:${scope}`);
      return structuredClone(dataManifest);
    },
    async createArchive() {
      calls.push("createArchive");
      return { sha256: "a".repeat(64), byteSize: "1024" };
    },
    async inspectArchive() {
      calls.push("inspectArchive");
      return { sha256: "b".repeat(64), byteSize: "512" };
    },
    async verifyArchiveChecksum() {
      calls.push("verifyArchiveChecksum");
      if (archiveVerificationFailure) {
        throw new RecoveryDrillError(
          "ARCHIVE_CHECKSUM_MISMATCH",
          "recovery archive changed after its checksum was recorded",
        );
      }
      return { sha256: "a".repeat(64), byteSize: "1024" };
    },
    async createRestoreDatabase() {
      calls.push("createRestoreDatabase");
      if (createFailureUnknown) throw new Error("connection lost after CREATE DATABASE");
    },
    async restoreArchive() {
      calls.push("restoreArchive");
    },
    async runForwardRepair() {
      calls.push("runForwardRepair");
      return { stdoutSha256: "c".repeat(64), stderrSha256: "e".repeat(64) };
    },
    async dropRestoreDatabase() {
      calls.push("dropRestoreDatabase");
      if (dropFailure) throw new RecoveryDrillError("INJECTED", "injected cleanup failure");
    },
    async removeArchive() {
      calls.push("removeArchive");
    },
  };
}

function validOptions(output, overrides = {}) {
  const restoreDatabase = overrides.restoreDatabase ?? "workbench_g5_restore_test";
  return {
    execute: false,
    repoRoot,
    candidateId,
    sourceCommit,
    signedTag: "workbench-rc-test",
    environmentId: "g5-contract-test",
    environmentKind: "isolated",
    sourceDatabase: "workbench_g5_source_test",
    restoreDatabase,
    confirmRestoreDatabase: overrides.confirmRestoreDatabase ?? restoreDatabase,
    expectedMigrationCount: "68",
    maxRpoSeconds: "60",
    maxRtoSeconds: "900",
    output,
    ...overrides,
  };
}

function validArguments(output) {
  return [
    "--repo", repoRoot,
    "--candidate-id", candidateId,
    "--source-commit", sourceCommit,
    "--signed-tag", "workbench-rc-test",
    "--environment-id", "g5-contract-test",
    "--environment-kind", "isolated",
    "--source-database", "workbench_g5_source_test",
    "--restore-database", "workbench_g5_restore_test",
    "--confirm-restore-database", "workbench_g5_restore_test",
    "--expected-migration-count", "68",
    "--max-rpo-seconds", "60",
    "--max-rto-seconds", "900",
    "--output", output,
  ];
}

function executionEnvironment(plan, {
  sourcePassword = "source-secret",
  adminPassword = "admin-secret",
} = {}) {
  return {
    WORKBENCH_G5_SOURCE_DATABASE_URL: `postgresql://backup:${sourcePassword}@127.0.0.1:5432/${plan.sourceDatabase}?schema=workbench`,
    WORKBENCH_G5_ADMIN_DATABASE_URL: `postgresql://admin:${adminPassword}@127.0.0.1:5432/postgres`,
    WORKBENCH_G5_DRILL_CONFIRM: plan.requiredConfirmation,
  };
}

function repositoryBinding() {
  return {
    sourceCommit,
    signedTag: "workbench-rc-test",
    tagObject: "4".repeat(40),
    tagPayloadSha256: "5".repeat(64),
    gitVersion: "git version 2.50.0",
  };
}

function fakeGitRunner({ head, status }) {
  const commandIds = [];
  return {
    commandIds,
    async run(specification) {
      commandIds.push(specification.id);
      const outputs = {
        "repository.top-level": `${repoRoot}\n`,
        "repository.head": `${head}\n`,
        "repository.status": status,
      };
      return {
        exitCode: 0,
        signal: null,
        errorCode: null,
        stdout: outputs[specification.id] ?? "",
        stderr: "",
      };
    },
  };
}

async function outputFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-g5-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, output: path.join(root, "receipt.json") };
}

function timestampSequence(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, hasCode(code));
}
