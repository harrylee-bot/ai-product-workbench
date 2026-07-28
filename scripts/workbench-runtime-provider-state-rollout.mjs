#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import canonicalize from "canonicalize";

export const RUNTIME_PROVIDER_STATE_OBSERVATION_SCHEMA =
  "workbench.runtime-provider-state-rollout-observation.v1";
export const RUNTIME_PROVIDER_STATE_RECEIPT_SCHEMA =
  "workbench.runtime-provider-state-rollout-receipt.v1";

const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ENVIRONMENT_KINDS = new Set(["isolated", "staging", "production"]);
const PHASES = Object.freeze(["backfill", "shadow", "canary", "cutover", "full"]);
const PHASE_INDEX = new Map(PHASES.map((phase, index) => [phase, index]));
const RECEIPT_FILE_NAMES = Object.freeze(
  Object.fromEntries(PHASES.map((phase, index) => [phase, `${String(index + 1).padStart(2, "0")}-${phase}.json`])),
);
const METRIC_KEYS = Object.freeze({
  backfill: [
    "totalAttempts",
    "expectedProjections",
    "built",
    "verified",
    "missing",
    "conflicts",
    "lagging",
    "versionMismatch",
    "hashMismatch",
    "activeMissing",
    "terminalMissing",
    "rolloutBlocked",
  ],
  shadow: [
    "observedEvents",
    "shadowMismatches",
    "projectionInvariantErrors",
    "projectionLag",
    "providerStateP2028",
  ],
  canary: [
    "desiredWorkers",
    "readyWorkers",
    "observedEvents",
    "shadowMismatches",
    "projectionInvariantErrors",
    "projectionLag",
    "providerStateP2028",
    "terminalRunDrift",
  ],
  cutover: [
    "desiredWorkers",
    "readyWorkers",
    "observedEvents",
    "projectionInvariantErrors",
    "projectionLag",
    "providerStateP2028",
    "terminalRunDrift",
  ],
  full: [
    "desiredWorkers",
    "readyWorkers",
    "legacyWorkerCount",
    "legacyReadTraffic",
    "observedEvents",
    "projectionInvariantErrors",
    "projectionLag",
    "providerStateP2028",
    "terminalRunDrift",
  ],
});

export class RuntimeProviderStateRolloutError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeProviderStateRolloutError";
    this.code = code;
  }
}

export function parseRolloutArguments(argv) {
  const options = {
    execute: false,
    help: false,
    phase: null,
    candidateSha: null,
    environmentId: null,
    environmentKind: null,
    observationPath: null,
    receiptsDirectory: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--phase") options.phase = requiredArgument(argv, ++index, argument);
    else if (argument === "--candidate-sha") options.candidateSha = requiredArgument(argv, ++index, argument);
    else if (argument === "--environment-id") options.environmentId = requiredArgument(argv, ++index, argument);
    else if (argument === "--environment-kind") options.environmentKind = requiredArgument(argv, ++index, argument);
    else if (argument === "--observation") options.observationPath = requiredArgument(argv, ++index, argument);
    else if (argument === "--receipts-dir") options.receiptsDirectory = requiredArgument(argv, ++index, argument);
    else throw rolloutError("ARGUMENT_INVALID", "unknown Runtime provider-state rollout argument");
  }
  if (!options.help) {
    for (const [field, flag] of [
      ["phase", "--phase"],
      ["candidateSha", "--candidate-sha"],
      ["environmentId", "--environment-id"],
      ["environmentKind", "--environment-kind"],
      ["observationPath", "--observation"],
      ["receiptsDirectory", "--receipts-dir"],
    ]) {
      if (!options[field]) throw rolloutError("ARGUMENT_REQUIRED", `${flag} is required`);
    }
  }
  return options;
}

