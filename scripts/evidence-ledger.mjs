#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER_SCHEMA_VERSION = "workbench.evidence-ledger.v1";
export const INDEX_SCHEMA_VERSION = "workbench.evidence-index.v1";
export const DISCOVERY_STATUSES = Object.freeze([
  "CONFIRMED",
  "PLAUSIBLE",
  "REFUTED",
]);
export const EXECUTION_STATUSES = Object.freeze([
  "PASS",
  "FAIL",
  "NOT RUN",
  "BLOCKED",
  "INCONCLUSIVE",
  "N/A",
]);
export const EVIDENCE_LEVELS = Object.freeze(["E1", "E2", "E3", "E4"]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const FILE_URI_PATTERN = /^file:\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const OCI_URI_PATTERN = /^oci:\/\/[^\s?#]+@sha256:([0-9a-f]{64})$/;
const URN_SHA_URI_PATTERN = /^urn:sha256:([0-9a-f]{64})$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "credential",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
]);
const TEXT_SECRET_PATTERNS = [
  { name: "private key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i },
  { name: "bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    name: "assigned credential",
    pattern: /\b(?:api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|secret|token)\b\s*[:=]\s*["']?(?!\$\{|\$[A-Z_]|<redacted>|\[redacted\]|redacted\b|none\b|null\b)[A-Za-z0-9._~+\/-]{8,}/i,
  },
];

export class EvidenceValidationError extends Error {
  constructor(errors) {
    const normalized = [...new Set(errors)].sort();
    super(`Evidence validation failed (${normalized.length} error${normalized.length === 1 ? "" : "s"}):\n${normalized.map((error) => `- ${error}`).join("\n")}`);
    this.name = "EvidenceValidationError";
    this.errors = normalized;
  }
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonicalValue(value));
}

export function canonicalJsonFile(value) {
  return `${canonicalJson(value)}\n`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value) {
  return sha256Bytes(canonicalJson(value));
}

export function sealEvidenceLedger(payload) {
  const normalizedPayload = normalizeLedgerPayload(payload);
  const sealed = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    payload: normalizedPayload,
  };
  return {
    ...sealed,
    payloadSha256: sha256Canonical(sealed),
  };
}

export function sealEvidenceIndex(payload) {
  const normalizedPayload = normalizeIndexPayload(payload);
  const sealed = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    payload: normalizedPayload,
  };
  return {
    ...sealed,
    payloadSha256: sha256Canonical(sealed),
  };
}

export async function verifyEvidenceLedger({
  ledgerPath,
  root = process.cwd(),
  expectedBinding,
  candidateManifestPath,
  visitedLedgerPaths = new Set(),
} = {}) {
  const errors = [];
  const resolvedRoot = await resolveVerificationRoot(root, errors);
  const resolvedLedgerPath = await resolveInputPath(ledgerPath, resolvedRoot, "ledger", errors);
  if (errors.length) throw new EvidenceValidationError(errors);

  const ledgerIdentity = await realpath(resolvedLedgerPath);
  if (visitedLedgerPaths.has(ledgerIdentity)) {
    throw new EvidenceValidationError([`ledger chain contains a cycle at ${displayPath(resolvedRoot, resolvedLedgerPath)}`]);
  }
  const nextVisited = new Set(visitedLedgerPaths);
  nextVisited.add(ledgerIdentity);

  const { document, raw } = await readCanonicalDocument(resolvedLedgerPath, "ledger", errors);
  if (document) {
    validateLedgerDocument(document, errors);
    validatePayloadSeal(document, errors, "ledger");
    scanJsonForSecretKeys(document, "$", errors);
    scanTextForSecrets(raw, `ledger ${displayPath(resolvedRoot, resolvedLedgerPath)}`, errors);
  }
  if (!document || errors.length) throw new EvidenceValidationError(errors);

  validateExpectedBinding(document.payload.binding, expectedBinding, errors, "ledger binding");
  for (const entry of document.payload.entries) {
    validateEntryBindings(entry, document.payload.binding, errors);
  }

  const verifiedEvidence = [];
  for (const entry of document.payload.entries) {
    for (const evidence of entry.evidence) {
      verifiedEvidence.push(await verifyEvidenceReference(evidence, {
        root: resolvedRoot,
        context: `entry ${entry.entryId} evidence`,
        scanSecrets: true,
        errors,
      }));
    }
    for (const retry of entry.retryRecords) {
      for (const evidence of retry.evidence) {
        verifiedEvidence.push(await verifyEvidenceReference(evidence, {
          root: resolvedRoot,
          context: `entry ${entry.entryId} retry ${retry.attempt} evidence`,
          scanSecrets: true,
          errors,
        }));
      }
    }
  }

  let candidateManifest;
  if (document.payload.binding.candidateManifest) {
    candidateManifest = await verifyEvidenceReference(document.payload.binding.candidateManifest, {
      root: resolvedRoot,
      context: "candidate manifest",
      scanSecrets: true,
      errors,
    });
  }
  if (candidateManifestPath) {
    await validateCandidateManifest({
      manifestPath: candidateManifestPath,
      expectedReference: document.payload.binding.candidateManifest,
      candidateManifest,
      expectedBinding: {
        candidateId: document.payload.binding.candidateId,
        deployId: document.payload.binding.deployId,
        environmentId: document.payload.binding.environmentId,
        commitSha: document.payload.binding.commitSha,
        tag: document.payload.binding.tag,
      },
      root: resolvedRoot,
      errors,
    });
  }

  if (document.payload.previousLedger) {
    const previous = await verifyEvidenceReference(document.payload.previousLedger, {
      root: resolvedRoot,
      context: "previous ledger",
      scanSecrets: true,
      requireLocal: true,
      errors,
    });
    if (previous?.absolutePath) {
      try {
        const previousReport = await verifyEvidenceLedger({
          ledgerPath: previous.absolutePath,
          root: resolvedRoot,
          expectedBinding,
          visitedLedgerPaths: nextVisited,
        });
        if (previousReport.ledgerId !== document.payload.previousLedger.ledgerId) {
          errors.push(`previous ledger ID mismatch: expected ${document.payload.previousLedger.ledgerId}, got ${previousReport.ledgerId}`);
        }
      } catch (error) {
        appendValidationError(errors, "previous ledger", error);
      }
    }
  }

  if (errors.length) throw new EvidenceValidationError(errors);
  return {
    ok: true,
    ledgerId: document.payload.ledgerId,
    ledgerPath: resolvedLedgerPath,
    ledgerSha256: sha256Bytes(raw),
    payloadSha256: document.payloadSha256,
    binding: { ...document.payload.binding },
    entries: document.payload.entries.length,
    localEvidenceFiles: verifiedEvidence.filter((entry) => entry?.absolutePath).length,
  };
}

