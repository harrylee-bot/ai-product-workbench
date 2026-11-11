#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";

export const RECOVERY_DRILL_PLAN_SCHEMA_VERSION = "workbench.postgres-recovery-drill-plan.v1";
export const RECOVERY_DRILL_RECEIPT_SCHEMA_VERSION = "workbench.postgres-recovery-drill-receipt.v1";
export const RECOVERY_DRILL_CONFIRM_PREFIX = "G5-RECOVERY-DRILL";

const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CANDIDATE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{2,62}$/u;
const POSTGRES_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const MIGRATION_NAME_PATTERN = /^\d{14}_[a-z0-9_]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SAFE_OUTPUT_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;
const SAFE_SOURCE_MARKER = /(?:^|_)(?:ci|drill|isolated|sandbox|staging|test)(?:_|$)/u;
const SAFE_RESTORE_MARKER = /(?:^|_)(?:drill|g5|restore|test)(?:_|$)/u;
const PROTECTED_DATABASE_NAMES = new Set([
  "postgres",
  "template0",
  "template1",
  "workbench",
]);
const PROTECTED_DATABASE_TOKENS = new Set([
  "live",
  "main",
  "primary",
  "prod",
  "production",
]);
const ENVIRONMENT_KINDS = new Set(["isolated", "staging"]);
const EXECUTION_ENVIRONMENT_VARIABLES = Object.freeze([
  "WORKBENCH_G5_SOURCE_DATABASE_URL",
  "WORKBENCH_G5_ADMIN_DATABASE_URL",
  "WORKBENCH_G5_DRILL_CONFIRM",
]);
const LIBPQ_PARAMETER_ENV = new Map([
  ["application_name", "PGAPPNAME"],
  ["channel_binding", "PGCHANNELBINDING"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
  ["gssencmode", "PGGSSENCMODE"],
  ["krbsrvname", "PGKRBSRVNAME"],
  ["options", "PGOPTIONS"],
  ["passfile", "PGPASSFILE"],
  ["sslcert", "PGSSLCERT"],
  ["sslcrl", "PGSSLCRL"],
  ["sslcrldir", "PGSSLCRLDIR"],
  ["sslkey", "PGSSLKEY"],
  ["sslmode", "PGSSLMODE"],
  ["sslpassword", "PGSSLPASSWORD"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["ssl_max_protocol_version", "PGSSLMAXPROTOCOLVERSION"],
  ["ssl_min_protocol_version", "PGSSLMINPROTOCOLVERSION"],
  ["target_session_attrs", "PGTARGETSESSIONATTRS"],
]);
const PRISMA_ONLY_URL_PARAMETERS = new Set([
  "connection_limit",
  "pgbouncer",
  "pool_timeout",
  "schema",
  "socket_timeout",
  "sslaccept",
  "statement_cache_size",
]);

export class RecoveryDrillError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RecoveryDrillError";
    this.code = code;
    this.details = details;
  }
}

export function parseCliArguments(argv) {
  const options = {
    execute: false,
    help: false,
    repoRoot: process.cwd(),
    candidateId: null,
    sourceCommit: null,
    signedTag: null,
    environmentId: null,
    environmentKind: null,
    sourceDatabase: null,
    restoreDatabase: null,
    confirmRestoreDatabase: null,
    expectedMigrationCount: null,
    maxRpoSeconds: null,
    maxRtoSeconds: null,
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--repo") options.repoRoot = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--candidate-id") options.candidateId = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--source-commit") options.sourceCommit = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--signed-tag") options.signedTag = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--environment-id") options.environmentId = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--environment-kind") options.environmentKind = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--source-database") options.sourceDatabase = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--restore-database") options.restoreDatabase = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--confirm-restore-database") options.confirmRestoreDatabase = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--expected-migration-count") options.expectedMigrationCount = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--max-rpo-seconds") options.maxRpoSeconds = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--max-rto-seconds") options.maxRtoSeconds = requiredArgumentValue(argv, ++index, argument);
    else if (argument === "--output") options.output = requiredArgumentValue(argv, ++index, argument);
    else throw new RecoveryDrillError("ARGUMENT_INVALID", "unknown recovery drill argument");
  }

  if (!options.help) {
    for (const [field, flag] of [
      ["candidateId", "--candidate-id"],
      ["sourceCommit", "--source-commit"],
      ["signedTag", "--signed-tag"],
      ["environmentId", "--environment-id"],
      ["environmentKind", "--environment-kind"],
      ["sourceDatabase", "--source-database"],
      ["restoreDatabase", "--restore-database"],
      ["confirmRestoreDatabase", "--confirm-restore-database"],
      ["expectedMigrationCount", "--expected-migration-count"],
      ["maxRpoSeconds", "--max-rpo-seconds"],
      ["maxRtoSeconds", "--max-rto-seconds"],
      ["output", "--output"],
    ]) {
      if (!options[field]) throw new RecoveryDrillError("ARGUMENT_REQUIRED", `${flag} is required`);
    }
  }
  return options;
}

export async function prepareRecoveryPlan(options) {
  const candidateId = requirePattern(options.candidateId, CANDIDATE_ID_PATTERN, "CANDIDATE_ID_INVALID", "candidate ID");
  const sourceCommit = requirePattern(options.sourceCommit, COMMIT_PATTERN, "SOURCE_COMMIT_INVALID", "source commit");
  const signedTag = normalizeTag(options.signedTag);
  const environmentId = requirePattern(options.environmentId, SAFE_ID_PATTERN, "ENVIRONMENT_ID_INVALID", "environment ID");
  const environmentKind = requireEnum(options.environmentKind, ENVIRONMENT_KINDS, "ENVIRONMENT_KIND_INVALID", "environment kind");
  const sourceDatabase = normalizeDatabaseName(options.sourceDatabase, { role: "source" });
  const restoreDatabase = normalizeDatabaseName(options.restoreDatabase, { role: "restore" });
  if (sourceDatabase === restoreDatabase) {
    throw new RecoveryDrillError("DATABASES_MUST_DIFFER", "source and restore databases must differ");
  }
  if (options.confirmRestoreDatabase !== restoreDatabase) {
    throw new RecoveryDrillError(
      "RESTORE_DATABASE_CONFIRMATION_INVALID",
      "--confirm-restore-database must exactly equal --restore-database",
    );
  }

  const expectedMigrationCount = positiveInteger(options.expectedMigrationCount, "EXPECTED_MIGRATION_COUNT_INVALID");
  const maxRpoSeconds = positiveNumber(options.maxRpoSeconds, "MAX_RPO_INVALID");
  const maxRtoSeconds = positiveNumber(options.maxRtoSeconds, "MAX_RTO_INVALID");
  const repoRoot = await realpath(path.resolve(options.repoRoot));
  const repositoryStat = await stat(repoRoot);
  if (!repositoryStat.isDirectory()) {
    throw new RecoveryDrillError("REPOSITORY_INVALID", "--repo must resolve to a directory");
  }
  const output = await normalizeOutputPath(options.output, repoRoot);
  await assertOutputAvailable(output);
  const candidateMigrations = await collectCandidateMigrationManifest(repoRoot);
  if (candidateMigrations.count !== expectedMigrationCount) {
    throw new RecoveryDrillError(
      "MIGRATION_COUNT_MISMATCH",
      "repository migration count does not match --expected-migration-count",
      { actualCount: candidateMigrations.count, expectedCount: expectedMigrationCount },
    );
  }
  const requiredConfirmation = expectedRecoveryDrillConfirmation({
    candidateId,
    environmentId,
    sourceDatabase,
    restoreDatabase,
  });

  return {
    execute: options.execute === true,
    repoRoot,
    candidateId,
    sourceCommit,
    signedTag,
    environmentId,
    environmentKind,
    sourceDatabase,
    restoreDatabase,
    expectedMigrationCount,
    maxRpoSeconds,
    maxRtoSeconds,
    output,
    requiredConfirmation,
    candidateMigrations,
  };
}