export function validateRolloutObservation(document, binding) {
  assertExactKeys(document, [
    "schemaVersion",
    "phase",
    "candidateSha",
    "environment",
    "projectionVersion",
    "providerStateMode",
    "startedAtUtc",
    "finishedAtUtc",
    "approvalReference",
    "workerImageDigest",
    "inventoryDigest",
    "metrics",
    "evidence",
  ], "observation");
  if (document.schemaVersion !== RUNTIME_PROVIDER_STATE_OBSERVATION_SCHEMA) {
    throw rolloutError("OBSERVATION_SCHEMA_INVALID", "observation schemaVersion is invalid");
  }
  if (document.phase !== binding.phase) throw rolloutError("PHASE_MISMATCH", "observation phase differs from the requested phase");
  if (document.candidateSha !== binding.candidateSha) throw rolloutError("CANDIDATE_MISMATCH", "observation candidate differs from the requested candidate");
  if (document.environment?.id !== binding.environmentId || document.environment?.kind !== binding.environmentKind) {
    throw rolloutError("ENVIRONMENT_MISMATCH", "observation environment differs from the requested environment");
  }
  assertExactKeys(document.environment, ["id", "kind"], "observation.environment");
  if (document.projectionVersion !== 2) throw rolloutError("PROJECTION_VERSION_INVALID", "projection version must be 2");
  if (!SAFE_REFERENCE_PATTERN.test(document.approvalReference ?? "")) {
    throw rolloutError("APPROVAL_REFERENCE_INVALID", "observation approvalReference is invalid");
  }
  const startedAt = requireUtc(document.startedAtUtc, "startedAtUtc");
  const finishedAt = requireUtc(document.finishedAtUtc, "finishedAtUtc");
  if (finishedAt <= startedAt) throw rolloutError("OBSERVATION_WINDOW_INVALID", "observation finishedAtUtc must be after startedAtUtc");

  validatePhaseMode(document.phase, document.providerStateMode);
  validateImageBinding(document);
  validatePhaseMetrics(document.phase, document.metrics);
  validateEvidenceDescriptors(document.evidence);
  return structuredClone(document);
}

export async function prepareRolloutOperation(options, { repoRoot = process.cwd() } = {}) {
  const phase = requireEnum(options.phase, PHASE_INDEX, "PHASE_INVALID", "rollout phase");
  const candidateSha = requirePattern(options.candidateSha, SOURCE_COMMIT_PATTERN, "CANDIDATE_INVALID", "candidate SHA");
  const environmentId = requirePattern(options.environmentId, SAFE_ID_PATTERN, "ENVIRONMENT_ID_INVALID", "environment ID");
  const environmentKind = requireEnum(options.environmentKind, ENVIRONMENT_KINDS, "ENVIRONMENT_KIND_INVALID", "environment kind");
  const repository = await realpath(path.resolve(repoRoot));
  const observationPath = await stableRegularFile(path.resolve(options.observationPath), "observation");
  const receiptsDirectory = path.resolve(options.receiptsDirectory);
  await mkdir(receiptsDirectory, { recursive: true, mode: 0o700 });
  const canonicalReceiptsDirectory = await realpath(receiptsDirectory);
  if (
    environmentKind !== "isolated"
    && isWithin(repository, canonicalReceiptsDirectory)
  ) {
    throw rolloutError(
      "RECEIPT_LOCATION_INVALID",
      "staging and production rollout receipts must be stored outside the repository",
    );
  }
  const observation = parseJson(observationPath.bytes, "observation");
  validateRolloutObservation(observation, { phase, candidateSha, environmentId, environmentKind });
  const previous = await readPreviousReceipt({
    candidateSha,
    environmentId,
    environmentKind,
    phase,
    receiptsDirectory: canonicalReceiptsDirectory,
  });
  return {
    execute: options.execute === true,
    phase,
    candidateSha,
    environmentId,
    environmentKind,
    observation,
    observationSha256: sha256(observationPath.bytes),
    receiptsDirectory: canonicalReceiptsDirectory,
    outputPath: path.join(canonicalReceiptsDirectory, RECEIPT_FILE_NAMES[phase]),
    previous,
  };
}

export function rolloutPlanDocument(operation) {
  return {
    schemaVersion: RUNTIME_PROVIDER_STATE_RECEIPT_SCHEMA,
    mode: "PLAN",
    executionRequested: operation.execute,
    phase: operation.phase,
    candidateSha: operation.candidateSha,
    environment: { id: operation.environmentId, kind: operation.environmentKind },
    projectionVersion: 2,
    observationSha256: operation.observationSha256,
    previousReceiptSha256: operation.previous?.receiptSha256 ?? null,
    outputPath: operation.outputPath,
    sequence: [...PHASES],
  };
}

