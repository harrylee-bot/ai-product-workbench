#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  validateReceiptSeal,
} from "./verify-workbench-reproducibility.mjs";
import { verifyG0ScopeApproval } from "./g0-scope-approval.mjs";

const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANDIDATE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const G1_SCHEMA_VERSION = 2;
const G2_SCHEMA_VERSION = "workbench.reproducibility-receipt.v1";
const REQUIRED_G2_CHECKS = Object.freeze([
  "openapi",
  "runtimeSchema",
  "runtimeValidator",
  "typecheck",
]);
const REQUIRED_G2_AUDITS = Object.freeze([
  "post-install",
  "generation-round-1",
  "generation-round-2",
  "post-checks",
]);
const G1_INVENTORY_KEYS = Object.freeze([
  "path",
  "repositoryState",
  "disposition",
  "reasonCode",
  "fileType",
  "byteSize",
  "sha256",
  "gitMode",
  "gitBlobId",
]);
const G1_REPOSITORY_STATES = Object.freeze(["tracked", "untracked", "ignored"]);
const G1_DISPOSITIONS = Object.freeze(["included", "blocked", "excluded", "external"]);
const G1_FILE_TYPES = new Set([
  "notInspected",
  "symbolicLink",
  "gitlink",
  "file",
  "other",
  "missing",
  "unreadable",
]);

/**
 * Verify the immutable inputs which must precede G3/G4 production work.
 *
 * The verifier intentionally accepts local paths only. CI is responsible for
 * downloading HTTPS artifacts into a private temporary directory and passing
 * their expected SHA-256 values here. This keeps network transport separate
 * from evidence semantics and makes the same verifier usable offline.
 */
export async function verifyReleaseChain({
  g0ApprovalPath,
  g1ManifestPath,
  g1InventoryPath,
  g2ReceiptPath,
  expectedCommit,
  expectedSignedTag,
  expectedHashes,
  verifyG0 = verifyG0ScopeApproval,
  now = new Date(),
} = {}) {
  const commit = requirePattern(expectedCommit, COMMIT_PATTERN, "expected source commit");
  const signedTag = requireNonEmpty(expectedSignedTag, "expected signed tag");
  const hashes = normalizeExpectedHashes(expectedHashes);
  const files = {
    g0Approval: loadArtifact(g0ApprovalPath, "G0 approval", hashes.g0Approval),
    g1Manifest: loadArtifact(g1ManifestPath, "G1 candidate manifest", hashes.g1Manifest),
    g1Inventory: loadArtifact(g1InventoryPath, "G1 inventory", hashes.g1Inventory),
    g2Receipt: loadArtifact(g2ReceiptPath, "G2 reproducibility receipt", hashes.g2Receipt),
  };

  const manifest = parseJson(files.g1Manifest, "G1 candidate manifest");
  const inventory = validateG1ManifestAndInventory({
    manifest,
    inventoryRaw: files.g1Inventory.raw,
    inventorySha256: files.g1Inventory.sha256,
    expectedCommit: commit,
    expectedSignedTag: signedTag,
  });

  const g0 = await verifyG0({
    approvalPath: files.g0Approval.path,
    root: resolve(files.g0Approval.path, ".."),
    expectedCandidate: {
      candidateId: manifest.candidateId,
      sourceCommit: commit,
      signedTag,
    },
    candidateManifestPath: files.g1Manifest.path,
    now,
  });
  assert(g0?.gatePassed === true, "G0 approval must have executionStatus PASS");
  assert(g0.candidateManifestVerified === true, "G0 must independently verify the G1 candidate manifest");
  assert(g0.sourceCommit === commit, "G0 source commit does not match the release candidate");
  assert(g0.signedTag === signedTag, "G0 signed tag does not match the release candidate");
  assert(g0.candidateId === manifest.candidateId, "G0 candidateId does not match the G1 manifest");

  const receipt = parseJson(files.g2Receipt, "G2 reproducibility receipt");
  validateG2Receipt({
    receipt,
    expectedCommit: commit,
    expectedSignedTag: signedTag,
    expectedSourceTree: manifest.sourceTree.gitTree,
    expectedTagObject: manifest.signedTag.tagObject,
    expectedTagPayloadSha256: manifest.signedTag.payloadSha256,
  });

  const chainIdentity = {
    candidateId: manifest.candidateId,
    sourceCommit: commit,
    signedTag,
    g0ApprovalSha256: files.g0Approval.sha256,
    g1ManifestSha256: files.g1Manifest.sha256,
    g1InventorySha256: files.g1Inventory.sha256,
    g2ReceiptSha256: files.g2Receipt.sha256,
  };
  const chainId = `sha256:${sha256(canonicalJson(chainIdentity))}`;
  return {
    status: "PASS",
    chainId,
    candidateId: manifest.candidateId,
    sourceCommit: commit,
    signedTag,
    g0: {
      recordId: g0.recordId,
      environmentId: g0.environmentId,
      approvalSha256: files.g0Approval.sha256,
    },
    g1: {
      manifestSha256: files.g1Manifest.sha256,
      inventorySha256: files.g1Inventory.sha256,
      inventoryByteSize: inventory.byteSize,
      inventoryEntryCount: inventory.entryCount,
    },
    g2: {
      receiptSha256: files.g2Receipt.sha256,
      receiptPayloadSha256: receipt.payloadSha256,
    },
  };
}

