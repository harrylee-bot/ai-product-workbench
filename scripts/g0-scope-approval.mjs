#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "@redocly/ajv/dist/2020.js";

import {
  canonicalJson,
  REQUIRED_SOURCE_SCOPES,
} from "./release-candidate-manifest-lib.mjs";

export const G0_SCHEMA_VERSION = "workbench.g0-scope-approval.v1";
export const G0_ROLES = Object.freeze([
  "Implementer",
  "Security",
  "Data",
  "Operations",
  "Evidence",
  "Release",
]);
export const G0_GATE_IDS = Object.freeze(Array.from({ length: 13 }, (_, index) => `G${index}`));
export const G0_FINDING_IDS = Object.freeze([
  ...Array.from({ length: 50 }, (_, index) => `D-${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 19 }, (_, index) => `P-${String(index + 1).padStart(3, "0")}`),
]);

const EXECUTION_STATUSES = new Set(["PASS", "FAIL", "NOT RUN", "BLOCKED", "INCONCLUSIVE"]);
const ENVIRONMENT_KINDS = new Set(["local", "ci", "server", "staging", "production"]);
const CAPABILITY_CLASSIFICATIONS = new Set(["advertised", "deferred", "N/A"]);
const ROLE_SET = new Set(G0_ROLES);
const FORBIDDEN_WAIVER_CATEGORIES = new Set([
  "source-provenance",
  "tenant-isolation",
  "secret-exposure",
  "object-checksum-integrity",
  "irreversible-data-recovery",
  "independent-production-approval",
]);
const WAIVER_CATEGORIES = new Set([
  "schedule",
  "non-production-feature-scope",
  "performance-advisory",
  "usability-advisory",
  "documentation",
  ...FORBIDDEN_WAIVER_CATEGORIES,
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,255}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FILE_URI_PATTERN = /^file:\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CREDENTIAL_QUERY_PARAMETERS = new Set([
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
const PLACEHOLDER_PATTERN = /(?:^|[\s._:/-])(?:tbd|todo|unknown|unset|placeholder|待定|未知|未分配)(?:$|[\s._:/-])/i;
const EXAMPLE_ID_PATTERN = /(?:example|placeholder)|(?:@|\.)invalid$/i;
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
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: "URL credential", pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@/i },
  {
    name: "assigned credential",
    pattern: /\b(?:api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|secret|token)\b\s*[:=]\s*["']?(?!\$\{|\$[A-Z_]|<redacted>|\[redacted\]|redacted\b|none\b|null\b)[A-Za-z0-9._~+\/-]{8,}/i,
  },
];

const candidateManifestValidatorPromise = readFile(
  new URL("../schemas/release-candidate-manifest.schema.json", import.meta.url),
  "utf8",
).then((raw) => new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(raw)));

export class G0ApprovalValidationError extends Error {
  constructor(errors) {
    const normalized = [...new Set(errors)].sort();
    super(`G0 scope approval validation failed (${normalized.length} error${normalized.length === 1 ? "" : "s"}):\n${normalized.map((error) => `- ${error}`).join("\n")}`);
    this.name = "G0ApprovalValidationError";
    this.errors = normalized;
  }
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function verifyG0ScopeApproval({
  approvalPath,
  root = process.cwd(),
  expectedCandidate,
  candidateManifestPath,
  now = new Date(),
} = {}) {
  const errors = [];
  const nowDate = normalizeNow(now, errors);
  const resolvedRoot = await resolveRoot(root, errors);
  const loaded = await readJsonInput(approvalPath, resolvedRoot, "approval record", errors);
  if (!loaded.document || errors.length) throw new G0ApprovalValidationError(errors);

  scanJsonForSecretKeys(loaded.document, "$", errors);
  scanTextForSecrets(loaded.raw, `approval record ${displayPath(resolvedRoot, loaded.path)}`, errors);

  const references = [];
  const context = {
    errors,
    references,
    expectedCandidate,
    now: nowDate,
    recordedAt: null,
    executionStatus: loaded.document.executionStatus,
    ownersByRole: new Map(),
    approvalIds: new Set(),
  };
  validateDocument(loaded.document, context);
  validateExpectedCandidate(loaded.document.candidate, expectedCandidate, errors);

  const verifiedReferences = await Promise.all(references.map(({ reference, location }) => (
    verifyEvidenceReference(reference, { root: resolvedRoot, location, errors })
  )));

  let candidateManifest = null;
  if (candidateManifestPath !== undefined) {
    const loadedManifest = await readJsonInput(candidateManifestPath, resolvedRoot, "candidate manifest", errors, {
      allowOutsideRoot: true,
    });
    if (loadedManifest.document) {
      scanJsonForSecretKeys(loadedManifest.document, "$candidateManifest", errors);
      scanTextForSecrets(loadedManifest.raw, `candidate manifest ${loadedManifest.path}`, errors);
      const expectedReference = loaded.document.candidate?.manifest;
      if (isObject(expectedReference) && SHA256_PATTERN.test(expectedReference.sha256 ?? "")) {
        const actualSha256 = sha256Bytes(loadedManifest.raw);
        if (actualSha256 !== expectedReference.sha256) {
          errors.push(`candidate manifest SHA-256 mismatch: expected ${expectedReference.sha256}, got ${actualSha256}`);
        }
      }
      await validateCandidateManifest(
        loadedManifest.document,
        loaded.document.candidate,
        loaded.document.environment,
        errors,
      );
      candidateManifest = loadedManifest.document;
    }
  } else if (loaded.document.executionStatus === "PASS") {
    errors.push("PASS requires candidateManifestPath so candidateId/sourceCommit/signedTag and manifest SHA-256 are independently verified");
  }

  if (errors.length) throw new G0ApprovalValidationError(errors);
  const localReferenceCount = verifiedReferences.filter((reference) => reference?.absolutePath).length;
  return {
    ok: true,
    gatePassed: loaded.document.executionStatus === "PASS",
    gateId: "G0",
    executionStatus: loaded.document.executionStatus,
    recordId: loaded.document.recordId,
    product: loaded.document.product,
    candidateId: loaded.document.candidate.candidateId,
    sourceCommit: loaded.document.candidate.sourceCommit,
    signedTag: loaded.document.candidate.signedTag.name,
    environmentId: loaded.document.environment.environmentId,
    capabilityCount: loaded.document.capabilities.length,
    waiverCount: loaded.document.waivers.length,
    approvalReferenceCount: references.length,
    localApprovalReferenceCount: localReferenceCount,
    candidateManifestVerified: candidateManifest !== null,
  };
}

function validateDocument(document, context) {
  const { errors } = context;
  if (!expectObject(document, "$", errors)) return;
  expectExactKeys(document, [
    "schemaVersion",
    "recordId",
    "product",
    "gateId",
    "executionStatus",
    "recordedAtUtc",
    "candidate",
    "environment",
    "scope",
    "capabilities",
    "responsibilityMatrix",
    "waivers",
  ], "$", errors);
  expectLiteral(document.schemaVersion, G0_SCHEMA_VERSION, "$.schemaVersion", errors);
  expectIdentifier(document.recordId, "$.recordId", errors);
  expectLiteral(document.product, "产品工作台", "$.product", errors);
  expectLiteral(document.gateId, "G0", "$.gateId", errors);
  expectEnum(document.executionStatus, EXECUTION_STATUSES, "$.executionStatus", errors);
  context.recordedAt = expectUtc(document.recordedAtUtc, "$.recordedAtUtc", errors);
  if (context.recordedAt && context.now && context.recordedAt > context.now) {
    errors.push("$.recordedAtUtc must not be in the future");
  }
  validateCandidate(document.candidate, context);
  validateEnvironment(document.environment, document.executionStatus, errors);
  const scopeItems = validateScope(document.scope, errors);
  const ownersByRole = validateResponsibilityMatrix(document.responsibilityMatrix, scopeItems, context);
  context.ownersByRole = ownersByRole;
  validateIndependence(ownersByRole, errors);
  validateCapabilities(document.capabilities, context);
  validateWaivers(document.waivers, document.scope, context);
}

function validateCandidate(candidate, context) {
  const { errors, references } = context;
  if (!expectObject(candidate, "$.candidate", errors)) return;
  expectExactKeys(candidate, ["candidateId", "sourceCommit", "signedTag", "manifest"], "$.candidate", errors);
  if (typeof candidate.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(candidate.candidateId)) {
    errors.push("$.candidate.candidateId must be sha256:<64 lowercase hex>");
  }
  if (typeof candidate.sourceCommit !== "string" || !GIT_OBJECT_PATTERN.test(candidate.sourceCommit)) {
    errors.push("$.candidate.sourceCommit must be a lowercase 40- or 64-hex Git commit");
  }
  validateSignedTag(candidate.signedTag, "$.candidate.signedTag", errors);
  if (validateEvidenceReferenceShape(candidate.manifest, "$.candidate.manifest", errors)) {
    references.push({ reference: candidate.manifest, location: "candidate manifest reference" });
  }
}

function validateSignedTag(signedTag, location, errors) {
  if (!expectObject(signedTag, location, errors)) return;
  expectExactKeys(signedTag, ["name", "tagObject", "payloadSha256"], location, errors);
  expectIdentifier(signedTag.name, `${location}.name`, errors);
  if (typeof signedTag.tagObject !== "string" || !GIT_OBJECT_PATTERN.test(signedTag.tagObject)) {
    errors.push(`${location}.tagObject must be a lowercase 40- or 64-hex annotated tag object`);
  }
  expectSha256(signedTag.payloadSha256, `${location}.payloadSha256`, errors);
}

function validateEnvironment(environment, executionStatus, errors) {
  if (!expectObject(environment, "$.environment", errors)) return;
  expectExactKeys(environment, ["environmentId", "kind", "target", "region"], "$.environment", errors);
  expectIdentifier(environment.environmentId, "$.environment.environmentId", errors);
  expectEnum(environment.kind, ENVIRONMENT_KINDS, "$.environment.kind", errors);
  expectString(environment.target, "$.environment.target", errors, 1024);
  expectString(environment.region, "$.environment.region", errors, 128);
  rejectPlaceholder(environment.target, "$.environment.target", errors);
  rejectPlaceholder(environment.region, "$.environment.region", errors);
  if (executionStatus === "PASS" && environment.kind !== "production") {
    errors.push("$.environment.kind must be production when G0 executionStatus is PASS");
  }
}

function validateScope(scope, errors) {
  const result = new Set();
  if (!expectObject(scope, "$.scope", errors)) return result;
  expectExactKeys(scope, ["gateIds", "findingIds"], "$.scope", errors);
  validateExactIdSet(scope.gateIds, G0_GATE_IDS, "$.scope.gateIds", errors);
  validateExactIdSet(scope.findingIds, G0_FINDING_IDS, "$.scope.findingIds", errors);
  if (Array.isArray(scope.gateIds)) for (const id of scope.gateIds) result.add(id);
  if (Array.isArray(scope.findingIds)) for (const id of scope.findingIds) result.add(id);
  return result;
}

function validateResponsibilityMatrix(matrix, scopeItems, context) {
  const { errors } = context;
  const ownersByRole = new Map();
  if (!expectObject(matrix, "$.responsibilityMatrix", errors)) return ownersByRole;
  expectExactKeys(matrix, ["owners", "schedule"], "$.responsibilityMatrix", errors);
  if (!expectArray(matrix.owners, "$.responsibilityMatrix.owners", errors, 6)) return ownersByRole;
  if (matrix.owners.length !== G0_ROLES.length) {
    errors.push(`$.responsibilityMatrix.owners must contain exactly ${G0_ROLES.length} role owners`);
  }
  for (let index = 0; index < matrix.owners.length; index += 1) {
    const roleOwner = matrix.owners[index];
    const location = `$.responsibilityMatrix.owners[${index}]`;
    if (!expectObject(roleOwner, location, errors)) continue;
    expectExactKeys(roleOwner, ["role", "owner", "responsibilities", "approval"], location, errors);
    expectEnum(roleOwner.role, ROLE_SET, `${location}.role`, errors);
    if (ROLE_SET.has(roleOwner.role)) {
      if (ownersByRole.has(roleOwner.role)) errors.push(`${location}.role duplicates ${roleOwner.role}`);
      else ownersByRole.set(roleOwner.role, roleOwner.owner);
    }
    validateOwner(roleOwner.owner, `${location}.owner`, context.executionStatus, errors);
    validateStringArray(roleOwner.responsibilities, `${location}.responsibilities`, errors);
    if (roleOwner.approval === null) {
      if (context.executionStatus === "PASS") errors.push(`${location}.approval is required for PASS`);
    } else {
      validateApproval(roleOwner.approval, {
        ...context,
        location: `${location}.approval`,
        expectedRole: roleOwner.role,
        expectedApproverId: roleOwner.owner?.id,
      });
    }
  }
  for (const role of G0_ROLES) {
    if (!ownersByRole.has(role)) errors.push(`$.responsibilityMatrix.owners is missing ${role}`);
  }
  validateSchedule(matrix.schedule, scopeItems, context);
  return ownersByRole;
}

function validateOwner(owner, location, executionStatus, errors) {
  if (!expectObject(owner, location, errors)) return;
  expectExactKeys(owner, ["id", "displayName", "team"], location, errors);
  expectIdentifier(owner.id, `${location}.id`, errors);
  expectString(owner.displayName, `${location}.displayName`, errors, 256);
  expectString(owner.team, `${location}.team`, errors, 256);
  for (const [key, value] of [["id", owner.id], ["displayName", owner.displayName], ["team", owner.team]]) {
    rejectPlaceholder(value, `${location}.${key}`, errors);
  }
  if (executionStatus === "PASS" && [owner.id, owner.displayName, owner.team].some((value) => (
    typeof value === "string" && EXAMPLE_ID_PATTERN.test(value)
  ))) {
    errors.push(`${location} must identify a real owner for PASS; example/.invalid identities are forbidden`);
  }
}

function validateIndependence(ownersByRole, errors) {
  const implementerId = normalizedOwnerId(ownersByRole.get("Implementer")?.id);
  if (!implementerId) return;
  for (const role of ["Security", "Data", "Operations", "Release"]) {
    const ownerId = normalizedOwnerId(ownersByRole.get(role)?.id);
    if (ownerId && ownerId === implementerId) {
      errors.push(`${role} owner must be independent from Implementer and cannot self-approve ${role} gates`);
    }
  }
}

function validateSchedule(schedule, scopeItems, context) {
  const { errors } = context;
  if (!expectArray(schedule, "$.responsibilityMatrix.schedule", errors, 1)) return;
  const coverage = new Map();
  for (let index = 0; index < schedule.length; index += 1) {
    const item = schedule[index];
    const location = `$.responsibilityMatrix.schedule[${index}]`;
    if (!expectObject(item, location, errors)) continue;
    expectExactKeys(item, ["scopeItemIds", "targetDateUtc", "escalationPath", "overdueAction"], location, errors);
    if (expectArray(item.scopeItemIds, `${location}.scopeItemIds`, errors, 1)) {
      const localIds = new Set();
      for (const scopeItemId of item.scopeItemIds) {
        if (typeof scopeItemId !== "string" || !/^(?:G(?:[0-9]|1[0-2])|(?:D|P)-\d{3})$/.test(scopeItemId)) {
          errors.push(`${location}.scopeItemIds contains invalid ID ${JSON.stringify(scopeItemId)}`);
          continue;
        }
        if (localIds.has(scopeItemId)) errors.push(`${location}.scopeItemIds duplicates ${scopeItemId}`);
        localIds.add(scopeItemId);
        if (!scopeItems.has(scopeItemId)) errors.push(`${location}.scopeItemIds contains out-of-scope item ${scopeItemId}`);
        coverage.set(scopeItemId, (coverage.get(scopeItemId) ?? 0) + 1);
      }
    }
    const targetDate = expectUtc(item.targetDateUtc, `${location}.targetDateUtc`, errors);
    if (context.executionStatus === "PASS" && targetDate && context.now && targetDate <= context.now) {
      errors.push(`${location}.targetDateUtc is overdue; assign a new approved target before PASS`);
    }
    validateStringArray(item.escalationPath, `${location}.escalationPath`, errors);
    expectString(item.overdueAction, `${location}.overdueAction`, errors, 2048);
  }
  for (const scopeItemId of scopeItems) {
    const count = coverage.get(scopeItemId) ?? 0;
    if (count === 0) errors.push(`$.responsibilityMatrix.schedule does not assign target/escalation/overdue handling for ${scopeItemId}`);
    if (count > 1) errors.push(`$.responsibilityMatrix.schedule assigns ${scopeItemId} more than once`);
  }
}

function validateCapabilities(capabilities, context) {
  const { errors } = context;
  if (!expectArray(capabilities, "$.capabilities", errors, 1)) return;
  const ids = new Set();
  const classifications = new Set();
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];
    const location = `$.capabilities[${index}]`;
    if (!expectObject(capability, location, errors)) continue;
    expectExactKeys(capability, [
      "capabilityId",
      "name",
      "classification",
      "reason",
      "classificationExpiresAtUtc",
      "accountableRole",
      "targetDateUtc",
      "escalationPath",
      "overdueAction",
      "approvals",
    ], location, errors);
    expectIdentifier(capability.capabilityId, `${location}.capabilityId`, errors);
    if (ids.has(capability.capabilityId)) errors.push(`${location}.capabilityId duplicates ${capability.capabilityId}`);
    ids.add(capability.capabilityId);
    expectString(capability.name, `${location}.name`, errors, 256);
    expectEnum(capability.classification, CAPABILITY_CLASSIFICATIONS, `${location}.classification`, errors);
    if (CAPABILITY_CLASSIFICATIONS.has(capability.classification)) classifications.add(capability.classification);
    expectString(capability.reason, `${location}.reason`, errors, 4096);
    const expiresAt = expectUtc(capability.classificationExpiresAtUtc, `${location}.classificationExpiresAtUtc`, errors);
    if (expiresAt && context.now && expiresAt <= context.now) {
      errors.push(`${location}.classificationExpiresAtUtc is expired`);
    }
    expectEnum(capability.accountableRole, ROLE_SET, `${location}.accountableRole`, errors);
    if (capability.classification === "N/A" && capability.accountableRole === "Implementer") {
      errors.push(`${location}.accountableRole cannot be Implementer for an N/A classification`);
    }
    const targetDate = expectUtc(capability.targetDateUtc, `${location}.targetDateUtc`, errors);
    if (context.executionStatus === "PASS" && targetDate && context.now && targetDate <= context.now) {
      errors.push(`${location}.targetDateUtc is overdue; assign a new approved target before PASS`);
    }
    validateStringArray(capability.escalationPath, `${location}.escalationPath`, errors);
    expectString(capability.overdueAction, `${location}.overdueAction`, errors, 2048);
    const approvalsByRole = validateApprovalArray(capability.approvals, `${location}.approvals`, context);
    if (context.executionStatus === "PASS") {
      const requiredRoles = new Set([capability.accountableRole, "Release"]);
      for (const role of requiredRoles) {
        if (!approvalsByRole.has(role)) errors.push(`${location}.approvals requires ${role} approval for PASS`);
      }
      for (const role of approvalsByRole.keys()) {
        if (!requiredRoles.has(role)) errors.push(`${location}.approvals contains unrequired role ${role}`);
      }
    }
  }
  for (const classification of CAPABILITY_CLASSIFICATIONS) {
    if (!classifications.has(classification)) {
      errors.push(`$.capabilities must explicitly include at least one ${classification} classification`);
    }
  }
}

function validateWaivers(waivers, scope, context) {
  const { errors } = context;
  if (!expectArray(waivers, "$.waivers", errors, 0)) return;
  const decisionIds = new Set();
  const gateIds = new Set(Array.isArray(scope?.gateIds) ? scope.gateIds : []);
  const findingIds = new Set(Array.isArray(scope?.findingIds) ? scope.findingIds : []);
  for (let index = 0; index < waivers.length; index += 1) {
    const waiver = waivers[index];
    const location = `$.waivers[${index}]`;
    if (!expectObject(waiver, location, errors)) continue;
    expectExactKeys(waiver, [
      "decisionId",
      "controlCategory",
      "relatedGateIds",
      "relatedFindingIds",
      "businessReason",
      "verifiedFacts",
      "compensatingControls",
      "ownerRole",
      "approvals",
      "expiresAtUtc",
      "reviewTriggers",
      "rollbackOrForwardRepair",
    ], location, errors);
    expectIdentifier(waiver.decisionId, `${location}.decisionId`, errors);
    if (decisionIds.has(waiver.decisionId)) errors.push(`${location}.decisionId duplicates ${waiver.decisionId}`);
    decisionIds.add(waiver.decisionId);
    expectEnum(waiver.controlCategory, WAIVER_CATEGORIES, `${location}.controlCategory`, errors);
    if (FORBIDDEN_WAIVER_CATEGORIES.has(waiver.controlCategory)) {
      errors.push(`${location}.controlCategory ${waiver.controlCategory} cannot be waived`);
    }
    validateRelatedIds(waiver.relatedGateIds, gateIds, `${location}.relatedGateIds`, errors);
    validateRelatedIds(waiver.relatedFindingIds, findingIds, `${location}.relatedFindingIds`, errors);
    if ((waiver.relatedGateIds?.length ?? 0) + (waiver.relatedFindingIds?.length ?? 0) === 0) {
      errors.push(`${location} must reference at least one gate or finding`);
    }
    expectString(waiver.businessReason, `${location}.businessReason`, errors, 4096);
    validateStringArray(waiver.verifiedFacts, `${location}.verifiedFacts`, errors);
    validateStringArray(waiver.compensatingControls, `${location}.compensatingControls`, errors);
    expectEnum(waiver.ownerRole, ROLE_SET, `${location}.ownerRole`, errors);
    const approvalsByRole = validateApprovalArray(waiver.approvals, `${location}.approvals`, context);
    for (const role of ["Security", "Data", "Operations", "Release"]) {
      if (!approvalsByRole.has(role)) errors.push(`${location}.approvals requires ${role} approval`);
    }
    for (const role of approvalsByRole.keys()) {
      if (!["Security", "Data", "Operations", "Release"].includes(role)) {
        errors.push(`${location}.approvals contains unrequired role ${role}`);
      }
    }
    const expiresAt = expectUtc(waiver.expiresAtUtc, `${location}.expiresAtUtc`, errors);
    if (expiresAt && context.now && expiresAt <= context.now) errors.push(`${location}.expiresAtUtc is expired`);
    validateStringArray(waiver.reviewTriggers, `${location}.reviewTriggers`, errors);
    expectString(waiver.rollbackOrForwardRepair, `${location}.rollbackOrForwardRepair`, errors, 4096);
  }
}

function validateApprovalArray(approvals, location, context) {
  const approvalsByRole = new Map();
  if (!expectArray(approvals, location, context.errors, 0)) return approvalsByRole;
  for (let index = 0; index < approvals.length; index += 1) {
    const approval = approvals[index];
    const approvalLocation = `${location}[${index}]`;
    validateApproval(approval, { ...context, location: approvalLocation });
    if (!isObject(approval) || !ROLE_SET.has(approval.approverRole)) continue;
    if (approvalsByRole.has(approval.approverRole)) {
      context.errors.push(`${approvalLocation}.approverRole duplicates ${approval.approverRole}`);
    } else {
      approvalsByRole.set(approval.approverRole, approval);
    }
  }
  return approvalsByRole;
}

function validateApproval(approval, context) {
  const {
    errors,
    references,
    location,
    expectedRole,
    expectedApproverId,
    ownersByRole,
    approvalIds,
  } = context;
  if (!expectObject(approval, location, errors)) return;
  expectExactKeys(approval, [
    "approvalId",
    "approverRole",
    "approverId",
    "decision",
    "signedAtUtc",
    "reference",
  ], location, errors);
  expectIdentifier(approval.approvalId, `${location}.approvalId`, errors);
  if (typeof approval.approvalId === "string") {
    if (approvalIds.has(approval.approvalId)) errors.push(`${location}.approvalId duplicates ${approval.approvalId}`);
    approvalIds.add(approval.approvalId);
  }
  expectEnum(approval.approverRole, ROLE_SET, `${location}.approverRole`, errors);
  expectIdentifier(approval.approverId, `${location}.approverId`, errors);
  expectLiteral(approval.decision, "APPROVE", `${location}.decision`, errors);
  const signedAt = expectUtc(approval.signedAtUtc, `${location}.signedAtUtc`, errors);
  if (signedAt && context.now && signedAt > context.now) errors.push(`${location}.signedAtUtc must not be in the future`);
  if (signedAt && context.recordedAt && signedAt > context.recordedAt) {
    errors.push(`${location}.signedAtUtc must not be later than $.recordedAtUtc`);
  }
  if (expectedRole !== undefined && approval.approverRole !== expectedRole) {
    errors.push(`${location}.approverRole must be ${expectedRole}`);
  }
  const ownerId = expectedApproverId ?? ownersByRole.get(approval.approverRole)?.id;
  if (typeof ownerId === "string" && normalizedOwnerId(approval.approverId) !== normalizedOwnerId(ownerId)) {
    errors.push(`${location}.approverId must match the ${approval.approverRole} owner`);
  }
  if (validateEvidenceReferenceShape(approval.reference, `${location}.reference`, errors)) {
    references.push({ reference: approval.reference, location: `${location}.reference` });
  }
}

function validateExpectedCandidate(candidate, expectedCandidate, errors) {
  if (!isObject(expectedCandidate)) {
    errors.push("expectedCandidate with candidateId, sourceCommit, and signedTag is required; the verifier must not trust the record's self-reported binding");
    return;
  }
  expectExactKeys(expectedCandidate, ["candidateId", "sourceCommit", "signedTag"], "expectedCandidate", errors);
  for (const key of ["candidateId", "sourceCommit"]) {
    if (candidate?.[key] !== expectedCandidate[key]) {
      errors.push(`$.candidate.${key} does not match externally expected ${key}`);
    }
  }
  if (candidate?.signedTag?.name !== expectedCandidate.signedTag) {
    errors.push("$.candidate.signedTag.name does not match externally expected signedTag");
  }
}

async function validateCandidateManifest(manifest, candidate, environment, errors) {
  if (!expectObject(manifest, "$candidateManifest", errors)) return;
  const validateSchema = await candidateManifestValidatorPromise;
  if (!validateSchema(manifest)) {
    for (const schemaError of validateSchema.errors ?? []) {
      const location = schemaError.instancePath || "/";
      errors.push(`candidate manifest schema ${location} ${schemaError.message}`);
    }
    return;
  }

  validateCandidateManifestSemantics(manifest, errors);
  if (manifest.product !== "产品工作台") errors.push("candidate manifest product must be 产品工作台");
  if (manifest.candidateId !== candidate?.candidateId) errors.push("candidate manifest candidateId mismatch");
  if (manifest.sourceCommit !== candidate?.sourceCommit) errors.push("candidate manifest sourceCommit mismatch");
  if (manifest.environmentId !== null && manifest.environmentId !== undefined
    && manifest.environmentId !== environment?.environmentId) {
    errors.push("candidate manifest environmentId mismatch");
  }
  if (!isObject(manifest.signedTag)) {
    errors.push("candidate manifest signedTag must be an object");
    return;
  }
  if (manifest.signedTag.verified !== true) errors.push("candidate manifest signedTag.verified must be true");
  if (manifest.signedTag.name !== candidate?.signedTag?.name) errors.push("candidate manifest signedTag.name mismatch");
  if (manifest.signedTag.tagObject !== candidate?.signedTag?.tagObject) errors.push("candidate manifest signedTag.tagObject mismatch");
  if (manifest.signedTag.payloadSha256 !== candidate?.signedTag?.payloadSha256) {
    errors.push("candidate manifest signedTag.payloadSha256 mismatch");
  }
  if (manifest.signedTag.targetCommit !== undefined && manifest.signedTag.targetCommit !== candidate?.sourceCommit) {
    errors.push("candidate manifest signedTag.targetCommit mismatch");
  }
}

function validateCandidateManifestSemantics(manifest, errors) {
  const signedTagIdentity = manifest.signedTag.verified ? {
    name: manifest.signedTag.name,
    tagObject: manifest.signedTag.tagObject,
    payloadSha256: manifest.signedTag.payloadSha256,
  } : null;
  const computedCandidateId = `sha256:${sha256Bytes(canonicalJson({
    sourceCommit: manifest.sourceCommit,
    sourceTree: manifest.sourceTree.sha256,
    signedTag: signedTagIdentity,
  }))}`;
  if (manifest.candidateId !== computedCandidateId) {
    errors.push("candidate manifest candidateId does not match its source commit, source tree, and signed tag identity");
  }

  if (manifest.signedTag.verified !== true) errors.push("candidate manifest signedTag.verified must be true");
  if (manifest.signedTag.targetCommit !== manifest.sourceCommit) {
    errors.push("candidate manifest signedTag.targetCommit must equal sourceCommit");
  }
  if (typeof manifest.branch !== "string" || manifest.branch.length === 0) {
    errors.push("candidate manifest branch must identify a named branch");
  }
  if (!Object.values(manifest.audit).every((value) => typeof value === "string" && value.length > 0)) {
    errors.push("candidate manifest audit fields must all be populated");
  } else if (Date.parse(manifest.audit.endedAt) < Date.parse(manifest.audit.startedAt)) {
    errors.push("candidate manifest audit.endedAt must not precede audit.startedAt");
  }

  const porcelainSha256 = sha256Bytes(manifest.status.porcelainV1);
  if (manifest.status.sha256 !== porcelainSha256) {
    errors.push("candidate manifest status.sha256 must match status.porcelainV1");
  }
  if (manifest.status.clean !== true || manifest.status.porcelainV1 !== "") {
    errors.push("candidate manifest must record a clean Git worktree");
  }

  for (const [check, stable] of Object.entries(manifest.captureConsistency)) {
    if (stable !== true) errors.push(`candidate manifest captureConsistency.${check} must be true`);
  }

  if (manifest.gate.status !== "PASS") errors.push("candidate manifest G1 gate.status must be PASS");
  if (manifest.gate.findingCount !== manifest.findings.length) {
    errors.push("candidate manifest gate.findingCount must equal findings.length");
  }
  if (manifest.gate.findingCount !== 0 || manifest.findings.length !== 0) {
    errors.push("candidate manifest G1 must contain zero findings");
  }

  validateManifestInventory(manifest, errors);
  validateManifestSourceScopes(manifest.sourceScopes, errors);
  for (const [name, group] of Object.entries(manifest.criticalArtifacts)) {
    if (group.status !== "complete" || group.blockedEntryCount !== 0 || group.entryCount < 1) {
      errors.push(`candidate manifest criticalArtifacts.${name} must be complete, non-empty, and contain zero blocked entries`);
    }
    if (group.entries !== undefined) {
      if (group.entries.length !== group.entryCount) {
        errors.push(`candidate manifest criticalArtifacts.${name}.entryCount must equal entries.length`);
      }
      if (group.sha256 !== sha256Bytes(canonicalJson(group.entries))) {
        errors.push(`candidate manifest criticalArtifacts.${name}.sha256 must match entries`);
      }
    }
  }

  const knowledgeStorage = manifest.knowledgeStorage;
  if (knowledgeStorage.auditPassed !== true) {
    errors.push("candidate manifest knowledgeStorage.auditPassed must be true");
  }
  if (knowledgeStorage.referencedAssetCount !== knowledgeStorage.referencedAssets.length) {
    errors.push("candidate manifest knowledgeStorage.referencedAssetCount must equal referencedAssets.length");
  }
  const referencedBytes = knowledgeStorage.referencedAssets.reduce((sum, asset) => sum + asset.byteSize, 0);
  if (knowledgeStorage.referencedBytes !== referencedBytes) {
    errors.push("candidate manifest knowledgeStorage.referencedBytes must equal the referenced asset byte total");
  }
}

function validateManifestInventory(manifest, errors) {
  const repositoryTotal = Object.values(manifest.inventory.byRepositoryState)
    .reduce((sum, slice) => sum + slice.entryCount, 0);
  if (manifest.inventory.entryCount !== repositoryTotal) {
    errors.push("candidate manifest inventory.entryCount must equal the repository-state entry total");
  }

  const requiredDispositions = ["included", "blocked", "excluded", "external"];
  for (const disposition of requiredDispositions) {
    if (!isObject(manifest.inventory.byDisposition[disposition])) {
      errors.push(`candidate manifest inventory.byDisposition.${disposition} is required`);
    }
  }
  if (requiredDispositions.some((disposition) => !isObject(manifest.inventory.byDisposition[disposition]))) return;

  const dispositionTotal = Object.values(manifest.inventory.byDisposition)
    .reduce((sum, slice) => sum + slice.entryCount, 0);
  if (manifest.inventory.entryCount !== dispositionTotal) {
    errors.push("candidate manifest inventory.entryCount must equal the disposition entry total");
  }
  if (manifest.inventory.byDisposition.blocked.entryCount !== 0) {
    errors.push("candidate manifest inventory must contain zero blocked entries");
  }
  if (manifest.sourceTree.entryCount !== manifest.inventory.byDisposition.included.entryCount) {
    errors.push("candidate manifest sourceTree.entryCount must equal included inventory entries");
  }
}

function validateManifestSourceScopes(sourceScopes, errors) {
  const actualByName = new Map();
  for (const scope of sourceScopes) {
    if (actualByName.has(scope.name)) {
      errors.push(`candidate manifest sourceScopes duplicates ${scope.name}`);
      continue;
    }
    actualByName.set(scope.name, scope);
    if (scope.status !== "complete" || scope.blockedEntryCount !== 0 || scope.entryCount < 1) {
      errors.push(`candidate manifest source scope ${scope.name} must be complete, non-empty, and contain zero blocked entries`);
    }
  }
  for (const expected of REQUIRED_SOURCE_SCOPES) {
    const actual = actualByName.get(expected.name);
    if (!actual) {
      errors.push(`candidate manifest sourceScopes is missing ${expected.name}`);
      continue;
    }
    if (canonicalJson(actual.roots) !== canonicalJson(expected.roots)
      || canonicalJson(actual.exactPaths) !== canonicalJson(expected.exactPaths ?? [])) {
      errors.push(`candidate manifest source scope ${expected.name} definition does not match the release candidate policy`);
    }
  }
  for (const name of actualByName.keys()) {
    if (!REQUIRED_SOURCE_SCOPES.some((scope) => scope.name === name)) {
      errors.push(`candidate manifest sourceScopes contains unknown scope ${name}`);
    }
  }
}

function validateEvidenceReferenceShape(reference, location, errors) {
  if (!expectObject(reference, location, errors)) return false;
  expectExactKeys(reference, ["uri", "sha256"], location, errors);
  expectString(reference.uri, `${location}.uri`, errors, 2048);
  expectSha256(reference.sha256, `${location}.sha256`, errors);
  return typeof reference.uri === "string" && SHA256_PATTERN.test(reference.sha256 ?? "");
}

async function verifyEvidenceReference(reference, { root, location, errors }) {
  if (!isObject(reference) || typeof reference.uri !== "string" || !SHA256_PATTERN.test(reference.sha256 ?? "")) return null;
  if (reference.uri.startsWith("file:")) {
    if (!FILE_URI_PATTERN.test(reference.uri) || reference.uri.includes("..")) {
      errors.push(`${location}.uri must be a relative file:./ path without traversal`);
      return null;
    }
    const relativePath = reference.uri.slice("file:./".length);
    const absolutePath = path.resolve(root, ...relativePath.split("/"));
    if (!isPathInside(root, absolutePath)) {
      errors.push(`${location}.uri escapes the verification root`);
      return null;
    }
    const loaded = await readRawRegularFile(absolutePath, root, location, errors);
    if (!loaded) return null;
    const actualSha256 = sha256Bytes(loaded.raw);
    if (actualSha256 !== reference.sha256) {
      errors.push(`${location} SHA-256 mismatch: expected ${reference.sha256}, got ${actualSha256}`);
    }
    scanTextForSecrets(loaded.raw.toString("utf8"), `${location} ${reference.uri}`, errors);
    try {
      const parsed = JSON.parse(loaded.raw.toString("utf8"));
      scanJsonForSecretKeys(parsed, "$approvalEvidence", errors);
    } catch {
      // Approval evidence may be a detached signature, PDF, or text receipt.
    }
    return { absolutePath, sha256: actualSha256 };
  }
  if (!isImmutableUri(reference.uri, reference.sha256)) {
    errors.push(`${location}.uri is mutable or unsupported: ${reference.uri}`);
    return null;
  }
  return { absolutePath: null, sha256: reference.sha256 };
}

function isImmutableUri(uri, expectedSha256) {
  if (typeof uri !== "string" || uri.length > 2048 || /\s/.test(uri)) return false;
  const urnMatch = /^urn:sha256:([0-9a-f]{64})$/.exec(uri);
  if (urnMatch) return urnMatch[1] === expectedSha256;
  const ociMatch = /^oci:\/\/[^\s?#]+@sha256:([0-9a-f]{64})$/.exec(uri);
  if (ociMatch) return ociMatch[1] === expectedSha256;
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (!["https:", "s3:", "gs:", "az:"].includes(parsed.protocol)) return false;
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (hasCredentialQueryParameter(parsed)) return false;
  if (/(?:^|[\/_=?&.-])(?:latest|current|head)(?:$|[\/_=?&.-])/i.test(`${parsed.pathname}${parsed.search}`)) return false;
  const immutableQueryKeys = ["versionId", "versionid", "generation"];
  if (immutableQueryKeys.some((key) => {
    const value = parsed.searchParams.get(key);
    return typeof value === "string" && /^[A-Za-z0-9._:+/-]{1,512}$/.test(value);
  })) return true;
  const value = `${parsed.pathname}${parsed.search}`;
  if (/(?:^|[\/:=_-])sha256[:=_-]?[0-9a-f]{64}(?:$|[/?&#._-])/i.test(value)) return true;
  if (/(?:^|\/)(?:commit|blob|tree|objects?|revisions?|versions?)\/[0-9a-f]{40,64}(?:$|[/?#._-])/i.test(value)) return true;
  return /(?:^|[\/_=-])[0-9a-f]{64}(?:$|[/?&#._-])/i.test(value);
}

function hasCredentialQueryParameter(parsed) {
  return [...parsed.searchParams.keys()].some((key) => CREDENTIAL_QUERY_PARAMETERS.has(normalizeKey(key)));
}

function normalizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolveRoot(root, errors) {
  try {
    const resolved = await realpath(path.resolve(root));
    const stats = await lstat(resolved);
    if (!stats.isDirectory()) errors.push(`verification root is not a directory: ${root}`);
    return resolved;
  } catch (error) {
    errors.push(`cannot resolve verification root ${root}: ${error.message}`);
    return path.resolve(root ?? ".");
  }
}

async function readJsonInput(inputPath, root, label, errors, { allowOutsideRoot = false } = {}) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    errors.push(`${label} path is required`);
    return { document: null, raw: "", path: "" };
  }
  const requestedPath = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
  let absolutePath = requestedPath;
  try {
    const requestedStats = await lstat(requestedPath);
    if (requestedStats.isSymbolicLink()) {
      errors.push(`${label} must not be a symbolic link`);
      return { document: null, raw: "", path: requestedPath };
    }
    absolutePath = await realpath(requestedPath);
  } catch (error) {
    errors.push(`${label} cannot be read: ${error.message}`);
    return { document: null, raw: "", path: requestedPath };
  }
  if (!allowOutsideRoot && !isPathInside(root, absolutePath)) {
    errors.push(`${label} path escapes the verification root`);
    return { document: null, raw: "", path: absolutePath };
  }
  const loaded = await readRawRegularFile(absolutePath, allowOutsideRoot ? null : root, label, errors);
  if (!loaded) return { document: null, raw: "", path: absolutePath };
  const raw = loaded.raw.toString("utf8");
  try {
    return { document: JSON.parse(raw), raw, path: absolutePath };
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return { document: null, raw, path: absolutePath };
  }
}

async function readRawRegularFile(absolutePath, root, label, errors) {
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      errors.push(`${label} must not be a symbolic link`);
      return null;
    }
    if (!stats.isFile()) {
      errors.push(`${label} must be a regular file`);
      return null;
    }
    const resolved = await realpath(absolutePath);
    if (path.normalize(resolved) !== path.normalize(absolutePath)) {
      errors.push(`${label} must not traverse a symbolic-link parent`);
      return null;
    }
    if (root && !isPathInside(root, resolved)) {
      errors.push(`${label} escapes the verification root`);
      return null;
    }
    return { raw: await readFile(resolved), path: resolved };
  } catch (error) {
    errors.push(`${label} cannot be read: ${error.message}`);
    return null;
  }
}

function normalizeNow(now, errors) {
  const value = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(value.getTime())) {
    errors.push("now must be a valid date");
    return new Date(0);
  }
  return value;
}

function expectObject(value, location, errors) {
  if (!isObject(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  return true;
}

function expectArray(value, location, errors, minimumLength) {
  if (!Array.isArray(value)) {
    errors.push(`${location} must be an array`);
    return false;
  }
  if (value.length < minimumLength) errors.push(`${location} must contain at least ${minimumLength} item${minimumLength === 1 ? "" : "s"}`);
  return true;
}

function expectExactKeys(value, requiredKeys, location, errors) {
  if (!isObject(value)) return;
  const allowed = new Set(requiredKeys);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) errors.push(`${location}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${location}.${key} is not allowed`);
  }
}

function expectLiteral(value, expected, location, errors) {
  if (value !== expected) errors.push(`${location} must equal ${JSON.stringify(expected)}`);
}

function expectEnum(value, allowed, location, errors) {
  if (!allowed.has(value)) errors.push(`${location} must be one of ${[...allowed].join(", ")}`);
}

function expectIdentifier(value, location, errors) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    errors.push(`${location} must be a 2-256 character identifier`);
  }
}

function expectSha256(value, location, errors) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) errors.push(`${location} must be 64 lowercase hex characters`);
}

function expectString(value, location, errors, maxLength) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    errors.push(`${location} must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function expectUtc(value, location, errors) {
  if (typeof value !== "string" || !UTC_PATTERN.test(value)) {
    errors.push(`${location} must be an ISO-8601 UTC timestamp ending in Z`);
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    errors.push(`${location} must be a real UTC timestamp`);
    return null;
  }
  return date;
}

function validateStringArray(value, location, errors) {
  if (!expectArray(value, location, errors, 1)) return;
  for (let index = 0; index < value.length; index += 1) {
    expectString(value[index], `${location}[${index}]`, errors, 4096);
    rejectPlaceholder(value[index], `${location}[${index}]`, errors);
  }
}

function validateExactIdSet(value, expected, location, errors) {
  if (!expectArray(value, location, errors, expected.length)) return;
  const actual = new Set();
  for (const id of value) {
    if (typeof id !== "string") {
      errors.push(`${location} contains a non-string ID`);
      continue;
    }
    if (actual.has(id)) errors.push(`${location} duplicates ${id}`);
    actual.add(id);
  }
  for (const id of expected) if (!actual.has(id)) errors.push(`${location} is missing ${id}`);
  for (const id of actual) if (!expected.includes(id)) errors.push(`${location} contains unknown ID ${id}`);
  if (value.length !== expected.length) errors.push(`${location} must contain exactly ${expected.length} IDs`);
}

function validateRelatedIds(value, allowed, location, errors) {
  if (!expectArray(value, location, errors, 0)) return;
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !allowed.has(id)) errors.push(`${location} contains out-of-scope ID ${JSON.stringify(id)}`);
    if (seen.has(id)) errors.push(`${location} duplicates ${id}`);
    seen.add(id);
  }
}

function rejectPlaceholder(value, location, errors) {
  if (typeof value === "string" && PLACEHOLDER_PATTERN.test(value.trim())) errors.push(`${location} contains a TBD/placeholder value`);
}

function normalizedOwnerId(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
}

function scanJsonForSecretKeys(value, location, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanJsonForSecretKeys(item, `${location}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_SECRET_KEYS.has(normalizedKey)) errors.push(`${location}.${key} is a forbidden secret-bearing field`);
    scanJsonForSecretKeys(item, `${location}.${key}`, errors);
  }
}

function scanTextForSecrets(value, location, errors) {
  if (typeof value !== "string") return;
  for (const detector of TEXT_SECRET_PATTERNS) {
    if (detector.pattern.test(value)) errors.push(`${location} contains possible ${detector.name}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return isPathInside(root, candidate) ? relative || "." : candidate;
}

function parseCliArgs(argv) {
  const output = {};
  const aliases = new Map([
    ["--approval", "approvalPath"],
    ["--root", "root"],
    ["--candidate-id", "candidateId"],
    ["--source-commit", "sourceCommit"],
    ["--signed-tag", "signedTag"],
    ["--candidate-manifest", "candidateManifestPath"],
    ["--now", "now"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = aliases.get(argv[index]);
    if (!key) throw new Error(`unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argv[index]} requires a value`);
    if (Object.hasOwn(output, key)) throw new Error(`${argv[index]} was provided more than once`);
    output[key] = value;
    index += 1;
  }
  for (const key of ["approvalPath", "candidateId", "sourceCommit", "signedTag"]) {
    if (!output[key]) throw new Error(`missing required argument for ${key}`);
  }
  return output;
}

async function main() {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const report = await verifyG0ScopeApproval({
      approvalPath: args.approvalPath,
      root: args.root ?? process.cwd(),
      expectedCandidate: {
        candidateId: args.candidateId,
        sourceCommit: args.sourceCommit,
        signedTag: args.signedTag,
      },
      candidateManifestPath: args.candidateManifestPath,
      now: args.now === undefined ? new Date() : new Date(args.now),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.gatePassed) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) await main();
