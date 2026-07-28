#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@workbench/workbench-db";
import { initializeTelemetry } from "@workbench/workbench-telemetry";
import { RuntimeProviderStateBackfill } from "../apps/workbench-worker/src/runtime/runtime-provider-state-backfill.js";

export const runtimeProviderStateBackfillExitCodes = {
  completed: 0,
  failed: 1,
  coverageBlocked: 2,
  resumeRequired: 3,
} as const;

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const databaseUrl = migratorDatabaseUrl(options.expectedDatabase);
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const telemetry = initializeTelemetry({
    serviceName: "workbench-runtime-provider-state-backfill",
  });
  try {
    const operator = new RuntimeProviderStateBackfill(db);
    const result = await runBackfill(operator, {
      candidateSha: requiredEnvironment("WORKBENCH_CANDIDATE_SHA"),
      mode: options.mode,
      batchSize: options.batchSize,
      afterAttemptId: options.afterAttemptId,
      maxBatches: options.maxBatches,
    }, (checkpoint) => {
      console.log(JSON.stringify(checkpoint));
    });
    console.log(JSON.stringify({
      protocol: "workbench.runtime-provider-state-backfill-result.v2",
      mode: options.mode,
      terminalStatus: result.terminalStatus,
      batchesProcessed: result.batchesProcessed,
      attemptsProcessed: result.attemptsProcessed,
      resumeAfterAttemptId: result.resumeAfterAttemptId,
      resumeAfterAttemptIdSha256: result.resumeAfterAttemptId
        ? createHash("sha256").update(result.resumeAfterAttemptId).digest("hex")
        : null,
      ...result.coverage,
    }));
    process.exitCode = result.exitCode;
  } finally {
    await Promise.all([
      db.$disconnect(),
      telemetry.shutdown(),
    ]);
  }
}

export async function runBackfill(
  operator: Pick<RuntimeProviderStateBackfill, "processPage" | "coverage">,
  input: {
    candidateSha: string;
    mode: "apply" | "dry-run" | "verify-only";
    batchSize: number;
    maxBatches: number;
    afterAttemptId?: string;
  },
  emitCheckpoint: (checkpoint: Awaited<ReturnType<RuntimeProviderStateBackfill["processPage"]>>["checkpoints"][number]) => void = () => undefined,
) {
  if (!Number.isSafeInteger(input.maxBatches) || input.maxBatches < 1 || input.maxBatches > 10_000) {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_MAX_BATCHES_INVALID");
  }
  let cursor = input.afterAttemptId;
  let attemptsProcessed = 0;
  let batchesProcessed = 0;
  let resumeRequired = false;

  while (batchesProcessed < input.maxBatches) {
    const page = await operator.processPage({
      candidateSha: input.candidateSha,
      mode: input.mode,
      batchSize: input.batchSize,
      afterAttemptId: cursor,
    });
    batchesProcessed += 1;
    attemptsProcessed += page.checkpoints.length;
    for (const checkpoint of page.checkpoints) emitCheckpoint(checkpoint);

    if (!page.hasMore) {
      cursor = undefined;
      break;
    }
    if (!page.nextAfterAttemptId || page.nextAfterAttemptId === cursor) {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_CURSOR_STALLED");
    }
    cursor = page.nextAfterAttemptId;
    if (batchesProcessed === input.maxBatches) resumeRequired = true;
  }

  const coverage = await operator.coverage();
  const terminalStatus = resumeRequired
    ? "resume-required" as const
    : coverage.rolloutBlocked
      ? "coverage-blocked" as const
      : "completed" as const;
  return {
    terminalStatus,
    batchesProcessed,
    attemptsProcessed,
    resumeAfterAttemptId: resumeRequired ? cursor ?? null : null,
    coverage,
    exitCode: terminalStatus === "resume-required"
      ? runtimeProviderStateBackfillExitCodes.resumeRequired
      : terminalStatus === "coverage-blocked"
        ? runtimeProviderStateBackfillExitCodes.coverageBlocked
        : runtimeProviderStateBackfillExitCodes.completed,
  };
}

export function parseOptions(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const argument of args) {
    if (argument === "--dry-run" || argument === "--verify-only") {
      flags.add(argument);
      continue;
    }
    const match = /^(--[a-z-]+)=(.+)$/u.exec(argument);
    if (!match || values.has(match[1]!)) {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ARGUMENT_INVALID");
    }
    values.set(match[1]!, match[2]!);
  }
  if (flags.size > 1) throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_MODE_INVALID");
  const expectedDatabase = values.get("--expected-database");
  if (!expectedDatabase || !/^[A-Za-z0-9_-]{1,63}$/u.test(expectedDatabase)) {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_EXPECTED_DATABASE_INVALID");
  }
  const batchSize = Number(values.get("--batch-size") ?? "100");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_BATCH_SIZE_INVALID");
  }
  const maxBatches = Number(values.get("--max-batches") ?? "100");
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 10_000) {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_MAX_BATCHES_INVALID");
  }
  const afterAttemptId = values.get("--after-attempt-id");
  if (afterAttemptId && !/^[A-Za-z0-9_-]{1,1024}$/u.test(afterAttemptId)) {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_CURSOR_INVALID");
  }
  const allowed = new Set([
    "--expected-database",
    "--batch-size",
    "--max-batches",
    "--after-attempt-id",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ARGUMENT_INVALID");
  }
  return {
    expectedDatabase,
    batchSize,
    maxBatches,
    afterAttemptId,
    mode: flags.has("--dry-run")
      ? "dry-run" as const
      : flags.has("--verify-only")
        ? "verify-only" as const
        : "apply" as const,
  };
}

export function migratorDatabaseUrl(expectedDatabase: string) {
  const raw = requiredEnvironment("WORKBENCH_MIGRATOR_DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_DATABASE_URL_INVALID");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  const expectedRole = process.env.WORKBENCH_POSTGRES_MIGRATOR_USER?.trim();
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !database
    || database !== expectedDatabase
    || !expectedRole
    || decodeURIComponent(parsed.username) !== expectedRole
  ) {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_DATABASE_TARGET_INVALID");
  }
  return raw;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function backfillFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^(?:RUNTIME_PROVIDER_STATE_[A-Z0-9_]+|Missing WORKBENCH_(?:CANDIDATE_SHA|MIGRATOR_DATABASE_URL))$/u.test(message)
    ? message
    : "RUNTIME_PROVIDER_STATE_BACKFILL_FAILED";
}

if (
  process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void main().catch((error) => {
    console.error(backfillFailureMessage(error));
    process.exitCode = runtimeProviderStateBackfillExitCodes.failed;
  });
}