export function recoveryPlanDocument(plan) {
  return {
    schemaVersion: RECOVERY_DRILL_PLAN_SCHEMA_VERSION,
    mode: "PLAN",
    executionRequested: plan.execute,
    product: "产品工作台",
    gateId: "G5",
    candidate: {
      candidateId: plan.candidateId,
      sourceCommit: plan.sourceCommit,
      signedTag: plan.signedTag,
      migrationCount: plan.candidateMigrations.count,
      migrationSetSha256: plan.candidateMigrations.digest,
    },
    environment: {
      environmentId: plan.environmentId,
      kind: plan.environmentKind,
      sourceDatabase: plan.sourceDatabase,
      restoreDatabase: plan.restoreDatabase,
    },
    objectives: {
      maxRpoSeconds: plan.maxRpoSeconds,
      maxRtoSeconds: plan.maxRtoSeconds,
    },
    output: plan.output,
    requiredEnvironmentVariables: [...EXECUTION_ENVIRONMENT_VARIABLES],
    requiredConfirmation: plan.requiredConfirmation,
    steps: [
      "verify-clean-signed-candidate",
      "verify-source-identity-and-migrations",
      "fingerprint-source-before-backup",
      "create-and-hash-custom-format-backup",
      "verify-source-stability-after-backup",
      "create-confirmed-empty-restore-database",
      "restore-and-run-forward-repair",
      "verify-migrations-and-data",
      "measure-rpo-and-rto",
      "drop-restore-database-and-delete-archive",
      "write-sealed-immutable-receipt",
    ],
  };
}

export function expectedRecoveryDrillConfirmation({
  candidateId,
  environmentId,
  sourceDatabase,
  restoreDatabase,
}) {
  return `${RECOVERY_DRILL_CONFIRM_PREFIX}:${candidateId}:${environmentId}:${sourceDatabase}->${restoreDatabase}`;
}

export function validateExecutionEnvironment(plan, environment = process.env) {
  const sourceRaw = requiredEnvironment(environment, "WORKBENCH_G5_SOURCE_DATABASE_URL");
  const adminRaw = requiredEnvironment(environment, "WORKBENCH_G5_ADMIN_DATABASE_URL");
  const confirmation = requiredEnvironment(environment, "WORKBENCH_G5_DRILL_CONFIRM");
  if (confirmation !== plan.requiredConfirmation) {
    throw new RecoveryDrillError(
      "EXECUTION_CONFIRMATION_INVALID",
      "WORKBENCH_G5_DRILL_CONFIRM does not match the candidate-bound confirmation",
    );
  }

  const source = parsePostgresUrl(sourceRaw, "source");
  const admin = parsePostgresUrl(adminRaw, "admin");
  if (source.database !== plan.sourceDatabase) {
    throw new RecoveryDrillError(
      "SOURCE_DATABASE_URL_MISMATCH",
      "source database URL does not name --source-database",
    );
  }
  if (source.schema !== "workbench") {
    throw new RecoveryDrillError(
      "SOURCE_SCHEMA_INVALID",
      "source database URL must set schema=workbench",
    );
  }
  if (source.host !== admin.host || source.port !== admin.port) {
    throw new RecoveryDrillError(
      "DATABASE_SERVER_MISMATCH",
      "source and admin database URLs must target the same host and port",
    );
  }
  if (admin.database === plan.restoreDatabase) {
    throw new RecoveryDrillError(
      "ADMIN_DATABASE_INVALID",
      "admin database URL must not target the restore database",
    );
  }

  const restoreUrl = new URL(admin.url);
  restoreUrl.pathname = `/${encodeURIComponent(plan.restoreDatabase)}`;
  restoreUrl.searchParams.set("schema", "workbench");
  return {
    sourceUrl: source.url,
    adminUrl: admin.url,
    restoreUrl: restoreUrl.toString(),
    secretValues: uniqueSecretValues([sourceRaw, adminRaw, source.password, admin.password]),
  };
}