export async function executeRolloutOperation(operation, {
  now = () => new Date(),
  beforePublish = async () => undefined,
} = {}) {
  const existing = await readOptionalRegularFile(operation.outputPath);
  if (existing) {
    const validated = validateRolloutReceipt(parseJson(existing, "existing receipt"), {
      candidateSha: operation.candidateSha,
      environmentId: operation.environmentId,
      environmentKind: operation.environmentKind,
      phase: operation.phase,
      previousReceiptSha256: operation.previous?.receiptSha256 ?? null,
    });
    const sameObservation = validated.payload.observation.sha256 === operation.observationSha256;
    const sameApproval = validated.payload.approvalReference === operation.observation.approvalReference;
    const sameImage = validated.payload.workerImageDigest === operation.observation.workerImageDigest
      && validated.payload.inventoryDigest === operation.observation.inventoryDigest;
    const sameMode = validated.payload.providerStateMode === operation.observation.providerStateMode;
    if (!sameObservation || !sameApproval || !sameImage || !sameMode) {
      throw rolloutError("RECEIPT_CONFLICT", "an immutable receipt already exists for this phase");
    }
    return { created: false, receipt: validated, receiptSha256: sha256(existing) };
  }

  const payload = {
    phase: operation.phase,
    candidateSha: operation.candidateSha,
    environment: { id: operation.environmentId, kind: operation.environmentKind },
    projectionVersion: 2,
    providerStateMode: operation.observation.providerStateMode,
    workerImageDigest: operation.observation.workerImageDigest,
    inventoryDigest: operation.observation.inventoryDigest,
    approvalReference: operation.observation.approvalReference,
    observation: {
      sha256: operation.observationSha256,
      startedAtUtc: operation.observation.startedAtUtc,
      finishedAtUtc: operation.observation.finishedAtUtc,
      metrics: operation.observation.metrics,
      evidence: operation.observation.evidence,
    },
    previousReceiptSha256: operation.previous?.receiptSha256 ?? null,
    recordedAtUtc: now().toISOString(),
  };
  const payloadBytes = canonicalBytes(payload);
  const receipt = {
    schemaVersion: RUNTIME_PROVIDER_STATE_RECEIPT_SCHEMA,
    payload,
    payloadSha256: sha256(payloadBytes),
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptSha256 = sha256(receiptBytes);
  const temporary = `${operation.outputPath}.tmp-${process.pid}`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(receiptBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o440);
    await beforePublish();
    await link(temporary, operation.outputPath);
    await rm(temporary, { force: true });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error?.code === "EEXIST") throw rolloutError("RECEIPT_CONFLICT", "receipt creation raced with another operator");
    throw error;
  }
  return { created: true, receipt, receiptSha256 };
}

