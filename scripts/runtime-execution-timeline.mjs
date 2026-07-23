import { createHash } from "node:crypto";

const TIMESTAMP_FIELDS = [
  "createdAtUtc",
  "startedAtUtc",
  "expiredAtUtc",
  "completedAtUtc",
  "failedAtUtc",
  "claimAtUtc",
  "heartbeatAtUtc",
  "leaseExpiresAtUtc",
  "providerSubmittedAtUtc",
  "providerFirstByteAtUtc",
  "providerLastEventAtUtc",
  "abortAtUtc",
  "reconciledAtUtc",
];

const OUTCOME_VALUES = new Set([
  "active",
  "completed",
  "expired",
  "failed",
  "cancelled",
  "retry",
  "unknown",
]);

export function buildRuntimeExecutionTimeline(input) {
  assertExactKeys(input, [
    "jobId",
    "runId",
    "candidateSha",
    "imageDigest",
    "retryCount",
    "pgBossState",
    "runStatus",
    "attemptStatus",
    "providerOutcome",
    "reconcilerOutcome",
    ...TIMESTAMP_FIELDS,
  ]);
  return {
    protocol: "workbench.runtime-execution-timeline.v1",
    jobIdSha256: opaqueIdHash(input.jobId, "jobId"),
    runIdSha256: opaqueIdHash(input.runId, "runId"),
    candidateSha: hexadecimal(input.candidateSha, "candidateSha", 7, 64),
    imageDigest: digest(input.imageDigest),
    retryCount: nonnegativeInteger(input.retryCount, "retryCount"),
    pgBossState: stableOutcome(input.pgBossState, "pgBossState"),
    runStatus: stableOutcome(input.runStatus, "runStatus"),
    attemptStatus: stableOutcome(input.attemptStatus, "attemptStatus"),
    providerOutcome: stableCode(input.providerOutcome, "providerOutcome"),
    reconcilerOutcome: stableCode(input.reconcilerOutcome, "reconcilerOutcome"),
    timestamps: Object.fromEntries(TIMESTAMP_FIELDS.map((field) => [
      field,
      optionalUtc(input[field], field),
    ])),
  };
}

function opaqueIdHash(value, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) {
    throw new Error(`RUNTIME_TIMELINE_${field.toUpperCase()}_INVALID`);
  }
  return createHash("sha256").update(value).digest("hex");
}

function hexadecimal(value, field, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[0-9a-f]+$/u.test(value)) {
    throw new Error(`RUNTIME_TIMELINE_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function digest(value) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error("RUNTIME_TIMELINE_IMAGE_DIGEST_INVALID");
  }
  return value;
}

function nonnegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RUNTIME_TIMELINE_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function stableOutcome(value, field) {
  if (typeof value !== "string" || !OUTCOME_VALUES.has(value)) {
    throw new Error(`RUNTIME_TIMELINE_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function stableCode(value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) {
    throw new Error(`RUNTIME_TIMELINE_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function optionalUtc(value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new Error(`RUNTIME_TIMELINE_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function assertExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNTIME_TIMELINE_INPUT_INVALID");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error("RUNTIME_TIMELINE_INPUT_KEYS_INVALID");
  }
}