export async function verifyRepositoryBinding({
  repoRoot,
  sourceCommit,
  signedTag,
  commandRunner = createCommandRunner(),
}) {
  const run = async (id, args) => checkedCommand(commandRunner, {
    id,
    executable: "git",
    args,
    cwd: repoRoot,
    env: baseChildEnvironment(),
  });
  const topLevel = singleLine((await run("repository.top-level", ["rev-parse", "--show-toplevel"])).stdout, "Git top level");
  if (await realpath(topLevel) !== await realpath(repoRoot)) {
    throw new RecoveryDrillError("REPOSITORY_NOT_TOP_LEVEL", "--repo must be the Git top level");
  }
  const head = singleLine((await run("repository.head", ["rev-parse", "--verify", "HEAD^{commit}"])).stdout, "Git HEAD");
  if (head !== sourceCommit) {
    throw new RecoveryDrillError(
      "SOURCE_COMMIT_MISMATCH",
      "repository HEAD does not equal --source-commit",
      { actualCommit: normalizeObjectIdOrNull(head), expectedCommit: sourceCommit },
    );
  }
  const statusResult = await run("repository.status", ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (statusResult.stdout.length !== 0) {
    throw new RecoveryDrillError(
      "DIRTY_WORKTREE",
      "recovery drill execution requires a clean repository",
      { statusSha256: sha256(statusResult.stdout), byteSize: statusResult.stdout.length },
    );
  }

  const tagRef = `refs/tags/${signedTag}`;
  const tagObject = normalizeObjectId(singleLine((await run(
    "repository.tag-object",
    ["show-ref", "--verify", "--hash", tagRef],
  )).stdout, "tag object"), "TAG_OBJECT_INVALID");
  const objectType = singleLine((await run(
    "repository.tag-type",
    ["cat-file", "-t", tagObject],
  )).stdout, "tag type");
  if (objectType !== "tag") {
    throw new RecoveryDrillError("ANNOTATED_TAG_REQUIRED", "--signed-tag must name an annotated tag object");
  }
  await run("repository.tag-signature", ["verify-tag", "--raw", tagRef]);
  const peeledCommit = normalizeObjectId(singleLine((await run(
    "repository.tag-commit",
    ["rev-parse", "--verify", `${tagRef}^{commit}`],
  )).stdout, "tag commit"), "TAG_COMMIT_INVALID");
  if (peeledCommit !== sourceCommit) {
    throw new RecoveryDrillError(
      "TAG_COMMIT_MISMATCH",
      "signed tag does not peel to --source-commit",
      { peeledCommit, sourceCommit },
    );
  }
  const tagPayload = (await run("repository.tag-payload", ["cat-file", "tag", tagObject])).stdout;
  const gitVersion = singleLine((await run("repository.git-version", ["--version"])).stdout, "Git version");
  return {
    sourceCommit,
    signedTag,
    tagObject,
    tagPayloadSha256: sha256(tagPayload),
    gitVersion,
  };
}

export async function performRecoveryDrill({
  plan,
  repositoryBinding,
  driver,
  now = () => new Date().toISOString(),
}) {
  if (!driver || typeof driver !== "object") throw new TypeError("driver is required");
  assertRepositoryBindingForPlan(plan, repositoryBinding);
  const startedAtUtc = utcNow(now);
  const observations = {
    tools: {
      git: repositoryBinding.gitVersion ?? null,
      node: process.version,
      npm: null,
      pgDump: null,
      pgRestore: null,
      psql: null,
      postgresServer: null,
    },
    archive: {
      sha256: null,
      byteSize: null,
      tocSha256: null,
      tocByteSize: null,
      verifiedBeforeRestore: false,
      deleted: false,
    },
    migrations: {
      expectedCount: plan.expectedMigrationCount,
      candidateCount: plan.candidateMigrations.count,
      candidateSetSha256: plan.candidateMigrations.digest,
      sourceCount: null,
      sourceSetSha256: null,
      restoredCount: null,
      restoredSetSha256: null,
      sourceMatchesCandidate: false,
      restoredMatchesCandidate: false,
    },
    data: {
      sourceManifestSha256: null,
      restoredManifestSha256: null,
      tableCount: null,
      totalRows: null,
      sourceStableDuringBackup: false,
      restoredMatchesSource: false,
    },
    objectives: {
      recoveryPointAtUtc: null,
      recoveryStartedAtUtc: null,
      recoveryVerifiedAtUtc: null,
      rpo: { thresholdSeconds: plan.maxRpoSeconds, observedSeconds: null, status: "NOT_RUN" },
      rto: { thresholdSeconds: plan.maxRtoSeconds, observedSeconds: null, status: "NOT_RUN" },
    },
    forwardRepair: {
      status: "NOT_RUN",
      stdoutSha256: null,
      stderrSha256: null,
    },
    cleanup: {
      restoreDatabase: "NOT_REQUIRED",
      archive: "NOT_RUN",
      status: "NOT_RUN",
    },
  };
  let failure = null;
  let restoreDatabaseOwnership = "NOT_CREATED";

  try {
    Object.assign(observations.tools, await driver.collectToolVersions());
    const sourceIdentity = await driver.inspectSource();
    if (sourceIdentity.database !== plan.sourceDatabase) {
      throw new RecoveryDrillError("SOURCE_DATABASE_IDENTITY_MISMATCH", "PostgreSQL reported an unexpected source database");
    }
    observations.tools.postgresServer = sourceIdentity.serverVersion;
    if (await driver.restoreDatabaseExists()) {
      throw new RecoveryDrillError(
        "RESTORE_DATABASE_ALREADY_EXISTS",
        "restore database already exists; refusing to reuse or drop it",
      );
    }

    const sourceMigrationsBefore = await driver.collectMigrationManifest("source");
    copyMigrationObservation(observations.migrations, "source", sourceMigrationsBefore);
    assertMigrationMatchesCandidate(sourceMigrationsBefore, plan.candidateMigrations, "SOURCE_MIGRATIONS_MISMATCH");
    observations.migrations.sourceMatchesCandidate = true;

    observations.objectives.recoveryPointAtUtc = await driver.captureDatabaseClock("source");
    const sourceDataBefore = await driver.collectDataManifest("source");
    const archive = await driver.createArchive();
    observations.archive.sha256 = archive.sha256;
    observations.archive.byteSize = archive.byteSize;
    const toc = await driver.inspectArchive();
    observations.archive.tocSha256 = toc.sha256;
    observations.archive.tocByteSize = toc.byteSize;

    const sourceMigrationsAfter = await driver.collectMigrationManifest("source");
    assertMigrationManifestsEqual(sourceMigrationsBefore, sourceMigrationsAfter, "SOURCE_CHANGED_DURING_BACKUP");
    const sourceDataAfter = await driver.collectDataManifest("source");
    if (sourceDataBefore.digest !== sourceDataAfter.digest) {
      throw new RecoveryDrillError(
        "SOURCE_CHANGED_DURING_BACKUP",
        "source data changed while the recovery archive was being created",
        { beforeSha256: sourceDataBefore.digest, afterSha256: sourceDataAfter.digest },
      );
    }
    observations.data.sourceStableDuringBackup = true;
    observations.data.sourceManifestSha256 = sourceDataAfter.digest;
    observations.data.tableCount = sourceDataAfter.tableCount;
    observations.data.totalRows = sourceDataAfter.totalRows;

    observations.objectives.recoveryStartedAtUtc = await driver.captureDatabaseClock("admin");
    await driver.verifyArchiveChecksum(archive);
    observations.archive.verifiedBeforeRestore = true;
    try {
      const creation = await driver.createRestoreDatabase(sourceIdentity);
      if (creation?.created === false) {
        throw new RecoveryDrillError("RESTORE_DATABASE_CREATE_UNCONFIRMED", "restore database creation was not confirmed");
      }
      restoreDatabaseOwnership = "CREATED";
    } catch (error) {
      if (error?.details?.databaseCreated === true) {
        restoreDatabaseOwnership = "CREATED";
      } else {
        try {
          if (await driver.restoreDatabaseExists()) restoreDatabaseOwnership = "UNKNOWN";
        } catch {
          restoreDatabaseOwnership = "UNKNOWN";
        }
      }
      throw error;
    }
    await driver.restoreArchive();
    const repair = await driver.runForwardRepair();
    observations.forwardRepair = {
      status: "PASS",
      stdoutSha256: repair.stdoutSha256,
      stderrSha256: repair.stderrSha256,
    };

    const restoredMigrations = await driver.collectMigrationManifest("restore");
    copyMigrationObservation(observations.migrations, "restored", restoredMigrations);
    assertMigrationMatchesCandidate(restoredMigrations, plan.candidateMigrations, "RESTORED_MIGRATIONS_MISMATCH");
    observations.migrations.restoredMatchesCandidate = true;
    const restoredData = await driver.collectDataManifest("restore");
    observations.data.restoredManifestSha256 = restoredData.digest;
    if (restoredData.digest !== sourceDataAfter.digest) {
      throw new RecoveryDrillError(
        "RESTORED_DATA_MISMATCH",
        "restored data manifest does not match the source backup manifest",
        { restoredSha256: restoredData.digest, sourceSha256: sourceDataAfter.digest },
      );
    }
    observations.data.restoredMatchesSource = true;
    observations.objectives.recoveryVerifiedAtUtc = await driver.captureDatabaseClock("restore");
    const rpo = elapsedSeconds(
      observations.objectives.recoveryPointAtUtc,
      observations.objectives.recoveryStartedAtUtc,
      "RPO_CLOCK_INVALID",
    );
    const rto = elapsedSeconds(
      observations.objectives.recoveryStartedAtUtc,
      observations.objectives.recoveryVerifiedAtUtc,
      "RTO_CLOCK_INVALID",
    );
    observations.objectives.rpo.observedSeconds = rpo;
    observations.objectives.rpo.status = rpo <= plan.maxRpoSeconds ? "PASS" : "FAIL";
    observations.objectives.rto.observedSeconds = rto;
    observations.objectives.rto.status = rto <= plan.maxRtoSeconds ? "PASS" : "FAIL";
    if (observations.objectives.rpo.status !== "PASS") {
      throw new RecoveryDrillError(
        "RPO_EXCEEDED",
        "observed RPO exceeds the declared threshold",
        { observedSeconds: rpo, thresholdSeconds: plan.maxRpoSeconds },
      );
    }
    if (observations.objectives.rto.status !== "PASS") {
      throw new RecoveryDrillError(
        "RTO_EXCEEDED",
        "observed RTO exceeds the declared threshold",
        { observedSeconds: rto, thresholdSeconds: plan.maxRtoSeconds },
      );
    }
  } catch (error) {
    failure = normalizeFailure(error);
  } finally {
    if (restoreDatabaseOwnership === "CREATED") {
      try {
        await driver.dropRestoreDatabase();
        if (await driver.restoreDatabaseExists()) {
          throw new RecoveryDrillError("RESTORE_DATABASE_CLEANUP_FAILED", "restore database still exists after cleanup");
        }
        observations.cleanup.restoreDatabase = "PASS";
      } catch {
        observations.cleanup.restoreDatabase = "FAIL";
      }
    } else if (restoreDatabaseOwnership === "UNKNOWN") {
      // A failed CREATE may have succeeded before its connection was lost. Do
      // not drop a target whose ownership cannot be proven; surface cleanup
      // failure so an operator can identify it explicitly.
      observations.cleanup.restoreDatabase = "FAIL";
    }
    try {
      await driver.removeArchive();
      observations.cleanup.archive = "PASS";
      observations.archive.deleted = true;
    } catch {
      observations.cleanup.archive = "FAIL";
      observations.archive.deleted = false;
    }
    observations.cleanup.status = (
      observations.cleanup.restoreDatabase !== "FAIL"
      && observations.cleanup.archive === "PASS"
    ) ? "PASS" : "FAIL";
    if (observations.cleanup.status !== "PASS") {
      const priorFailureCode = failure?.code ?? null;
      failure = {
        code: "CLEANUP_FAILED",
        message: "recovery drill cleanup did not complete",
        details: {
          archive: observations.cleanup.archive,
          priorFailureCode,
          restoreDatabase: observations.cleanup.restoreDatabase,
        },
      };
    }
  }

  if (!failure) {
    try {
      assertCompleteRecoveryObservations(observations);
    } catch (error) {
      failure = normalizeFailure(error);
    }
  }

  const payload = {
    product: "产品工作台",
    technicalIdentifier: "workbench",
    gateId: "G5",
    status: failure ? "FAIL" : "PASS",
    startedAtUtc,
    endedAtUtc: utcNow(now),
    binding: {
      candidateId: plan.candidateId,
      sourceCommit: repositoryBinding.sourceCommit,
      signedTag: repositoryBinding.signedTag,
      tagObject: repositoryBinding.tagObject,
      tagPayloadSha256: repositoryBinding.tagPayloadSha256,
      environmentId: plan.environmentId,
      environmentKind: plan.environmentKind,
    },
    databases: {
      source: plan.sourceDatabase,
      restore: plan.restoreDatabase,
    },
    ...observations,
    failure,
  };
  const receipt = sealRecoveryDrillReceipt(payload);
  return {
    passed: payload.status === "PASS",
    status: payload.status,
    receipt,
    receiptJson: `${canonicalJson(receipt)}\n`,
  };
}

export function createPostgresRecoveryDriver({
  plan,
  connections,
  commandRunner = createCommandRunner(),
  tempParent = os.tmpdir(),
}) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const psqlArguments = [
    "--no-psqlrc",
    "--quiet",
    "--no-align",
    "--tuples-only",
    "--set=ON_ERROR_STOP=1",
  ];
  let temporaryRoot = null;
  let archivePath = null;

  const connectionFor = (scope) => {
    if (scope === "source") return connections.sourceUrl;
    if (scope === "admin") return connections.adminUrl;
    if (scope === "restore") return connections.restoreUrl;
    throw new RecoveryDrillError("DATABASE_SCOPE_INVALID", "unknown database scope");
  };
  const runDatabaseText = async (id, scope, sql) => checkedCommand(commandRunner, {
    id,
    executable: "psql",
    args: [...psqlArguments, "--command", sql],
    cwd: plan.repoRoot,
    env: libpqEnvironment(connectionFor(scope), `workbench-g5-${scope}`),
  });
  const jsonQuery = async (id, scope, sql) => {
    const output = (await runDatabaseText(id, scope, sql)).stdout.toString("utf8").trim();
    try {
      return JSON.parse(output);
    } catch {
      throw new RecoveryDrillError(
        "DATABASE_OUTPUT_INVALID",
        "database command returned invalid structured output",
        { commandId: id, outputSha256: sha256(output) },
      );
    }
  };

  return {
    async collectToolVersions() {
      const versions = {};
      for (const [field, executable, args] of [
        ["pgDump", "pg_dump", ["--version"]],
        ["pgRestore", "pg_restore", ["--version"]],
        ["psql", "psql", ["--version"]],
        ["npm", npm, ["--version"]],
      ]) {
        const result = await checkedCommand(commandRunner, {
          id: `tool.${field}`,
          executable,
          args,
          cwd: plan.repoRoot,
          env: baseChildEnvironment(),
        });
        versions[field] = singleLine(result.stdout, `${field} version`);
      }
      return versions;
    },

    async inspectSource() {
      const value = await jsonQuery("source.identity", "source", `
        SELECT json_build_object(
          'database', current_database(),
          'serverVersion', current_setting('server_version'),
          'encoding', pg_encoding_to_char(db_catalog.encoding),
          'collation', db_catalog.datcollate,
          'ctype', db_catalog.datctype
        )::text
        FROM pg_database AS db_catalog
        WHERE db_catalog.datname = current_database()
      `);
      if (!value || typeof value !== "object") {
        throw new RecoveryDrillError("SOURCE_DATABASE_IDENTITY_INVALID", "source database identity is invalid");
      }
      return value;
    },

    async restoreDatabaseExists() {
      const value = await jsonQuery("restore.exists", "admin", `
        SELECT json_build_object(
          'exists', EXISTS (SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(plan.restoreDatabase)})
        )::text
      `);
      if (typeof value?.exists !== "boolean") {
        throw new RecoveryDrillError("RESTORE_DATABASE_CHECK_INVALID", "restore database existence check is invalid");
      }
      return value.exists;
    },

    async collectMigrationManifest(scope) {
      const value = await jsonQuery(`migrations.${scope}`, scope, `
        SELECT json_build_object(
          'failedCount', count(*) FILTER (
            WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL
          ),
          'entries', COALESCE(
            json_agg(
              json_build_object('name', "migration_name", 'checksum', "checksum")
              ORDER BY "migration_name"
            ) FILTER (
              WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
            ),
            '[]'::json
          )
        )::text
        FROM "workbench"."_prisma_migrations"
      `);
      return normalizeDatabaseMigrationManifest(value);
    },

    async captureDatabaseClock(scope) {
      const value = await jsonQuery(`clock.${scope}`, scope, `
        SELECT json_build_object(
          'timestamp', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )::text
      `);
      return normalizeUtcTimestamp(value?.timestamp, "DATABASE_CLOCK_INVALID");
    },

    async collectDataManifest(scope) {
      const tablesResult = await runDatabaseText(`data.${scope}.tables`, scope, `
        SELECT table_schema || E'\\t' || table_name
        FROM information_schema.tables
        WHERE table_schema IN ('workbench', 'workbench_jobs')
          AND table_type = 'BASE TABLE'
        ORDER BY table_schema COLLATE "C", table_name COLLATE "C"
      `);
      const tables = parseTableInventory(tablesResult.stdout);
      if (!tables.some((entry) => entry.schema === "workbench")) {
        throw new RecoveryDrillError("WORKBENCH_SCHEMA_EMPTY", "source workbench schema has no base tables");
      }
      const entries = [];
      let totalRows = 0n;
      for (const table of tables) {
        const query = `COPY (
          SELECT row_json
          FROM (
            SELECT row_to_json(source_row)::text AS row_json
            FROM ${sqlIdentifier(table.schema)}.${sqlIdentifier(table.table)} AS source_row
          ) AS canonical_rows
          ORDER BY row_json COLLATE "C"
        ) TO STDOUT`;
        const result = await checkedHashCommand(commandRunner, {
          id: `data.${scope}.fingerprint`,
          executable: "psql",
          args: [...psqlArguments, "--command", query],
          cwd: plan.repoRoot,
          env: libpqEnvironment(connectionFor(scope), `workbench-g5-${scope}`),
        });
        totalRows += BigInt(result.lineCount);
        entries.push({
          schema: table.schema,
          table: table.table,
          rowCount: result.lineCount,
          byteSize: result.byteSize,
          contentSha256: result.stdoutSha256,
        });
      }
      return {
        digest: sha256(canonicalJson(entries)),
        tableCount: entries.length,
        totalRows: totalRows.toString(),
        entries,
      };
    },

    async createArchive() {
      temporaryRoot = await mkdtemp(path.join(path.resolve(tempParent), "workbench-g5-recovery-"));
      archivePath = path.join(temporaryRoot, "source.dump");
      await checkedCommand(commandRunner, {
        id: "archive.create",
        executable: "pg_dump",
        args: [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          "--serializable-deferrable",
          "--lock-wait-timeout=30000",
          "--file",
          archivePath,
        ],
        cwd: plan.repoRoot,
        env: libpqEnvironment(connections.sourceUrl, "workbench-g5-backup"),
      });
      const archiveStat = await stat(archivePath);
      if (!archiveStat.isFile() || archiveStat.size <= 0) {
        throw new RecoveryDrillError("ARCHIVE_INVALID", "pg_dump did not create a non-empty regular archive");
      }
      return {
        sha256: await sha256File(archivePath),
        byteSize: String(archiveStat.size),
      };
    },

    async inspectArchive() {
      if (!archivePath) throw new RecoveryDrillError("ARCHIVE_NOT_CREATED", "recovery archive is not available");
      const result = await checkedHashCommand(commandRunner, {
        id: "archive.toc",
        executable: "pg_restore",
        args: ["--list", archivePath],
        cwd: plan.repoRoot,
        env: baseChildEnvironment(),
      });
      if (BigInt(result.byteSize) === 0n) {
        throw new RecoveryDrillError("ARCHIVE_TOC_EMPTY", "pg_restore returned an empty archive table of contents");
      }
      return { sha256: result.stdoutSha256, byteSize: result.byteSize };
    },

    async verifyArchiveChecksum(expected) {
      if (!archivePath) throw new RecoveryDrillError("ARCHIVE_NOT_CREATED", "recovery archive is not available");
      const archiveStat = await stat(archivePath);
      const actual = {
        sha256: await sha256File(archivePath),
        byteSize: String(archiveStat.size),
      };
      if (actual.sha256 !== expected.sha256 || actual.byteSize !== expected.byteSize) {
        throw new RecoveryDrillError(
          "ARCHIVE_CHECKSUM_MISMATCH",
          "recovery archive changed after its checksum was recorded",
          {
            actualByteSize: actual.byteSize,
            actualSha256: actual.sha256,
            expectedByteSize: expected.byteSize,
            expectedSha256: expected.sha256,
          },
        );
      }
      return actual;
    },

    async createRestoreDatabase(sourceIdentity) {
      let databaseCreated = false;
      try {
        await runDatabaseText("restore.create", "admin", `
          CREATE DATABASE ${sqlIdentifier(plan.restoreDatabase)} TEMPLATE template0
        `);
        databaseCreated = true;
        const identity = await jsonQuery("restore.identity", "restore", `
          SELECT json_build_object(
            'database', current_database(),
            'encoding', pg_encoding_to_char(db_catalog.encoding),
            'collation', db_catalog.datcollate,
            'ctype', db_catalog.datctype
          )::text
          FROM pg_database AS db_catalog
          WHERE db_catalog.datname = current_database()
        `);
        if (
          identity?.database !== plan.restoreDatabase
          || identity.encoding !== sourceIdentity.encoding
          || identity.collation !== sourceIdentity.collation
          || identity.ctype !== sourceIdentity.ctype
        ) {
          throw new RecoveryDrillError(
            "RESTORE_DATABASE_IDENTITY_MISMATCH",
            "restore database identity or locale differs from the source database",
          );
        }
        return { created: true };
      } catch (error) {
        if (databaseCreated && error instanceof RecoveryDrillError) {
          error.details = { ...error.details, databaseCreated: true };
        }
        throw error;
      }
    },

    async restoreArchive() {
      if (!archivePath) throw new RecoveryDrillError("ARCHIVE_NOT_CREATED", "recovery archive is not available");
      await checkedCommand(commandRunner, {
        id: "archive.restore",
        executable: "pg_restore",
        args: [
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-privileges",
          "--dbname",
          plan.restoreDatabase,
          archivePath,
        ],
        cwd: plan.repoRoot,
        env: libpqEnvironment(connections.restoreUrl, "workbench-g5-restore"),
      });
    },

    async runForwardRepair() {
      const result = await commandRunner.run({
        id: "restore.forward-repair",
        executable: npm,
        args: ["--workspace", "@workbench/workbench-db", "run", "migrate:deploy"],
        cwd: plan.repoRoot,
        env: {
          ...baseChildEnvironment(),
          WORKBENCH_DATABASE_URL: connections.restoreUrl,
        },
      });
      const normalized = normalizeCommandResult(result);
      if (normalized.exitCode !== 0) {
        throw new RecoveryDrillError(
          "FORWARD_REPAIR_FAILED",
          "candidate migrations failed against the restored database",
          commandFailureDetails("restore.forward-repair", normalized),
        );
      }
      return {
        stdoutSha256: sha256(normalized.stdout),
        stderrSha256: sha256(normalized.stderr),
      };
    },

    async dropRestoreDatabase() {
      await runDatabaseText("restore.terminate-connections", "admin", `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${sqlLiteral(plan.restoreDatabase)}
          AND pid <> pg_backend_pid()
      `);
      await runDatabaseText("restore.drop", "admin", `
        DROP DATABASE IF EXISTS ${sqlIdentifier(plan.restoreDatabase)}
      `);
    },

    async removeArchive() {
      const removedRoot = temporaryRoot;
      if (removedRoot) {
        await rm(removedRoot, { recursive: true, force: true });
        try {
          await lstat(removedRoot);
          throw new RecoveryDrillError("ARCHIVE_CLEANUP_FAILED", "temporary recovery archive directory still exists");
        } catch (error) {
          if (error instanceof RecoveryDrillError) throw error;
          if (error?.code !== "ENOENT") throw error;
        }
      }
      temporaryRoot = null;
      archivePath = null;
    },
  };
}

