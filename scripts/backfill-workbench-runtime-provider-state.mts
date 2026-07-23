#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@workbench/workbench-db";
import { RuntimeProviderStateBackfill } from "../apps/workbench-worker/src/runtime/runtime-provider-state-backfill.js";

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const databaseUrl = migratorDatabaseUrl(options.expectedDatabase);
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const operator = new RuntimeProviderStateBackfill(db);
    const result = await operator.processBatch({
      candidateSha: requiredEnvironment("WORKBENCH_CANDIDATE_SHA"),
      mode: options.mode,
      batchSize: options.batchSize,
      afterAttemptId: options.afterAttemptId,
    });
    for (const checkpoint of result.checkpoints) {
      console.log(JSON.stringify(checkpoint));
    }
    console.log(JSON.stringify({
      protocol: "workbench.runtime-provider-state-backfill-coverage.v1",
      resumeCursor: result.nextAfterAttemptId,
      nextAfterAttemptIdSha256: result.nextAfterAttemptId
        ? createHash("sha256").update(result.nextAfterAttemptId).digest("hex")
        : null,
      ...result.coverage,
    }));
    if (result.coverage.rolloutBlocked) process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
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
  const allowed = new Set(["--expected-database", "--batch-size", "--after-attempt-id"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ARGUMENT_INVALID");
  }
  return {
    expectedDatabase,
    batchSize,
    afterAttemptId: values.get("--after-attempt-id"),
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

if (
  process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "RUNTIME_PROVIDER_STATE_BACKFILL_FAILED");
    process.exitCode = 1;
  });
}