export function validateRolloutReceipt(document, binding) {
  assertExactKeys(document, ["schemaVersion", "payload", "payloadSha256"], "receipt");
  if (document.schemaVersion !== RUNTIME_PROVIDER_STATE_RECEIPT_SCHEMA) {
    throw rolloutError("RECEIPT_SCHEMA_INVALID", "receipt schemaVersion is invalid");
  }
  const payload = document.payload;
  assertExactKeys(payload, [
    "phase",
    "candidateSha",
    "environment",
    "projectionVersion",
    "providerStateMode",
    "workerImageDigest",
    "inventoryDigest",
    "approvalReference",
    "observation",
    "previousReceiptSha256",
    "recordedAtUtc",
  ], "receipt.payload");
  assertExactKeys(payload.environment, ["id", "kind"], "receipt.payload.environment");
  assertExactKeys(payload.observation, ["sha256", "startedAtUtc", "finishedAtUtc", "metrics", "evidence"], "receipt.payload.observation");
  if (payload.phase !== binding.phase || payload.candidateSha !== binding.candidateSha) {
    throw rolloutError("RECEIPT_BINDING_INVALID", "receipt phase or candidate binding is invalid");
  }
  if (payload.environment?.id !== binding.environmentId || payload.environment?.kind !== binding.environmentKind) {
    throw rolloutError("RECEIPT_BINDING_INVALID", "receipt environment binding is invalid");
  }
  if (payload.previousReceiptSha256 !== binding.previousReceiptSha256) {
    throw rolloutError("RECEIPT_CHAIN_INVALID", "receipt previous hash is invalid");
  }
  if (!SHA256_PATTERN.test(payload.observation?.sha256 ?? "")) throw rolloutError("RECEIPT_INVALID", "receipt observation hash is invalid");
  if (payload.projectionVersion !== 2) throw rolloutError("RECEIPT_INVALID", "receipt projection version is invalid");
  if (!SAFE_REFERENCE_PATTERN.test(payload.approvalReference ?? "")) {
    throw rolloutError("RECEIPT_INVALID", "receipt approval reference is invalid");
  }
  validatePhaseMode(payload.phase, payload.providerStateMode);
  validateImageBinding(payload);
  validatePhaseMetrics(payload.phase, payload.observation.metrics);
  validateEvidenceDescriptors(payload.observation.evidence);
  const observationStartedAt = requireUtc(payload.observation.startedAtUtc, "receipt observation startedAtUtc");
  const observationFinishedAt = requireUtc(payload.observation.finishedAtUtc, "receipt observation finishedAtUtc");
  const recordedAt = requireUtc(payload.recordedAtUtc, "receipt recordedAtUtc");
  if (observationFinishedAt <= observationStartedAt || recordedAt < observationFinishedAt) {
    throw rolloutError("RECEIPT_INVALID", "receipt timestamps are inconsistent");
  }
  const expectedPayloadSha256 = sha256(canonicalBytes(payload));
  if (document.payloadSha256 !== expectedPayloadSha256) throw rolloutError("RECEIPT_HASH_INVALID", "receipt payload hash is invalid");
  return structuredClone(document);
}

export async function verifyRolloutReceiptChain({
  candidateSha,
  environmentId,
  environmentKind,
  receiptsDirectory,
  throughPhase = "full",
}) {
  requirePattern(candidateSha, SOURCE_COMMIT_PATTERN, "CANDIDATE_INVALID", "candidate SHA");
  requirePattern(environmentId, SAFE_ID_PATTERN, "ENVIRONMENT_ID_INVALID", "environment ID");
  requireEnum(environmentKind, ENVIRONMENT_KINDS, "ENVIRONMENT_KIND_INVALID", "environment kind");
  const lastIndex = PHASE_INDEX.get(throughPhase);
  if (lastIndex === undefined) throw rolloutError("PHASE_INVALID", "rollout phase is invalid");
  let previousReceiptSha256 = null;
  const receipts = [];
  for (const phase of PHASES.slice(0, lastIndex + 1)) {
    const receiptPath = path.join(receiptsDirectory, RECEIPT_FILE_NAMES[phase]);
    const bytes = await stableReceiptFile(receiptPath, `${phase} receipt`);
    const receipt = validateRolloutReceipt(parseJson(bytes, `${phase} receipt`), {
      candidateSha,
      environmentId,
      environmentKind,
      phase,
      previousReceiptSha256,
    });
    previousReceiptSha256 = sha256(bytes);
    receipts.push({ phase, receiptSha256: previousReceiptSha256, receipt });
  }
  return { completeThrough: throughPhase, receipts, terminalReceiptSha256: previousReceiptSha256 };
}

function validatePhaseMode(phase, mode) {
  const expected = phase === "backfill"
    ? "legacy-read"
    : phase === "shadow" || phase === "canary"
      ? "shadow-verify"
      : "projection-required";
  if (mode !== expected) throw rolloutError("PROVIDER_STATE_MODE_INVALID", `${phase} observation requires ${expected}`);
}

function validateImageBinding(document) {
  if (document.phase === "backfill" || document.phase === "shadow") {
    if (document.workerImageDigest !== null || document.inventoryDigest !== null) {
      throw rolloutError("IMAGE_BINDING_INVALID", `${document.phase} observation must not claim a deployed worker image`);
    }
    return;
  }
  if (!DIGEST_PATTERN.test(document.workerImageDigest ?? "") || !SHA256_PATTERN.test(document.inventoryDigest ?? "")) {
    throw rolloutError("IMAGE_BINDING_INVALID", `${document.phase} observation requires immutable worker and inventory digests`);
  }
}