export function parseTableInventory(output) {
  const tableLines = toBuffer(output).toString("utf8").trim();
  if (!tableLines) return [];
  return tableLines.split(/\r?\n/u).map((line) => {
    const parts = line.split("\t");
    if (
      parts.length !== 2
      || !POSTGRES_IDENTIFIER_PATTERN.test(parts[0])
      || !POSTGRES_IDENTIFIER_PATTERN.test(parts[1])
    ) {
      throw new RecoveryDrillError("TABLE_INVENTORY_INVALID", "database returned an invalid table inventory");
    }
    return { schema: parts[0], table: parts[1] };
  });
}

export function createCommandRunner({
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
} = {}) {
  return {
    run({ executable, args, cwd, env }) {
      return new Promise((resolve) => {
        execFile(executable, args, {
          cwd,
          env,
          encoding: "buffer",
          maxBuffer,
          timeout: timeoutMs,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          resolve({
            exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
            signal: typeof error?.signal === "string" ? error.signal : null,
            errorCode: typeof error?.code === "string" ? error.code : null,
            stdout: toBuffer(stdout),
            stderr: toBuffer(stderr),
          });
        });
      });
    },

    hashStdout({ executable, args, cwd, env }) {
      return new Promise((resolve) => {
        const child = spawn(executable, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const stdoutHash = createHash("sha256");
        const stderrHash = createHash("sha256");
        let stdoutBytes = 0n;
        let stderrBytes = 0n;
        let lines = 0n;
        let timedOut = false;
        let spawnErrorCode = null;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => {
          const bytes = toBuffer(chunk);
          stdoutHash.update(bytes);
          stdoutBytes += BigInt(bytes.length);
          for (const value of bytes) if (value === 0x0a) lines += 1n;
        });
        child.stderr?.on("data", (chunk) => {
          const bytes = toBuffer(chunk);
          stderrHash.update(bytes);
          stderrBytes += BigInt(bytes.length);
        });
        child.once("error", (error) => {
          spawnErrorCode = typeof error?.code === "string" ? error.code : "SPAWN_ERROR";
        });
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({
            exitCode: timedOut ? null : code,
            signal: timedOut ? "TIMEOUT" : signal,
            errorCode: spawnErrorCode,
            stdoutSha256: stdoutHash.digest("hex"),
            stderrSha256: stderrHash.digest("hex"),
            byteSize: stdoutBytes.toString(),
            stderrByteSize: stderrBytes.toString(),
            lineCount: lines.toString(),
          });
        });
      });
    },
  };
}