export function validateG1ManifestAndInventory({
  manifest,
  inventoryRaw,
  inventorySha256,
  expectedCommit,
  expectedSignedTag,
}) {
  assertObject(manifest, "G1 candidate manifest");
  assert(manifest.schemaVersion === G1_SCHEMA_VERSION, `G1 candidate manifest schemaVersion must be ${G1_SCHEMA_VERSION}`);
  assert(manifest.product === "产品工作台", "G1 candidate manifest product is invalid");
  assert(manifest.technicalIdentifier === "workbench", "G1 candidate manifest technicalIdentifier is invalid");
  assert(CANDIDATE_ID_PATTERN.test(manifest.candidateId), "G1 candidateId must be a prefixed SHA-256");
  assert(manifest.sourceCommit === expectedCommit, "G1 sourceCommit does not match the expected commit");
  assert(manifest.gate?.gateId === "G1", "G1 manifest gateId must be G1");
  assert(manifest.gate?.status === "PASS", "G1 gate.status must be PASS");
  assert(manifest.gate?.findingCount === 0, "G1 gate.findingCount must be zero");
  assert(Array.isArray(manifest.findings) && manifest.findings.length === 0, "G1 findings must be empty");
  assert(manifest.status?.clean === true && manifest.status?.porcelainV1 === "", "G1 source worktree must be clean");
  assert(manifest.signedTag?.verified === true, "G1 signedTag must be verified");
  assert(manifest.signedTag?.name === expectedSignedTag, "G1 signedTag name does not match the expected tag");
  assert(manifest.signedTag?.targetCommit === expectedCommit, "G1 signedTag target must match sourceCommit");
  assert(manifest.captureConsistency && Object.values(manifest.captureConsistency).every(Boolean), "G1 capture consistency must be true");
  const deerFlow = manifest.releaseMetadata?.deerFlow;
  assertObject(deerFlow, "G1 releaseMetadata.deerFlow");
  assert(COMMIT_PATTERN.test(deerFlow.sourceCommit ?? ""), "G1 DeerFlow sourceCommit is invalid");
  assert(PREFIXED_SHA256_PATTERN.test(deerFlow.baseImageDigest ?? ""), "G1 DeerFlow baseImageDigest is invalid");
  assert(SHA256_PATTERN.test(deerFlow.overlayConfigSha256 ?? ""), "G1 DeerFlow overlayConfigSha256 is invalid");
  assert(!Object.hasOwn(deerFlow, "imageDigest"), "G1 DeerFlow imageDigest is not supported before G4");

  const inventory = validateInventoryBytes({
    raw: inventoryRaw,
    expectedSha256: inventorySha256,
    expectedManifestInventory: manifest.inventory,
    expectedSourceTree: manifest.sourceTree,
  });
  return inventory;
}