function validatePhaseMetrics(phase, metrics) {
  assertExactKeys(metrics, METRIC_KEYS[phase], `observation.metrics(${phase})`);
  for (const [name, value] of Object.entries(metrics)) {
    if (name === "rolloutBlocked") {
      if (value !== false) throw rolloutError("COVERAGE_BLOCKED", "backfill coverage reports rolloutBlocked");
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw rolloutError("METRIC_INVALID", `${name} must be a non-negative safe integer`);
    }
  }
  if (phase === "backfill") {
    const total = metrics.totalAttempts;
    if (
      metrics.expectedProjections !== total
      || metrics.built !== total
      || metrics.verified !== total
      || zeroInvariantMetric(metrics, ["missing", "conflicts", "lagging", "versionMismatch", "hashMismatch", "activeMissing", "terminalMissing"]) === false
    ) {
      throw rolloutError("COVERAGE_BLOCKED", "backfill coverage is not 100% verified");
    }
    return;
  }
  if (metrics.observedEvents < 1) throw rolloutError("OBSERVATION_EMPTY", `${phase} observation has no events`);
  const invariantKeys = phase === "shadow" || phase === "canary"
    ? ["shadowMismatches", "projectionInvariantErrors", "projectionLag", "providerStateP2028"]
    : ["projectionInvariantErrors", "projectionLag", "providerStateP2028", "terminalRunDrift"];
  if (!zeroInvariantMetric(metrics, invariantKeys)) {
    throw rolloutError("ROLLOUT_INVARIANT_FAILED", `${phase} observation contains a blocking Runtime invariant`);
  }
  if ("desiredWorkers" in metrics && (metrics.desiredWorkers < 1 || metrics.readyWorkers !== metrics.desiredWorkers)) {
    throw rolloutError("WORKER_READINESS_INVALID", `${phase} worker readiness is incomplete`);
  }
  if (phase === "full" && (metrics.legacyWorkerCount !== 0 || metrics.legacyReadTraffic !== 0)) {
    throw rolloutError("LEGACY_RESIDUAL_INVALID", "full rollout still has legacy workers or traffic");
  }
}

function validateEvidenceDescriptors(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 32) {
    throw rolloutError("EVIDENCE_INVALID", "observation evidence must contain 1-32 descriptors");
  }
  const paths = new Set();
  for (const [index, descriptor] of evidence.entries()) {
    assertExactKeys(descriptor, ["kind", "path", "sha256"], `observation.evidence[${index}]`);
    if (!SAFE_ID_PATTERN.test(descriptor.kind ?? "")) throw rolloutError("EVIDENCE_INVALID", "evidence kind is invalid");
    if (
      typeof descriptor.path !== "string"
      || descriptor.path.length < 1
      || descriptor.path.length > 512
      || descriptor.path.includes("\0")
      || /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(descriptor.path)
      || /(?:token|secret|password|database[_-]?url)/iu.test(descriptor.path)
    ) {
      throw rolloutError("EVIDENCE_INVALID", "evidence path is invalid or sensitive");
    }
    if (!SHA256_PATTERN.test(descriptor.sha256 ?? "")) throw rolloutError("EVIDENCE_INVALID", "evidence SHA-256 is invalid");
    if (paths.has(descriptor.path)) throw rolloutError("EVIDENCE_INVALID", "evidence paths must be unique");
    paths.add(descriptor.path);
  }
}