export async function verifyEvidenceIndex({
  indexPath,
  root = process.cwd(),
  expectedBinding,
  candidateManifestPath,
} = {}) {
  const errors = [];
  const resolvedRoot = await resolveVerificationRoot(root, errors);
  const resolvedIndexPath = await resolveInputPath(indexPath, resolvedRoot, "index", errors);
  if (errors.length) throw new EvidenceValidationError(errors);

  const { document, raw } = await readCanonicalDocument(resolvedIndexPath, "index", errors);
  if (document) {
    validateIndexDocument(document, errors);
    validatePayloadSeal(document, errors, "index");
    scanJsonForSecretKeys(document, "$", errors);
    scanTextForSecrets(raw, `index ${displayPath(resolvedRoot, resolvedIndexPath)}`, errors);
    rejectIndexStateDuplication(document, errors);
  }
  if (!document || errors.length) throw new EvidenceValidationError(errors);

  const ledgers = [];
  for (const reference of document.payload.ledgerReferences) {
    const verified = await verifyEvidenceReference(reference, {
      root: resolvedRoot,
      context: `index ledger ${reference.ledgerId}`,
      scanSecrets: true,
      requireLocal: true,
      errors,
    });
    if (!verified?.absolutePath) continue;
    try {
      const report = await verifyEvidenceLedger({
        ledgerPath: verified.absolutePath,
        root: resolvedRoot,
        expectedBinding,
        candidateManifestPath,
      });
      if (report.ledgerId !== reference.ledgerId) {
        errors.push(`index ledger ID mismatch for ${reference.uri}: expected ${reference.ledgerId}, got ${report.ledgerId}`);
      }
      ledgers.push(report);
    } catch (error) {
      appendValidationError(errors, `index ledger ${reference.ledgerId}`, error);
    }
  }

  if (errors.length) throw new EvidenceValidationError(errors);
  return {
    ok: true,
    indexId: document.payload.indexId,
    indexPath: resolvedIndexPath,
    indexSha256: sha256Bytes(raw),
    payloadSha256: document.payloadSha256,
    ledgers,
  };
}