export function sealRecoveryDrillReceipt(payload) {
  const sealed = {
    schemaVersion: RECOVERY_DRILL_RECEIPT_SCHEMA_VERSION,
    payload: JSON.parse(canonicalJson(payload)),
  };
  return {
    ...sealed,
    payloadSha256: sha256(canonicalJson(sealed)),
  };
}

export function validateRecoveryDrillReceiptSeal(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("receipt must be an object");
  }
  if (receipt.schemaVersion !== RECOVERY_DRILL_RECEIPT_SCHEMA_VERSION) {
    throw new Error("receipt schemaVersion is invalid");
  }
  const expected = sha256(canonicalJson({
    schemaVersion: receipt.schemaVersion,
    payload: receipt.payload,
  }));
  if (receipt.payloadSha256 !== expected) throw new Error("receipt payloadSha256 is invalid");
  if (!new Set(["PASS", "FAIL"]).has(receipt.payload?.status)) {
    throw new Error("receipt status is invalid");
  }
  if (receipt.payload.status === "PASS") {
    if (receipt.payload.failure !== null) throw new Error("PASS receipt must not contain a failure");
    if (receipt.payload.cleanup?.status !== "PASS") throw new Error("PASS receipt cleanup must pass");
    if (receipt.payload.archive?.verifiedBeforeRestore !== true) throw new Error("PASS receipt archive checksum must be verified");
    if (receipt.payload.archive?.deleted !== true) throw new Error("PASS receipt archive must be deleted");
  }
  return true;
}