async function readPreviousReceipt(binding) {
  const index = PHASE_INDEX.get(binding.phase);
  if (index === 0) return null;
  const previousPhase = PHASES[index - 1];
  const previousPath = path.join(binding.receiptsDirectory, RECEIPT_FILE_NAMES[previousPhase]);
  const bytes = await stableReceiptFile(previousPath, `${previousPhase} receipt`).catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "RECEIPT_FILE_MISSING") {
      throw rolloutError("PREVIOUS_RECEIPT_MISSING", `${previousPhase} receipt is required before ${binding.phase}`);
    }
    throw error;
  });
  let previousReceiptSha256 = null;
  if (index > 1) {
    const ancestorPhase = PHASES[index - 2];
    const ancestorPath = path.join(binding.receiptsDirectory, RECEIPT_FILE_NAMES[ancestorPhase]);
    const ancestorBytes = await stableReceiptFile(ancestorPath, `${ancestorPhase} receipt`);
    previousReceiptSha256 = sha256(ancestorBytes);
  }
  const receipt = validateRolloutReceipt(parseJson(bytes, `${previousPhase} receipt`), {
    candidateSha: binding.candidateSha,
    environmentId: binding.environmentId,
    environmentKind: binding.environmentKind,
    phase: previousPhase,
    previousReceiptSha256,
  });
  return { phase: previousPhase, receiptSha256: sha256(bytes), receipt };
}

async function stableRegularFile(filePath, label) {
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw rolloutError("RECEIPT_FILE_MISSING", `${label} is missing`);
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw rolloutError("FILE_INVALID", `${label} must be a regular non-symlink file`);
  const bytes = await readFile(filePath);
  const after = await lstat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw rolloutError("FILE_CHANGED", `${label} changed while it was read`);
  }
  return { bytes, mode: after.mode };
}

async function readOptionalRegularFile(filePath) {
  try {
    return await stableReceiptFile(filePath, "existing receipt");
  } catch (error) {
    if (error?.code === "RECEIPT_FILE_MISSING") return null;
    throw error;
  }
}

async function stableReceiptFile(filePath, label) {
  const file = await stableRegularFile(filePath, label);
  if ((file.mode & 0o222) !== 0) {
    throw rolloutError("RECEIPT_FILE_MUTABLE", `${label} must be read-only`);
  }
  return file.bytes;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rolloutError("DOCUMENT_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw rolloutError("DOCUMENT_INVALID", `${label} fields are invalid`);
  }
}

function zeroInvariantMetric(metrics, keys) {
  return keys.every((key) => metrics[key] === 0);
}

function requirePattern(value, pattern, code, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw rolloutError(code, `${label} is invalid`);
  return value;
}

function requireEnum(value, values, code, label) {
  if (!values.has(value)) throw rolloutError(code, `${label} is invalid`);
  return value;
}

function requireUtc(value, label) {
  if (typeof value !== "string" || !UTC_PATTERN.test(value)) throw rolloutError("TIME_INVALID", `${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw rolloutError("TIME_INVALID", `${label} is invalid`);
  return parsed;
}

function requiredArgument(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw rolloutError("ARGUMENT_REQUIRED", `${flag} requires a value`);
  return value;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw rolloutError("JSON_INVALID", `${label} is not valid JSON`);
  }
}

function canonicalBytes(value) {
  const encoded = canonicalize(value);
  if (typeof encoded !== "string") throw rolloutError("CANONICALIZATION_FAILED", "receipt payload cannot be canonicalized");
  return Buffer.from(encoded);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rolloutError(code, message) {
  return new RuntimeProviderStateRolloutError(code, message);
}

function usage() {
  return [
    "Usage: node scripts/workbench-runtime-provider-state-rollout.mjs [--execute]",
    "  --phase <backfill|shadow|canary|cutover|full>",
    "  --candidate-sha <40-hex commit>",
    "  --environment-id <stable id>",
    "  --environment-kind <isolated|staging|production>",
    "  --observation <sanitized observation JSON>",
    "  --receipts-dir <durable receipt directory>",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseRolloutArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const operation = await prepareRolloutOperation(options);
  if (!operation.execute) {
    process.stdout.write(`${JSON.stringify(rolloutPlanDocument(operation), null, 2)}\n`);
    return;
  }
  const result = await executeRolloutOperation(operation);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    created: result.created,
    phase: operation.phase,
    candidateSha: operation.candidateSha,
    receiptSha256: result.receiptSha256,
    outputPath: operation.outputPath,
  }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    const code = error instanceof RuntimeProviderStateRolloutError ? error.code : "ROLLOUT_OPERATOR_FAILED";
    console.error(code);
    process.exitCode = 1;
  });
}