function normalizeCanonicalValue(value, location = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${location} contains a non-finite number`);
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeCanonicalValue(item, `${location}[${index}]`));
  }
  if (!isPlainObject(value)) throw new TypeError(`${location} is not a JSON value`);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`${location}.${key} is undefined`);
    output[key] = normalizeCanonicalValue(value[key], `${location}.${key}`);
  }
  return output;
}

function normalizeLedgerPayload(payload) {
  const result = structuredClone(payload);
  if (!isPlainObject(result)) return result;
  if (Array.isArray(result.entries)) {
    result.entries.sort(compareBy((entry) => entry?.entryId ?? ""));
    for (const entry of result.entries) {
      if (!isPlainObject(entry)) continue;
      sortArray(entry.evidence, compareBy((item) => item?.uri ?? ""));
      sortArray(entry.toolVersions, compareBy((item) => `${item?.name ?? ""}\0${item?.version ?? ""}`));
      sortArray(entry.relatedFindingsOrDecisions, compareBy((item) => `${item?.kind ?? ""}\0${item?.id ?? ""}`));
      sortArray(entry.retryRecords, (left, right) => (left?.attempt ?? 0) - (right?.attempt ?? 0));
      if (isPlainObject(entry.binding) && isPlainObject(entry.binding.digests)) {
        sortArray(entry.binding.digests.images, compareBy((item) => item?.name ?? ""));
      }
      if (Array.isArray(entry.retryRecords)) {
        for (const retry of entry.retryRecords) sortArray(retry?.evidence, compareBy((item) => item?.uri ?? ""));
      }
    }
  }
  return result;
}

function normalizeIndexPayload(payload) {
  const result = structuredClone(payload);
  if (isPlainObject(result)) {
    sortArray(result.ledgerReferences, compareBy((item) => `${item?.ledgerId ?? ""}\0${item?.uri ?? ""}`));
  }
  return result;
}

function validateLedgerDocument(document, errors) {
  if (!expectObject(document, "$", errors)) return;
  expectExactKeys(document, ["schemaVersion", "payload", "payloadSha256"], [], "$", errors);
  expectLiteral(document.schemaVersion, LEDGER_SCHEMA_VERSION, "$.schemaVersion", errors);
  expectSha256(document.payloadSha256, "$.payloadSha256", errors);
  if (!expectObject(document.payload, "$.payload", errors)) return;
  const payload = document.payload;
  expectExactKeys(payload, ["ledgerId", "createdAtUtc", "binding", "previousLedger", "entries"], [], "$.payload", errors);
  expectIdentifier(payload.ledgerId, "$.payload.ledgerId", errors);
  expectUtc(payload.createdAtUtc, "$.payload.createdAtUtc", errors);
  validateLedgerBinding(payload.binding, "$.payload.binding", errors, { allowManifest: true });
  if (payload.previousLedger !== null) validateLedgerReference(payload.previousLedger, "$.payload.previousLedger", errors);
  if (!expectArray(payload.entries, "$.payload.entries", errors, { min: 1 })) return;
  const entryIds = new Set();
  let previousEntryId = "";
  for (let index = 0; index < payload.entries.length; index += 1) {
    const entry = payload.entries[index];
    const location = `$.payload.entries[${index}]`;
    validateLedgerEntry(entry, location, errors);
    if (!isPlainObject(entry) || typeof entry.entryId !== "string") continue;
    if (entryIds.has(entry.entryId)) errors.push(`${location}.entryId duplicates ${entry.entryId}`);
    entryIds.add(entry.entryId);
    if (previousEntryId && previousEntryId.localeCompare(entry.entryId) >= 0) {
      errors.push("$.payload.entries must be sorted by unique entryId");
    }
    previousEntryId = entry.entryId;
  }
}

function validateLedgerEntry(entry, location, errors) {
  if (!expectObject(entry, location, errors)) return;
  expectExactKeys(entry, [
    "entryId",
    "gateId",
    "controlObjective",
    "environment",
    "prerequisites",
    "procedure",
    "expectedObservation",
    "threshold",
    "findingStatus",
    "executionStatus",
    "evidenceLevel",
    "executedAtUtc",
    "executor",
    "binding",
    "toolVersions",
    "evidence",
    "retryRecords",
    "relatedFindingsOrDecisions",
  ], ["notApplicable"], location, errors);
  expectIdentifier(entry.entryId, `${location}.entryId`, errors);
  expectIdentifier(entry.gateId, `${location}.gateId`, errors);
  expectNonEmptyString(entry.controlObjective, `${location}.controlObjective`, errors, 4096);
  validateEnvironment(entry.environment, `${location}.environment`, errors);
  validateStringArray(entry.prerequisites, `${location}.prerequisites`, errors, { min: 0 });
  validateProcedure(entry.procedure, `${location}.procedure`, errors);
  expectNonEmptyString(entry.expectedObservation, `${location}.expectedObservation`, errors, 4096);
  validateThreshold(entry.threshold, `${location}.threshold`, errors);
  expectEnum(entry.findingStatus, DISCOVERY_STATUSES, `${location}.findingStatus`, errors);
  expectEnum(entry.executionStatus, EXECUTION_STATUSES, `${location}.executionStatus`, errors);
  expectEnum(entry.evidenceLevel, EVIDENCE_LEVELS, `${location}.evidenceLevel`, errors);
  expectUtc(entry.executedAtUtc, `${location}.executedAtUtc`, errors);
  validateExecutor(entry.executor, `${location}.executor`, errors);
  validateLedgerBinding(entry.binding, `${location}.binding`, errors, { allowManifest: false });
  validateToolVersions(entry.toolVersions, `${location}.toolVersions`, errors);
  validateEvidenceReferences(entry.evidence, `${location}.evidence`, errors, { min: 1 });
  validateRetryRecords(entry.retryRecords, `${location}.retryRecords`, errors);
  validateRelated(entry.relatedFindingsOrDecisions, `${location}.relatedFindingsOrDecisions`, errors);

  if (entry.executionStatus === "N/A") {
    validateNotApplicable(entry.notApplicable, `${location}.notApplicable`, errors);
  } else if (Object.hasOwn(entry, "notApplicable")) {
    errors.push(`${location}.notApplicable is only allowed when executionStatus is N/A`);
  }
}

function validateLedgerBinding(binding, location, errors, { allowManifest }) {
  if (!expectObject(binding, location, errors)) return;
  expectExactKeys(binding, [
    "candidateId",
    "deployId",
    "environmentId",
    "commitSha",
    "tag",
    "releaseChainId",
    "digests",
  ], allowManifest ? ["candidateManifest"] : [], location, errors);
  expectIdentifier(binding.candidateId, `${location}.candidateId`, errors);
  expectIdentifier(binding.deployId, `${location}.deployId`, errors);
  expectIdentifier(binding.environmentId, `${location}.environmentId`, errors);
  if (typeof binding.commitSha !== "string" || !GIT_COMMIT_PATTERN.test(binding.commitSha)) {
    errors.push(`${location}.commitSha must be a lowercase 40- or 64-hex Git commit`);
  }
  expectIdentifier(binding.tag, `${location}.tag`, errors);
  if (typeof binding.releaseChainId !== "string" || !DIGEST_PATTERN.test(binding.releaseChainId)) {
    errors.push(`${location}.releaseChainId must be sha256:<64 lowercase hex>`);
  }
  validateDigests(binding.digests, `${location}.digests`, errors);
  if (allowManifest && binding.candidateManifest !== undefined) {
    validateEvidenceReferenceShape(binding.candidateManifest, `${location}.candidateManifest`, errors);
  }
}

function validateEntryBindings(entry, ledgerBinding, errors) {
  const location = `entry ${entry.entryId}`;
  for (const key of ["candidateId", "deployId", "environmentId", "commitSha", "tag", "releaseChainId"]) {
    if (entry.binding[key] !== ledgerBinding[key]) {
      errors.push(`${location} ${key} does not match the ledger binding`);
    }
  }
  if (entry.environment.environmentId !== ledgerBinding.environmentId) {
    errors.push(`${location} environment.environmentId does not match the ledger binding`);
  }
  if (canonicalJson(entry.binding.digests) !== canonicalJson(ledgerBinding.digests)) {
    errors.push(`${location} image/config/migration digests do not match the ledger binding`);
  }
}

function validateDigests(digests, location, errors) {
  if (!expectObject(digests, location, errors)) return;
  expectExactKeys(digests, [
    "images",
    "configSha256",
    "migrationSha256",
    "deploymentConfigManifestSha256",
    "imageManifestSha256",
    "controlCatalogSha256",
  ], [], location, errors);
  expectSha256(digests.configSha256, `${location}.configSha256`, errors);
  expectSha256(digests.migrationSha256, `${location}.migrationSha256`, errors);
  expectSha256(digests.deploymentConfigManifestSha256, `${location}.deploymentConfigManifestSha256`, errors);
  expectSha256(digests.imageManifestSha256, `${location}.imageManifestSha256`, errors);
  expectSha256(digests.controlCatalogSha256, `${location}.controlCatalogSha256`, errors);
  if (!expectArray(digests.images, `${location}.images`, errors, { min: 0 })) return;
  const names = new Set();
  let previousName = "";
  for (let index = 0; index < digests.images.length; index += 1) {
    const image = digests.images[index];
    const imageLocation = `${location}.images[${index}]`;
    if (!expectObject(image, imageLocation, errors)) continue;
    expectExactKeys(image, ["name", "digest"], [], imageLocation, errors);
    expectIdentifier(image.name, `${imageLocation}.name`, errors);
    if (typeof image.digest !== "string" || !DIGEST_PATTERN.test(image.digest)) {
      errors.push(`${imageLocation}.digest must be sha256:<64 lowercase hex>`);
    }
    if (names.has(image.name)) errors.push(`${imageLocation}.name duplicates ${image.name}`);
    names.add(image.name);
    if (previousName && previousName.localeCompare(image.name) >= 0) errors.push(`${location}.images must be sorted by unique name`);
    previousName = image.name;
  }
}

function validateEnvironment(environment, location, errors) {
  if (!expectObject(environment, location, errors)) return;
  expectExactKeys(environment, ["environmentId", "kind", "description"], ["region"], location, errors);
  expectIdentifier(environment.environmentId, `${location}.environmentId`, errors);
  expectEnum(environment.kind, ["local", "ci", "server", "staging", "production"], `${location}.kind`, errors);
  expectNonEmptyString(environment.description, `${location}.description`, errors, 1024);
  if (environment.region !== undefined) expectNonEmptyString(environment.region, `${location}.region`, errors, 128);
}

function validateProcedure(procedure, location, errors) {
  if (!expectObject(procedure, location, errors)) return;
  expectExactKeys(procedure, ["kind"], ["command", "steps"], location, errors);
  expectEnum(procedure.kind, ["command", "steps"], `${location}.kind`, errors);
  if (procedure.kind === "command") {
    expectNonEmptyString(procedure.command, `${location}.command`, errors, 16384);
    if (Object.hasOwn(procedure, "steps")) errors.push(`${location}.steps is not allowed for command procedure`);
  } else if (procedure.kind === "steps") {
    validateStringArray(procedure.steps, `${location}.steps`, errors, { min: 1, maxLength: 4096 });
    if (Object.hasOwn(procedure, "command")) errors.push(`${location}.command is not allowed for steps procedure`);
  }
}

function validateThreshold(threshold, location, errors) {
  if (!expectObject(threshold, location, errors)) return;
  expectExactKeys(threshold, ["kind", "operator", "expected"], ["unit"], location, errors);
  expectEnum(threshold.kind, ["boolean", "number"], `${location}.kind`, errors);
  if (threshold.kind === "boolean") {
    expectLiteral(threshold.operator, "eq", `${location}.operator`, errors);
    if (typeof threshold.expected !== "boolean") errors.push(`${location}.expected must be boolean for a boolean threshold`);
    if (Object.hasOwn(threshold, "unit")) errors.push(`${location}.unit is not allowed for a boolean threshold`);
  } else if (threshold.kind === "number") {
    expectEnum(threshold.operator, ["eq", "lt", "lte", "gt", "gte"], `${location}.operator`, errors);
    if (typeof threshold.expected !== "number" || !Number.isFinite(threshold.expected)) errors.push(`${location}.expected must be a finite number`);
    if (threshold.unit !== undefined) expectNonEmptyString(threshold.unit, `${location}.unit`, errors, 128);
  }
}

function validateExecutor(executor, location, errors) {
  if (!expectObject(executor, location, errors)) return;
  expectExactKeys(executor, ["id", "kind"], ["displayName"], location, errors);
  expectIdentifier(executor.id, `${location}.id`, errors);
  expectEnum(executor.kind, ["person", "auditor", "ci", "automation"], `${location}.kind`, errors);
  if (executor.displayName !== undefined) expectNonEmptyString(executor.displayName, `${location}.displayName`, errors, 256);
}

function validateToolVersions(toolVersions, location, errors) {
  if (!expectArray(toolVersions, location, errors, { min: 1 })) return;
  const keys = new Set();
  let previous = "";
  for (let index = 0; index < toolVersions.length; index += 1) {
    const tool = toolVersions[index];
    const toolLocation = `${location}[${index}]`;
    if (!expectObject(tool, toolLocation, errors)) continue;
    expectExactKeys(tool, ["name", "version"], [], toolLocation, errors);
    expectNonEmptyString(tool.name, `${toolLocation}.name`, errors, 128);
    expectNonEmptyString(tool.version, `${toolLocation}.version`, errors, 1024);
    const key = `${tool.name}\0${tool.version}`;
    if (keys.has(key)) errors.push(`${toolLocation} duplicates ${tool.name} ${tool.version}`);
    keys.add(key);
    if (previous && previous.localeCompare(key) >= 0) errors.push(`${location} must be sorted by name and version`);
    previous = key;
  }
}

function validateRetryRecords(retries, location, errors) {
  if (!expectArray(retries, location, errors, { min: 0 })) return;
  let previousAttempt = 0;
  for (let index = 0; index < retries.length; index += 1) {
    const retry = retries[index];
    const retryLocation = `${location}[${index}]`;
    if (!expectObject(retry, retryLocation, errors)) continue;
    expectExactKeys(retry, ["attempt", "executedAtUtc", "executionStatus", "reason", "evidence"], [], retryLocation, errors);
    if (!Number.isInteger(retry.attempt) || retry.attempt < 1) errors.push(`${retryLocation}.attempt must be an integer >= 1`);
    if (retry.attempt <= previousAttempt) errors.push(`${location} must be sorted by unique ascending attempt`);
    previousAttempt = retry.attempt;
    expectUtc(retry.executedAtUtc, `${retryLocation}.executedAtUtc`, errors);
    expectEnum(retry.executionStatus, EXECUTION_STATUSES, `${retryLocation}.executionStatus`, errors);
    expectNonEmptyString(retry.reason, `${retryLocation}.reason`, errors, 4096);
    validateEvidenceReferences(retry.evidence, `${retryLocation}.evidence`, errors, { min: 1 });
  }
}

function validateRelated(related, location, errors) {
  if (!expectArray(related, location, errors, { min: 1 })) return;
  const keys = new Set();
  let previous = "";
  for (let index = 0; index < related.length; index += 1) {
    const item = related[index];
    const itemLocation = `${location}[${index}]`;
    if (!expectObject(item, itemLocation, errors)) continue;
    expectExactKeys(item, ["kind", "id"], [], itemLocation, errors);
    expectEnum(item.kind, ["finding", "decision"], `${itemLocation}.kind`, errors);
    expectIdentifier(item.id, `${itemLocation}.id`, errors);
    const key = `${item.kind}\0${item.id}`;
    if (keys.has(key)) errors.push(`${itemLocation} duplicates ${item.kind} ${item.id}`);
    keys.add(key);
    if (previous && previous.localeCompare(key) >= 0) errors.push(`${location} must be sorted by kind and id`);
    previous = key;
  }
}

function validateNotApplicable(value, location, errors) {
  if (!expectObject(value, location, errors)) return;
  expectExactKeys(value, ["scopeBasis", "approver", "expiresAtUtc"], [], location, errors);
  expectNonEmptyString(value.scopeBasis, `${location}.scopeBasis`, errors, 4096);
  expectIdentifier(value.approver, `${location}.approver`, errors);
  expectUtc(value.expiresAtUtc, `${location}.expiresAtUtc`, errors);
}

function validateIndexDocument(document, errors) {
  if (!expectObject(document, "$", errors)) return;
  expectExactKeys(document, ["schemaVersion", "payload", "payloadSha256"], [], "$", errors);
  expectLiteral(document.schemaVersion, INDEX_SCHEMA_VERSION, "$.schemaVersion", errors);
  expectSha256(document.payloadSha256, "$.payloadSha256", errors);
  if (!expectObject(document.payload, "$.payload", errors)) return;
  expectExactKeys(document.payload, ["indexId", "createdAtUtc", "ledgerReferences"], [], "$.payload", errors);
  expectIdentifier(document.payload.indexId, "$.payload.indexId", errors);
  expectUtc(document.payload.createdAtUtc, "$.payload.createdAtUtc", errors);
  if (!expectArray(document.payload.ledgerReferences, "$.payload.ledgerReferences", errors, { min: 1 })) return;
  const ids = new Set();
  let previous = "";
  for (let index = 0; index < document.payload.ledgerReferences.length; index += 1) {
    const reference = document.payload.ledgerReferences[index];
    const location = `$.payload.ledgerReferences[${index}]`;
    validateLedgerReference(reference, location, errors);
    if (!isPlainObject(reference)) continue;
    if (ids.has(reference.ledgerId)) errors.push(`${location}.ledgerId duplicates ${reference.ledgerId}`);
    ids.add(reference.ledgerId);
    const key = `${reference.ledgerId ?? ""}\0${reference.uri ?? ""}`;
    if (previous && previous.localeCompare(key) >= 0) errors.push("$.payload.ledgerReferences must be sorted by unique ledgerId and URI");
    previous = key;
  }
}

function validateLedgerReference(reference, location, errors) {
  if (!expectObject(reference, location, errors)) return;
  expectExactKeys(reference, ["ledgerId", "uri", "sha256"], [], location, errors);
  expectIdentifier(reference.ledgerId, `${location}.ledgerId`, errors);
  validateEvidenceReferenceShape(reference, location, errors, { allowLedgerId: true, requireLocal: true });
}

function validateEvidenceReferences(references, location, errors, { min }) {
  if (!expectArray(references, location, errors, { min })) return;
  const uris = new Set();
  let previous = "";
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const referenceLocation = `${location}[${index}]`;
    validateEvidenceReferenceShape(reference, referenceLocation, errors);
    if (!isPlainObject(reference) || typeof reference.uri !== "string") continue;
    if (uris.has(reference.uri)) errors.push(`${referenceLocation}.uri duplicates ${reference.uri}`);
    uris.add(reference.uri);
    if (previous && previous.localeCompare(reference.uri) >= 0) errors.push(`${location} must be sorted by unique URI`);
    previous = reference.uri;
  }
}

function validateEvidenceReferenceShape(reference, location, errors, { allowLedgerId = false, requireLocal = false } = {}) {
  if (!expectObject(reference, location, errors)) return;
  expectExactKeys(reference, ["uri", "sha256"], allowLedgerId ? ["ledgerId"] : [], location, errors);
  expectSha256(reference.sha256, `${location}.sha256`, errors);
  if (typeof reference.uri !== "string") {
    errors.push(`${location}.uri must be a string`);
    return;
  }
  const uri = classifyImmutableUri(reference.uri, reference.sha256);
  if (!uri.ok) errors.push(`${location}.uri ${uri.error}`);
  if (requireLocal && uri.kind !== "file") errors.push(`${location}.uri must be a repository-relative file URI`);
}

function validatePayloadSeal(document, errors, kind) {
  if (!isPlainObject(document) || typeof document.schemaVersion !== "string" || !isPlainObject(document.payload)) return;
  const expected = sha256Canonical({ schemaVersion: document.schemaVersion, payload: document.payload });
  if (document.payloadSha256 !== expected) {
    errors.push(`${kind} payload SHA-256 mismatch: expected ${expected}, got ${String(document.payloadSha256)}`);
  }
}

async function readCanonicalDocument(filePath, kind, errors) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    errors.push(`cannot read ${kind} ${filePath}: ${error.message}`);
    return {};
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    errors.push(`${kind} is not valid JSON: ${error.message}`);
    return { raw };
  }
  let canonical;
  try {
    canonical = canonicalJsonFile(document);
  } catch (error) {
    errors.push(`${kind} cannot be canonicalized: ${error.message}`);
    return { document, raw };
  }
  if (raw !== canonical) errors.push(`${kind} JSON is not canonical (sorted keys, compact encoding, one trailing LF required)`);
  return { document, raw };
}

async function verifyEvidenceReference(reference, {
  root,
  context,
  scanSecrets,
  requireLocal = false,
  errors,
}) {
  if (!isPlainObject(reference) || typeof reference.uri !== "string" || typeof reference.sha256 !== "string") return undefined;
  const classified = classifyImmutableUri(reference.uri, reference.sha256);
  if (!classified.ok) {
    errors.push(`${context} URI ${classified.error}`);
    return undefined;
  }
  if (requireLocal && classified.kind !== "file") {
    errors.push(`${context} must use a repository-relative file URI so the referenced ledger can be verified`);
    return undefined;
  }
  if (classified.kind !== "file") {
    return { uri: reference.uri, sha256: reference.sha256, remote: true };
  }

  const absolutePath = path.resolve(root, classified.relativePath);
  if (!isPathInside(root, absolutePath)) {
    errors.push(`${context} escapes verification root: ${reference.uri}`);
    return undefined;
  }
  let stat;
  let canonicalPath;
  try {
    stat = await lstat(absolutePath);
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    errors.push(`${context} does not exist: ${reference.uri} (${error.code ?? error.message})`);
    return undefined;
  }
  if (!stat.isFile()) {
    errors.push(`${context} is not a regular file: ${reference.uri}`);
    return undefined;
  }
  if (stat.isSymbolicLink() || canonicalPath !== absolutePath || !isPathInside(root, canonicalPath)) {
    errors.push(`${context} must not resolve through a symbolic link: ${reference.uri}`);
    return undefined;
  }
  let bytes;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    errors.push(`${context} cannot be read: ${reference.uri} (${error.message})`);
    return undefined;
  }
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== reference.sha256) {
    errors.push(`${context} SHA-256 mismatch for ${reference.uri}: expected ${reference.sha256}, got ${actualSha256}`);
  }
  if (scanSecrets) scanTextForSecrets(bytes.toString("utf8"), `${context} ${reference.uri}`, errors);
  return { uri: reference.uri, sha256: actualSha256, absolutePath, bytes };
}

function classifyImmutableUri(uri, expectedSha256) {
  if (typeof uri !== "string" || uri.length > 2048) return { ok: false, error: "must be a string of at most 2048 characters" };
  if (FILE_URI_PATTERN.test(uri)) {
    const relativePath = uri.slice("file:./".length);
    if (relativePath.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
      return { ok: false, error: "contains an unsafe path segment" };
    }
    return { ok: true, kind: "file", relativePath };
  }
  if (uri.startsWith("file:")) return { ok: false, error: "must be repository-relative file:./path without traversal or encoding" };

  const urn = uri.match(URN_SHA_URI_PATTERN);
  if (urn) {
    if (urn[1] !== expectedSha256) return { ok: false, error: "content-addressed digest does not match sha256" };
    return { ok: true, kind: "remote" };
  }
  const oci = uri.match(OCI_URI_PATTERN);
  if (oci) {
    if (oci[1] !== expectedSha256) return { ok: false, error: "OCI digest does not match sha256" };
    return { ok: true, kind: "remote" };
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, error: "is not an allowed immutable URI" };
  }
  if (parsed.username || parsed.password || parsed.hash) return { ok: false, error: "must not contain credentials or fragments" };
  if (hasCredentialQueryParameter(parsed)) return { ok: false, error: "must not contain signed URL or credential query parameters" };
  if (parsed.protocol === "http:") return { ok: false, error: "uses mutable/insecure HTTP" };
  if (parsed.protocol === "s3:") {
    const versionId = parsed.searchParams.get("versionId");
    if (!isImmutableVersion(versionId)) return { ok: false, error: "S3 URI requires a non-mutable versionId" };
    return { ok: true, kind: "remote" };
  }
  if (parsed.protocol === "gs:") {
    const generation = parsed.searchParams.get("generation");
    if (!generation || !/^\d+$/.test(generation)) return { ok: false, error: "GCS URI requires a numeric generation" };
    return { ok: true, kind: "remote" };
  }
  if (parsed.protocol === "az:") {
    const versionId = parsed.searchParams.get("versionid");
    if (!isImmutableVersion(versionId)) return { ok: false, error: "Azure URI requires a non-mutable versionid" };
    return { ok: true, kind: "remote" };
  }
  if (parsed.protocol === "https:") {
    const digest = parsed.searchParams.get("sha256") ?? parsed.searchParams.get("digest");
    const version = parsed.searchParams.get("versionId") ?? parsed.searchParams.get("generation");
    const pathHasDigest = parsed.pathname.toLowerCase().includes(expectedSha256);
    const pathHasCommit = parsed.pathname.split("/").some((part) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(part));
    const digestMatches = digest === expectedSha256 || digest === `sha256:${expectedSha256}`;
    if (!digestMatches && !pathHasDigest && !pathHasCommit && !isImmutableVersion(version)) {
      return { ok: false, error: "HTTPS URI is mutable; bind a digest, commit, versionId, or generation" };
    }
    return { ok: true, kind: "remote" };
  }
  return { ok: false, error: `uses unsupported scheme ${parsed.protocol}` };
}

function isImmutableVersion(value) {
  return typeof value === "string" && value.length > 0 && !/^(?:latest|null|current|head)$/i.test(value);
}

function hasCredentialQueryParameter(parsed) {
  const forbidden = new Set([
    "accesstoken",
    "apikey",
    "authorization",
    "key",
    "signature",
    "sig",
    "token",
    "xamzcredential",
    "xamzsecuritytoken",
    "xamzsignature",
    "xgoogcredential",
    "xgoogsignature",
  ]);
  return [...parsed.searchParams.keys()].some((key) => forbidden.has(normalizeKey(key)));
}

async function validateCandidateManifest({
  manifestPath,
  expectedReference,
  candidateManifest,
  expectedBinding,
  root,
  errors,
}) {
  if (!expectedReference) {
    errors.push("--candidate-manifest was supplied but ledger binding has no candidateManifest reference");
    return;
  }
  const requestedPath = path.resolve(root, manifestPath);
  let requestedStat;
  let canonicalManifestPath;
  let manifestBytes;
  try {
    requestedStat = await lstat(requestedPath);
    canonicalManifestPath = await realpath(requestedPath);
    manifestBytes = await readFile(canonicalManifestPath);
  } catch (error) {
    errors.push(`cannot read --candidate-manifest: ${error.message}`);
    return;
  }
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) {
    errors.push("--candidate-manifest must be a regular file and must not resolve through a symbolic link");
    return;
  }
  const actualSha256 = sha256Bytes(manifestBytes);
  if (actualSha256 !== expectedReference.sha256) {
    errors.push(`candidate manifest SHA-256 mismatch: expected ${expectedReference.sha256}, got ${actualSha256}`);
    return;
  }
  const referenceKind = classifyImmutableUri(expectedReference.uri, expectedReference.sha256);
  if (referenceKind.kind === "file" && (!candidateManifest?.absolutePath || canonicalManifestPath !== candidateManifest.absolutePath)) {
    errors.push("--candidate-manifest does not identify the file referenced by ledger binding.candidateManifest");
    return;
  }
  scanTextForSecrets(manifestBytes.toString("utf8"), "candidate manifest", errors);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    errors.push(`candidate manifest is not valid JSON: ${error.message}`);
    return;
  }
  scanJsonForSecretKeys(manifest, "$candidateManifest", errors);
  const identity = extractCandidateManifestIdentity(manifest);
  if (!identity.candidateId) {
    errors.push("candidate manifest does not expose candidateId at a supported identity path");
  } else if (identity.candidateId !== expectedBinding.candidateId) {
    errors.push(`candidate manifest candidateId mismatch: expected ${expectedBinding.candidateId}, got ${identity.candidateId}`);
  }
  for (const key of ["deployId", "environmentId", "commitSha", "tag"]) {
    if (identity[key] && identity[key] !== expectedBinding[key]) {
      errors.push(`candidate manifest ${key} mismatch: expected ${expectedBinding[key]}, got ${identity[key]}`);
    }
  }
}

function extractCandidateManifestIdentity(manifest) {
  const candidates = [
    manifest,
    manifest?.binding,
    manifest?.candidate,
    manifest?.releaseCandidate,
    manifest?.target,
  ].filter(isPlainObject);
  const candidateId = firstString(candidates.map((item) => item.candidateId))
    ?? firstString([manifest?.candidate?.id, manifest?.releaseCandidate?.id]);
  const deployId = firstString(candidates.map((item) => item.deployId));
  const environmentId = firstString(candidates.map((item) => item.environmentId));
  const commitSha = firstString([
    ...candidates.map((item) => item.commitSha),
    ...candidates.map((item) => item.sourceCommit),
    manifest?.source?.commitSha,
    manifest?.source?.commit,
    manifest?.git?.commitSha,
    manifest?.git?.commit,
  ]);
  const tag = firstString([
    ...candidates.map((item) => item.tag),
    manifest?.signedTag?.name,
    manifest?.source?.tag,
    manifest?.git?.tag,
  ]);
  return { candidateId, deployId, environmentId, commitSha, tag };
}

function validateExpectedBinding(binding, expected, errors, context) {
  if (!expected) {
    errors.push(`${context} cannot be verified without expected candidateId, deployId, and environmentId`);
    return;
  }
  for (const key of ["candidateId", "deployId", "environmentId"]) {
    if (typeof expected[key] !== "string" || expected[key].length === 0) {
      errors.push(`expected binding is missing ${key}`);
    } else if (binding[key] !== expected[key]) {
      errors.push(`${context} ${key} mismatch: expected ${expected[key]}, got ${String(binding[key])}`);
    }
  }
}

function rejectIndexStateDuplication(document, errors) {
  const forbidden = new Set(["status", "executionstatus", "findingstatus", "evidencelevel", "result", "outcome"]);
  visitObject(document.payload, "$.payload", (key, location) => {
    if (forbidden.has(normalizeKey(key))) errors.push(`evidence index must not duplicate ledger state at ${location}.${key}`);
  });
}

function scanJsonForSecretKeys(value, location, errors) {
  visitObject(value, location, (key, keyLocation) => {
    if (FORBIDDEN_SECRET_KEYS.has(normalizeKey(key))) {
      errors.push(`${keyLocation}.${key} is a forbidden credential-bearing field`);
    }
  });
}

function scanTextForSecrets(text, context, errors) {
  for (const { name, pattern } of TEXT_SECRET_PATTERNS) {
    if (pattern.test(text)) errors.push(`${context} contains a possible ${name}; raw evidence must be redacted before sealing`);
  }
}

function visitObject(value, location, visitor) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitObject(item, `${location}[${index}]`, visitor));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visitor(key, location);
    visitObject(child, `${location}.${key}`, visitor);
  }
}

async function resolveVerificationRoot(root, errors) {
  const absolute = path.resolve(root ?? process.cwd());
  try {
    return await realpath(absolute);
  } catch (error) {
    errors.push(`verification root does not exist: ${absolute} (${error.message})`);
    return absolute;
  }
}

async function resolveInputPath(input, root, kind, errors) {
  if (typeof input !== "string" || input.length === 0) {
    errors.push(`${kind} path is required`);
    return undefined;
  }
  const absolute = path.resolve(root, input);
  try {
    const canonical = await realpath(absolute);
    if (!isPathInside(root, canonical)) {
      errors.push(`${kind} path resolves outside verification root: ${input}`);
      return undefined;
    }
    return canonical;
  } catch (error) {
    errors.push(`${kind} path does not exist: ${input} (${error.code ?? error.message})`);
    return undefined;
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function displayPath(root, value) {
  const relative = path.relative(root, value);
  return relative && !relative.startsWith("..") ? relative : value;
}

function expectExactKeys(value, required, optional, location, errors) {
  if (!isPlainObject(value)) return;
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${location}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${location}.${key} is not allowed`);
  }
}