export function assertReceiptContainsNoSecrets(receipt, secretValues) {
  const serialized = canonicalJson(receipt);
  for (const secret of uniqueSecretValues(secretValues)) {
    if (secret.length >= 4 && serialized.includes(secret)) {
      throw new RecoveryDrillError("RECEIPT_SECRET_DETECTED", "refusing to write a receipt containing secret material");
    }
  }
  if (/postgres(?:ql)?:\/\//iu.test(serialized)) {
    throw new RecoveryDrillError("RECEIPT_DATABASE_URL_DETECTED", "refusing to write a receipt containing a database URL");
  }
}

export async function writeRecoveryDrillReceipt(outputPath, receipt) {
  validateRecoveryDrillReceiptSeal(receipt);
  assertReceiptContainsNoSecrets(receipt, []);
  await assertOutputAvailable(outputPath);
  const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
  const receiptSha256 = sha256(receiptBytes);
  const sidecarPath = `${outputPath}.sha256`;
  const sidecarBytes = Buffer.from(`${receiptSha256}  ${path.basename(outputPath)}\n`, "utf8");
  let receiptWritten = false;
  let sidecarWritten = false;
  try {
    await writeFile(outputPath, receiptBytes, { flag: "wx", mode: 0o600 });
    receiptWritten = true;
    await writeFile(sidecarPath, sidecarBytes, { flag: "wx", mode: 0o600 });
    sidecarWritten = true;
  } catch (error) {
    if (receiptWritten) await rm(outputPath, { force: true });
    if (sidecarWritten) await rm(sidecarPath, { force: true });
    throw error;
  }
  return { outputPath, sidecarPath, receiptSha256 };
}

export async function collectCandidateMigrationManifest(repoRoot) {
  const migrationsRoot = path.join(repoRoot, "packages/workbench-db/prisma/migrations");
  const directoryEntries = await readdir(migrationsRoot, { withFileTypes: true });
  const names = directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareStrings);
  if (!names.length) {
    throw new RecoveryDrillError("MIGRATIONS_EMPTY", "repository contains no Prisma migrations");
  }
  const entries = [];
  for (const name of names) {
    if (!MIGRATION_NAME_PATTERN.test(name)) {
      throw new RecoveryDrillError("MIGRATION_NAME_INVALID", "repository contains a non-canonical migration directory");
    }
    const migration = await readFile(path.join(migrationsRoot, name, "migration.sql"));
    entries.push({ name, checksum: sha256(migration) });
  }
  return {
    count: entries.length,
    digest: sha256(canonicalJson(entries)),
    entries,
  };
}