export function validateG2Receipt({
  receipt,
  expectedCommit,
  expectedSignedTag,
  expectedSourceTree,
  expectedTagObject,
  expectedTagPayloadSha256,
}) {
  try {
    validateReceiptSeal(receipt);
  } catch (error) {
    throw new Error(`G2 receipt seal invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(receipt.schemaVersion === G2_SCHEMA_VERSION, "G2 receipt schemaVersion is invalid");
  const payload = receipt.payload;
  assertObject(payload, "G2 receipt payload");
  assert(payload.product === "产品工作台", "G2 product is invalid");
  assert(payload.technicalIdentifier === "workbench", "G2 technicalIdentifier is invalid");
  assert(payload.gateId === "G2", "G2 gateId must be G2");
  assert(payload.status === "PASS", "G2 status must be PASS");
  assert(payload.failure === null, "G2 failure must be null for PASS");
  assert(payload.binding?.sourceCommit === expectedCommit, "G2 source commit does not match G1");
  assert(payload.binding?.cloneCommit === expectedCommit, "G2 clone commit does not match G1");
  assert(payload.binding?.sourceTree === expectedSourceTree, "G2 source tree does not match G1");
  assert(payload.binding?.cloneTree === expectedSourceTree, "G2 clone tree does not match G1");
  assert(payload.binding?.tag?.name === expectedSignedTag, "G2 tag name does not match G1");
  if (expectedTagObject !== undefined) {
    assert(payload.binding?.tag?.objectId === expectedTagObject, "G2 tag object does not match G1");
  }
  if (expectedTagPayloadSha256 !== undefined) {
    assert(payload.binding?.tag?.payloadSha256 === expectedTagPayloadSha256, "G2 tag payload does not match G1");
  }
  assert(payload.binding?.tag?.peeledCommit === expectedCommit, "G2 tag peeled commit does not match G1");
  assert(payload.binding?.tag?.verified === true, "G2 tag must be verified");

  assert(Array.isArray(payload.generationRounds) && payload.generationRounds.length === 2, "G2 must contain exactly two generation rounds");
  assert(
    payload.generationRounds.every((round, index) => round?.round === index + 1 && round.status === "PASS" && SHA256_PATTERN.test(round.sourceAuditSha256 ?? "")),
    "G2 generation rounds must both PASS with sealed source audits",
  );
  assert(Array.isArray(payload.checks), "G2 checks must be an array");
  assert(
    payload.checks.length === REQUIRED_G2_CHECKS.length
      && payload.checks.every((check, index) => check?.id === REQUIRED_G2_CHECKS[index] && check.status === "PASS"),
    "G2 must PASS all required reproducibility checks",
  );
  assert(Array.isArray(payload.skippedChecks) && payload.skippedChecks.length === 0, "G2 must not skip checks");
  assert(Array.isArray(payload.sourceAudits), "G2 sourceAudits must be an array");
  assert(
    payload.sourceAudits.length === REQUIRED_G2_AUDITS.length
      && payload.sourceAudits.every((audit, index) => audit?.phase === REQUIRED_G2_AUDITS[index] && audit.status === "PASS"),
    "G2 source audits must contain all required PASS phases",
  );
  for (const round of payload.generationRounds) {
    const audit = payload.sourceAudits.find((entry) => entry.phase === `generation-round-${round.round}`);
    assert(
      round.sourceAuditSha256 === sha256(canonicalJson(audit)),
      `G2 generation round ${round.round} source audit hash does not match its sealed audit`,
    );
  }
  assert(payload.isolation?.initialClean === true, "G2 isolated clone must start clean");
  assert(payload.isolation?.cleanupStatus === "PASS", "G2 isolated clone cleanup must PASS");
  assert(Array.isArray(payload.commands) && payload.commands.length > 0, "G2 command evidence is required");
  assert(payload.commands.every((command) => command?.status === "PASS"), "G2 PASS receipt cannot contain failed or skipped commands");
  return true;
}

export function validateInventoryBytes({
  raw,
  expectedSha256,
  expectedManifestInventory,
  expectedSourceTree,
}) {
  assert(Buffer.isBuffer(raw), "G1 inventory must be supplied as bytes");
  assert(SHA256_PATTERN.test(expectedSha256 ?? ""), "G1 inventory SHA-256 is invalid");
  const actualSha256 = sha256(raw);
  assert(actualSha256 === expectedSha256, "G1 inventory SHA-256 does not match the downloaded artifact");
  assertObject(expectedManifestInventory, "G1 manifest inventory");
  assert(expectedManifestInventory.sha256 === actualSha256, "G1 manifest inventory hash does not match the artifact");
  assert(expectedManifestInventory.byteSize === raw.length, "G1 manifest inventory byteSize does not match the artifact");
  assert(raw.length === 0 || raw.at(-1) === 0x0a, "G1 inventory must be LF terminated");

  const text = raw.toString("utf8");
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  const entries = [];
  for (const [index, line] of lines.entries()) {
    assert(line.length > 0, `G1 inventory line ${index + 1} is empty`);
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`G1 inventory line ${index + 1} is not valid JSON`);
    }
    assert(canonicalJson(entry) === line, `G1 inventory line ${index + 1} is not canonical JSON`);
    validateG1InventoryEntry(entry, index);
    if (index > 0) {
      assert(entries[index - 1].path < entry.path, "G1 inventory paths must be unique and sorted by Unicode code point");
    }
    entries.push(entry);
  }
  assert(expectedManifestInventory.entryCount === lines.length, "G1 inventory entryCount does not match the artifact");
  validateInventorySummary({
    entries,
    field: "repositoryState",
    expected: expectedManifestInventory.byRepositoryState,
    requiredValues: G1_REPOSITORY_STATES,
  });
  validateInventorySummary({
    entries,
    field: "disposition",
    expected: expectedManifestInventory.byDisposition,
    requiredValues: G1_DISPOSITIONS,
  });
  if (expectedSourceTree !== undefined) {
    assertObject(expectedSourceTree, "G1 manifest sourceTree");
    const included = entries.filter((entry) => entry.disposition === "included");
    assert(expectedSourceTree.entryCount === included.length, "G1 sourceTree entryCount does not match included inventory entries");
    assert(
      expectedSourceTree.sha256 === sha256(canonicalJson(included.map(compactInventoryEntry))),
      "G1 sourceTree SHA-256 does not match included inventory entries",
    );
  }
  return {
    sha256: actualSha256,
    byteSize: raw.length,
    entryCount: lines.length,
  };
}

function validateG1InventoryEntry(entry, index) {
  assertObject(entry, `G1 inventory line ${index + 1}`);
  assert(
    canonicalJson(Object.keys(entry).sort()) === canonicalJson([...G1_INVENTORY_KEYS].sort()),
    `G1 inventory line ${index + 1} has an invalid field set`,
  );
  assert(
    typeof entry.path === "string"
      && entry.path.length > 0
      && !posix.isAbsolute(entry.path)
      && !entry.path.includes("\\")
      && !entry.path.includes("\0")
      && posix.normalize(entry.path) === entry.path
      && entry.path !== ".."
      && !entry.path.startsWith("../"),
    `G1 inventory line ${index + 1} has an invalid repository path`,
  );
  assert(G1_REPOSITORY_STATES.includes(entry.repositoryState), `G1 inventory line ${index + 1} repositoryState is invalid`);
  assert(G1_DISPOSITIONS.includes(entry.disposition), `G1 inventory line ${index + 1} disposition is invalid`);
  assert(typeof entry.reasonCode === "string" && entry.reasonCode.length > 0, `G1 inventory line ${index + 1} reasonCode is invalid`);
  assert(G1_FILE_TYPES.has(entry.fileType), `G1 inventory line ${index + 1} fileType is invalid`);
  assert(
    entry.byteSize === null || (Number.isSafeInteger(entry.byteSize) && entry.byteSize >= 0),
    `G1 inventory line ${index + 1} byteSize is invalid`,
  );
  assert(entry.sha256 === null || SHA256_PATTERN.test(entry.sha256), `G1 inventory line ${index + 1} SHA-256 is invalid`);
  assert(entry.gitMode === null || /^[0-7]{6}$/u.test(entry.gitMode), `G1 inventory line ${index + 1} gitMode is invalid`);
  assert(entry.gitBlobId === null || COMMIT_PATTERN.test(entry.gitBlobId), `G1 inventory line ${index + 1} gitBlobId is invalid`);
  if (entry.disposition === "included") {
    assert(entry.repositoryState === "tracked", `G1 inventory line ${index + 1} included entry must be tracked`);
    assert(SHA256_PATTERN.test(entry.sha256 ?? ""), `G1 inventory line ${index + 1} included entry requires a SHA-256`);
    assert(entry.gitMode !== null && entry.gitBlobId !== null, `G1 inventory line ${index + 1} included entry requires Git identity`);
  }
}

function validateInventorySummary({ entries, field, expected, requiredValues }) {
  assertObject(expected, `G1 manifest inventory ${field} summary`);
  assert(
    canonicalJson(Object.keys(expected).sort()) === canonicalJson([...requiredValues].sort()),
    `G1 manifest inventory ${field} summary has an invalid field set`,
  );
  for (const value of requiredValues) {
    const selected = entries.filter((entry) => entry[field] === value);
    const ndjson = selected.length === 0 ? "" : `${selected.map((entry) => canonicalJson(entry)).join("\n")}\n`;
    assertObject(expected[value], `G1 manifest inventory ${field}.${value}`);
    assert(expected[value].entryCount === selected.length, `G1 manifest inventory ${field}.${value} entryCount mismatch`);
    assert(expected[value].sha256 === sha256(ndjson), `G1 manifest inventory ${field}.${value} SHA-256 mismatch`);
  }
}

function compactInventoryEntry(entry) {
  return {
    path: entry.path,
    fileType: entry.fileType,
    byteSize: entry.byteSize,
    sha256: entry.sha256,
    gitMode: entry.gitMode,
    gitBlobId: entry.gitBlobId,
  };
}

export function loadArtifact(inputPath, label, expectedSha256) {
  const path = resolveRequiredPath(inputPath, label);
  const raw = readFileSync(path);
  const sha = sha256(raw);
  assert(SHA256_PATTERN.test(expectedSha256 ?? ""), `${label} expected SHA-256 is required`);
  assert(sha === expectedSha256, `${label} SHA-256 mismatch`);
  const stats = statSync(path);
  assert(stats.isFile(), `${label} must be a regular file`);
  return { path, raw, sha256: sha, byteSize: raw.length };
}

function normalizeExpectedHashes(value) {
  assertObject(value, "expected artifact hashes");
  return {
    g0Approval: requirePattern(value.g0Approval, SHA256_PATTERN, "G0 approval SHA-256"),
    g1Manifest: requirePattern(value.g1Manifest, SHA256_PATTERN, "G1 manifest SHA-256"),
    g1Inventory: requirePattern(value.g1Inventory, SHA256_PATTERN, "G1 inventory SHA-256"),
    g2Receipt: requirePattern(value.g2Receipt, SHA256_PATTERN, "G2 receipt SHA-256"),
  };
}

function parseJson(artifact, label) {
  try {
    return JSON.parse(artifact.raw.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function resolveRequiredPath(value, label) {
  assert(typeof value === "string" && value.trim() !== "", `${label} path is required`);
  return resolve(value);
}

function requireNonEmpty(value, label) {
  assert(typeof value === "string" && value.trim() !== "", `${label} is required`);
  return value.trim();
}

function requirePattern(value, pattern, label) {
  assert(typeof value === "string" && pattern.test(value), `${label} is invalid`);
  return value;
}

function assertObject(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const result = {};
  const valueFor = (argument, index) => {
    const value = argv[index + 1];
    assert(value !== undefined && !value.startsWith("--"), `${argument} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--g0") result.g0ApprovalPath = valueFor(argument, index++);
    else if (argument === "--g1-manifest") result.g1ManifestPath = valueFor(argument, index++);
    else if (argument === "--g1-inventory") result.g1InventoryPath = valueFor(argument, index++);
    else if (argument === "--g2") result.g2ReceiptPath = valueFor(argument, index++);
    else if (argument === "--commit") result.expectedCommit = valueFor(argument, index++);
    else if (argument === "--tag") result.expectedSignedTag = valueFor(argument, index++);
    else if (argument === "--g0-sha256") (result.expectedHashes ??= {}).g0Approval = valueFor(argument, index++);
    else if (argument === "--g1-manifest-sha256") (result.expectedHashes ??= {}).g1Manifest = valueFor(argument, index++);
    else if (argument === "--g1-inventory-sha256") (result.expectedHashes ??= {}).g1Inventory = valueFor(argument, index++);
    else if (argument === "--g2-sha256") (result.expectedHashes ??= {}).g2Receipt = valueFor(argument, index++);
    else throw new Error(`unsupported argument: ${argument}`);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = await verifyReleaseChain(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`release chain verification: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