function expectObject(value, location, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  return true;
}

function expectArray(value, location, errors, { min }) {
  if (!Array.isArray(value)) {
    errors.push(`${location} must be an array`);
    return false;
  }
  if (value.length < min) errors.push(`${location} must contain at least ${min} item${min === 1 ? "" : "s"}`);
  return true;
}

function expectNonEmptyString(value, location, errors, maxLength) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    errors.push(`${location} must be a non-empty trimmed string of at most ${maxLength} characters`);
  }
}

function expectIdentifier(value, location, errors) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) errors.push(`${location} must be a stable identifier`);
}

function expectSha256(value, location, errors) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) errors.push(`${location} must be 64 lowercase SHA-256 hex characters`);
}

function expectUtc(value, location, errors) {
  if (typeof value !== "string" || !UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push(`${location} must be an RFC 3339 UTC timestamp ending in Z`);
  }
}

function expectEnum(value, allowed, location, errors) {
  if (!allowed.includes(value)) errors.push(`${location} must be one of ${allowed.join(", ")}`);
}

function expectLiteral(value, expected, location, errors) {
  if (value !== expected) errors.push(`${location} must equal ${JSON.stringify(expected)}`);
}

function validateStringArray(value, location, errors, { min, maxLength = 4096 }) {
  if (!expectArray(value, location, errors, { min })) return;
  value.forEach((item, index) => expectNonEmptyString(item, `${location}[${index}]`, errors, maxLength));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sortArray(value, comparator) {
  if (Array.isArray(value)) value.sort(comparator);
}

function compareBy(selector) {
  return (left, right) => selector(left).localeCompare(selector(right));
}

function firstString(values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function appendValidationError(errors, prefix, error) {
  if (error instanceof EvidenceValidationError) {
    for (const detail of error.errors) errors.push(`${prefix}: ${detail}`);
  } else {
    errors.push(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(argv) {
  const options = parseCli(argv);
  const expectedBinding = {
    candidateId: options.candidateId,
    deployId: options.deployId,
    environmentId: options.environmentId,
  };
  if (!options.ledger && !options.index) throw new Error("one of --ledger or --index is required");
  for (const key of ["candidateId", "deployId", "environmentId"]) {
    if (!expectedBinding[key]) throw new Error(`--${camelToKebab(key)} is required`);
  }

  const reports = [];
  if (options.ledger) {
    reports.push(await verifyEvidenceLedger({
      ledgerPath: options.ledger,
      root: options.root,
      expectedBinding,
      candidateManifestPath: options.candidateManifest,
    }));
  }
  if (options.index) {
    reports.push(await verifyEvidenceIndex({
      indexPath: options.index,
      root: options.root,
      expectedBinding,
      candidateManifestPath: options.candidateManifest,
    }));
  }
  process.stdout.write(canonicalJsonFile({ ok: true, reports }));
}

function parseCli(argv) {
  const options = { root: process.cwd() };
  const names = new Map([
    ["--ledger", "ledger"],
    ["--index", "index"],
    ["--root", "root"],
    ["--candidate-id", "candidateId"],
    ["--deploy-id", "deployId"],
    ["--environment-id", "environmentId"],
    ["--candidate-manifest", "candidateManifest"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key) throw new Error(`unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index]} requires a value`);
    if (Object.hasOwn(options, key) && key !== "root") throw new Error(`${argv[index]} may only be supplied once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