async function runCli() {
  let options;
  try {
    options = parseCliArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const plan = await prepareRecoveryPlan(options);
    if (!plan.execute) {
      process.stdout.write(`${canonicalJson(recoveryPlanDocument(plan))}\n`);
      return;
    }
    const connections = validateExecutionEnvironment(plan, process.env);
    const commandRunner = createCommandRunner();
    const repositoryBinding = await verifyRepositoryBinding({
      repoRoot: plan.repoRoot,
      sourceCommit: plan.sourceCommit,
      signedTag: plan.signedTag,
      commandRunner,
    });
    const driver = createPostgresRecoveryDriver({ plan, connections, commandRunner });
    const result = await performRecoveryDrill({ plan, repositoryBinding, driver });
    assertReceiptContainsNoSecrets(result.receipt, connections.secretValues);
    const written = await writeRecoveryDrillReceipt(plan.output, result.receipt);
    process.stdout.write(`${canonicalJson({
      status: result.status,
      output: written.outputPath,
      receiptSha256: written.receiptSha256,
      failureCode: result.receipt.payload.failure?.code ?? null,
    })}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const failure = normalizeFailure(error);
    process.stderr.write(`[g5-recovery] ${failure.code}: ${failure.message}\n`);
    process.exitCode = error instanceof RecoveryDrillError ? 2 : 1;
  }
}

function normalizeDatabaseName(value, { role }) {
  if (typeof value !== "string" || !DATABASE_NAME_PATTERN.test(value)) {
    throw new RecoveryDrillError("DATABASE_NAME_INVALID", `${role} database name is not a safe PostgreSQL identifier`);
  }
  if (PROTECTED_DATABASE_NAMES.has(value)) {
    throw new RecoveryDrillError("PROTECTED_DATABASE_REJECTED", `${role} database name is protected`);
  }
  if (value.split("_").some((token) => PROTECTED_DATABASE_TOKENS.has(token))) {
    throw new RecoveryDrillError("PRODUCTION_DATABASE_REJECTED", `${role} database name contains a production marker`);
  }
  const marker = role === "source" ? SAFE_SOURCE_MARKER : SAFE_RESTORE_MARKER;
  if (!marker.test(value)) {
    throw new RecoveryDrillError(
      "ISOLATED_DATABASE_NAME_REQUIRED",
      `${role} database name must contain an explicit isolated/test/drill marker`,
    );
  }
  return value;
}

function parsePostgresUrl(value, role) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RecoveryDrillError("DATABASE_URL_INVALID", `${role} database URL is invalid`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new RecoveryDrillError("DATABASE_URL_INVALID", `${role} database URL must use PostgreSQL`);
  }
  if (!url.hostname || url.hash) {
    throw new RecoveryDrillError("DATABASE_URL_INVALID", `${role} database URL must use a concrete host without a fragment`);
  }
  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new RecoveryDrillError("DATABASE_URL_INVALID", `${role} database URL contains an invalid database name`);
  }
  if (!DATABASE_NAME_PATTERN.test(database) || database.includes("/")) {
    throw new RecoveryDrillError("DATABASE_URL_INVALID", `${role} database URL must name one safe database`);
  }
  for (const [name] of url.searchParams) {
    if (!LIBPQ_PARAMETER_ENV.has(name) && !PRISMA_ONLY_URL_PARAMETERS.has(name)) {
      throw new RecoveryDrillError(
        "DATABASE_URL_PARAMETER_UNSUPPORTED",
        `${role} database URL contains an unsupported connection parameter`,
      );
    }
  }
  let username = "";
  let password = "";
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new RecoveryDrillError("DATABASE_URL_INVALID", `${role} database URL contains invalid credentials`);
  }
  return {
    url: url.toString(),
    database,
    schema: url.searchParams.get("schema"),
    host: normalizeHostname(url.hostname),
    port: url.port || "5432",
    username,
    password,
  };
}

function libpqEnvironment(connectionUrl, applicationName) {
  const url = new URL(connectionUrl);
  const environment = baseChildEnvironment();
  environment.PGHOST = normalizeHostname(url.hostname);
  environment.PGPORT = url.port || "5432";
  environment.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
  if (url.username) environment.PGUSER = decodeURIComponent(url.username);
  if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
  for (const [name, value] of url.searchParams) {
    const environmentName = LIBPQ_PARAMETER_ENV.get(name);
    if (environmentName) environment[environmentName] = value;
  }
  environment.PGAPPNAME = applicationName;
  return environment;
}

function baseChildEnvironment() {
  const environment = {};
  for (const name of [
    "GNUPGHOME",
    "GPG_TTY",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NODE_EXTRA_CA_CERTS",
    "NPM_CONFIG_CACHE",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SSH_AUTH_SOCK",
    "TMPDIR",
  ]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.CI = "1";
  environment.NO_COLOR = "1";
  environment.FORCE_COLOR = "0";
  return environment;
}

function normalizeDatabaseMigrationManifest(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.entries)) {
    throw new RecoveryDrillError("MIGRATION_MANIFEST_INVALID", "database migration manifest is invalid");
  }
  if (!Number.isInteger(value.failedCount) || value.failedCount !== 0) {
    throw new RecoveryDrillError(
      "FAILED_MIGRATION_PRESENT",
      "database contains an unfinished Prisma migration",
      { failedCount: Number.isInteger(value.failedCount) ? value.failedCount : null },
    );
  }
  const entries = value.entries.map((entry) => {
    if (
      !entry
      || typeof entry !== "object"
      || !MIGRATION_NAME_PATTERN.test(entry.name ?? "")
      || !SHA256_PATTERN.test(entry.checksum ?? "")
    ) {
      throw new RecoveryDrillError("MIGRATION_MANIFEST_INVALID", "database migration entry is invalid");
    }
    return { name: entry.name, checksum: entry.checksum };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (compareStrings(entries[index - 1].name, entries[index].name) >= 0) {
      throw new RecoveryDrillError("MIGRATION_MANIFEST_INVALID", "database migrations are not unique and sorted");
    }
  }
  return { count: entries.length, digest: sha256(canonicalJson(entries)), entries };
}

function assertMigrationMatchesCandidate(actual, candidate, code) {
  if (actual.count !== candidate.count || actual.digest !== candidate.digest) {
    throw new RecoveryDrillError(code, "database migrations do not match the candidate migration set", {
      actualCount: actual.count,
      actualSha256: actual.digest,
      candidateCount: candidate.count,
      candidateSha256: candidate.digest,
    });
  }
}

function assertMigrationManifestsEqual(before, after, code) {
  if (before.count !== after.count || before.digest !== after.digest) {
    throw new RecoveryDrillError(code, "source migrations changed while the recovery archive was being created", {
      afterCount: after.count,
      afterSha256: after.digest,
      beforeCount: before.count,
      beforeSha256: before.digest,
    });
  }
}

function assertCompleteRecoveryObservations(observations) {
  const requiredToolFields = ["git", "node", "npm", "pgDump", "pgRestore", "psql", "postgresServer"];
  if (requiredToolFields.some((field) => typeof observations.tools[field] !== "string" || !observations.tools[field])) {
    throw new RecoveryDrillError("INCOMPLETE_RECOVERY_EVIDENCE", "tool versions are incomplete");
  }
  if (
    !SHA256_PATTERN.test(observations.archive.sha256 ?? "")
    || !SHA256_PATTERN.test(observations.archive.tocSha256 ?? "")
    || !/^\d+$/u.test(observations.archive.byteSize ?? "")
    || !/^\d+$/u.test(observations.archive.tocByteSize ?? "")
    || observations.archive.verifiedBeforeRestore !== true
    || observations.archive.deleted !== true
  ) {
    throw new RecoveryDrillError("INCOMPLETE_RECOVERY_EVIDENCE", "archive evidence is incomplete");
  }
  if (
    observations.migrations.sourceMatchesCandidate !== true
    || observations.migrations.restoredMatchesCandidate !== true
    || observations.data.sourceStableDuringBackup !== true
    || observations.data.restoredMatchesSource !== true
    || observations.forwardRepair.status !== "PASS"
    || observations.objectives.rpo.status !== "PASS"
    || observations.objectives.rto.status !== "PASS"
    || observations.cleanup.status !== "PASS"
  ) {
    throw new RecoveryDrillError("INCOMPLETE_RECOVERY_EVIDENCE", "recovery verification evidence is incomplete");
  }
}

function assertRepositoryBindingForPlan(plan, binding) {
  if (!binding || typeof binding !== "object") {
    throw new RecoveryDrillError("CANDIDATE_BINDING_INVALID", "verified repository binding is required");
  }
  if (binding.sourceCommit !== plan.sourceCommit) {
    throw new RecoveryDrillError("SOURCE_COMMIT_MISMATCH", "verified repository binding does not match the plan commit");
  }
  if (binding.signedTag !== plan.signedTag) {
    throw new RecoveryDrillError("SIGNED_TAG_MISMATCH", "verified repository binding does not match the plan tag");
  }
  if (!COMMIT_PATTERN.test(binding.tagObject ?? "") || !SHA256_PATTERN.test(binding.tagPayloadSha256 ?? "")) {
    throw new RecoveryDrillError("CANDIDATE_BINDING_INVALID", "verified tag evidence is incomplete");
  }
}

function copyMigrationObservation(target, prefix, manifest) {
  target[`${prefix}Count`] = manifest.count;
  target[`${prefix}SetSha256`] = manifest.digest;
}

function elapsedSeconds(earlier, later, code) {
  const start = Date.parse(earlier);
  const end = Date.parse(later);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new RecoveryDrillError(code, "database clock observations are invalid or out of order");
  }
  return Math.round(((end - start) / 1000) * 1000) / 1000;
}

async function normalizeOutputPath(value, repoRoot) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RecoveryDrillError("OUTPUT_REQUIRED", "--output is required");
  }
  const requested = path.resolve(value);
  const basename = path.basename(requested);
  if (!SAFE_OUTPUT_BASENAME.test(basename)) {
    throw new RecoveryDrillError("OUTPUT_INVALID", "--output must use a safe .json filename");
  }
  let outputDirectory;
  try {
    outputDirectory = await realpath(path.dirname(requested));
  } catch {
    throw new RecoveryDrillError("OUTPUT_DIRECTORY_INVALID", "--output parent directory must already exist");
  }
  const output = path.join(outputDirectory, basename);
  if (outputDirectory === repoRoot || outputDirectory.startsWith(`${repoRoot}${path.sep}`)) {
    throw new RecoveryDrillError("OUTPUT_INSIDE_REPOSITORY", "recovery evidence output must be outside the repository");
  }
  return output;
}

async function assertOutputAvailable(output) {
  for (const candidate of [output, `${output}.sha256`]) {
    try {
      await lstat(candidate);
      throw new RecoveryDrillError("OUTPUT_ALREADY_EXISTS", "refusing to overwrite recovery drill evidence");
    } catch (error) {
      if (error instanceof RecoveryDrillError) throw error;
      if (error?.code !== "ENOENT") {
        throw new RecoveryDrillError("OUTPUT_UNAVAILABLE", "recovery drill output path cannot be inspected");
      }
    }
  }
}

async function checkedCommand(commandRunner, specification) {
  let result;
  try {
    result = normalizeCommandResult(await commandRunner.run(specification));
  } catch (error) {
    throw new RecoveryDrillError("COMMAND_RUNNER_FAILED", "recovery drill command runner failed", {
      commandId: specification.id,
      causeCode: typeof error?.code === "string" ? error.code : null,
    });
  }
  if (result.exitCode !== 0) {
    throw new RecoveryDrillError(
      "COMMAND_FAILED",
      "recovery drill command failed",
      commandFailureDetails(specification.id, result),
    );
  }
  return result;
}

async function checkedHashCommand(commandRunner, specification) {
  let result;
  try {
    result = await commandRunner.hashStdout(specification);
  } catch (error) {
    throw new RecoveryDrillError("COMMAND_RUNNER_FAILED", "recovery drill stream command failed", {
      commandId: specification.id,
      causeCode: typeof error?.code === "string" ? error.code : null,
    });
  }
  if (!result || result.exitCode !== 0) {
    throw new RecoveryDrillError("COMMAND_FAILED", "recovery drill stream command failed", {
      commandId: specification.id,
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
      signal: typeof result?.signal === "string" ? result.signal : null,
      errorCode: typeof result?.errorCode === "string" ? result.errorCode : null,
      stdoutSha256: SHA256_PATTERN.test(result?.stdoutSha256 ?? "") ? result.stdoutSha256 : null,
      stderrSha256: SHA256_PATTERN.test(result?.stderrSha256 ?? "") ? result.stderrSha256 : null,
    });
  }
  for (const field of ["stdoutSha256", "stderrSha256"]) {
    if (!SHA256_PATTERN.test(result[field] ?? "")) {
      throw new RecoveryDrillError("COMMAND_OUTPUT_INVALID", "stream command returned an invalid digest");
    }
  }
  for (const field of ["byteSize", "lineCount"]) {
    if (!/^\d+$/u.test(result[field] ?? "")) {
      throw new RecoveryDrillError("COMMAND_OUTPUT_INVALID", "stream command returned an invalid count");
    }
  }
  return result;
}

function normalizeCommandResult(result) {
  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    signal: typeof result?.signal === "string" ? result.signal : null,
    errorCode: typeof result?.errorCode === "string" ? result.errorCode : null,
    stdout: toBuffer(result?.stdout),
    stderr: toBuffer(result?.stderr),
  };
}

function commandFailureDetails(commandId, result) {
  return {
    commandId,
    exitCode: result.exitCode,
    signal: result.signal,
    errorCode: result.errorCode,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
}

function normalizeFailure(error) {
  if (error instanceof RecoveryDrillError) {
    return {
      code: error.code,
      message: error.message,
      details: JSON.parse(canonicalJson(error.details)),
    };
  }
  return {
    code: "RECOVERY_DRILL_INTERNAL_ERROR",
    message: "unexpected recovery drill failure",
    details: {
      causeCode: typeof error?.code === "string" ? error.code : null,
      causeName: typeof error?.name === "string" ? error.name : null,
    },
  };
}

function normalizeTag(value) {
  if (
    typeof value !== "string"
    || !TAG_PATTERN.test(value)
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || value.endsWith("/")
    || value.endsWith(".lock")
  ) {
    throw new RecoveryDrillError("SIGNED_TAG_INVALID", "--signed-tag must be one safe explicit tag name");
  }
  return value;
}

function normalizeObjectId(value, code) {
  if (!COMMIT_PATTERN.test(value)) throw new RecoveryDrillError(code, "Git returned an invalid object ID");
  return value;
}

function normalizeObjectIdOrNull(value) {
  return COMMIT_PATTERN.test(value) ? value : null;
}

function normalizeUtcTimestamp(value, code) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new RecoveryDrillError(code, "database returned an invalid UTC timestamp");
  }
  return value;
}

function normalizeHostname(value) {
  return value.toLowerCase().replace(/^\[|\]$/gu, "");
}

function sqlIdentifier(value) {
  if (!POSTGRES_IDENTIFIER_PATTERN.test(value)) {
    throw new RecoveryDrillError("SQL_IDENTIFIER_INVALID", "unsafe SQL identifier rejected");
  }
  return `"${value}"`;
}

function sqlLiteral(value) {
  if (!DATABASE_NAME_PATTERN.test(value)) throw new RecoveryDrillError("SQL_LITERAL_INVALID", "unsafe SQL literal rejected");
  return `'${value}'`;
}

function singleLine(buffer, label) {
  const value = toBuffer(buffer).toString("utf8").trim();
  if (!value || /[\r\n]/u.test(value)) {
    throw new RecoveryDrillError("COMMAND_OUTPUT_INVALID", `${label} must be one non-empty line`);
  }
  return value;
}

function requirePattern(value, pattern, code, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RecoveryDrillError(code, `${label} is invalid`);
  }
  return value;
}

function requireEnum(value, allowed, code, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new RecoveryDrillError(code, `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RecoveryDrillError(code, "expected a positive integer");
  }
  return parsed;
}

function positiveNumber(value, code) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 86_400) {
    throw new RecoveryDrillError(code, "expected a positive number of seconds no greater than 86400");
  }
  return parsed;
}

function requiredArgumentValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== "string" || !value || value.startsWith("--")) {
    throw new RecoveryDrillError("ARGUMENT_REQUIRED", `${flag} requires a value`);
  }
  return value;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new RecoveryDrillError("EXECUTION_ENVIRONMENT_REQUIRED", `${name} is required for --execute`);
  }
  return value.trim();
}

function uniqueSecretValues(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function utcNow(now) {
  const value = now();
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("now() must return an ISO UTC timestamp");
  }
  return value;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function usage() {
  return `Usage:
  node scripts/workbench-postgres-recovery-drill.mjs [--execute] \\
    --repo <clean-repository> \\
    --candidate-id sha256:<64-hex> \\
    --source-commit <40-or-64-hex> \\
    --signed-tag <signed-annotated-tag> \\
    --environment-id <id> --environment-kind isolated|staging \\
    --source-database <isolated-name> \\
    --restore-database <new-drill-name> \\
    --confirm-restore-database <same-new-drill-name> \\
    --expected-migration-count <count> \\
    --max-rpo-seconds <seconds> --max-rto-seconds <seconds> \\
    --output </absolute/path/outside/repository/receipt.json>

Without --execute the command prints a plan and never connects to PostgreSQL.
Execution additionally requires ${EXECUTION_ENVIRONMENT_VARIABLES.join(", ")}.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await runCli();
}
