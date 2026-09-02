import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { auditKnowledgeVault } from "./knowledge-vault-audit.mjs";

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

export const RELEASE_CANDIDATE_SCHEMA_VERSION = 2;

export const REQUIRED_KNOWLEDGE_VAULT_CONFIG = Object.freeze([
  "knowledge-vault/.obsidian/app.json",
  "knowledge-vault/.obsidian/core-plugins.json",
  "knowledge-vault/.obsidian/graph.json",
  "knowledge-vault/.obsidian/templates.json",
]);

const REQUIRED_REMEDIATION_CONTROL_FILES = Object.freeze([
  "docs/CODEX-RUNTIME-DATABASE-REMEDIATION-SPEC-20260723.md",
  "docs/CODEX-WORKBENCH-FUNCTIONAL-VISUAL-REMEDIATION-SPEC-20260727.md",
  "schemas/release-candidate-manifest.schema.json",
]);

export const REQUIRED_SOURCE_SCOPES = Object.freeze([
  {
    name: "rootBuildInputs",
    roots: [],
    exactPaths: [
      ".dependency-cruiser.cjs",
      ".dockerignore",
      ".env.example",
      ".gitignore",
      ".npmrc",
      "README.md",
      "package.json",
      "package-lock.json",
      "tsconfig.base.json",
    ],
  },
  { name: "ci", roots: [".github/"] },
  { name: "deployment", roots: ["deploy/"] },
  { name: "runbooks", roots: ["docs/runbooks/"] },
  { name: "evidenceContracts", roots: ["docs/evidence/", "schemas/"] },
  { name: "web", roots: ["apps/web/"] },
  { name: "quartz", roots: ["apps/knowledge/"] },
  { name: "workbenchApi", roots: ["apps/workbench-api/"] },
  { name: "runtimeWorker", roots: ["apps/workbench-worker/"] },
  { name: "fileWorker", roots: ["apps/workbench-file-worker/"] },
  { name: "importWorker", roots: ["apps/workbench-import-worker/"] },
  { name: "exportWorker", roots: ["apps/workbench-export-worker/"] },
  { name: "preview", roots: ["apps/workbench-preview/"] },
  { name: "figmaImporter", roots: ["apps/workbench-figma-importer/"] },
  { name: "workbenchPackages", roots: ["packages/workbench-"] },
  { name: "deerFlowIntegration", roots: ["integrations/deerflow/"] },
  { name: "releaseAndOperationsScripts", roots: ["scripts/"] },
  { name: "knowledgeVaultMarkdown", roots: ["knowledge-vault/"], markdownOnly: true },
  { name: "knowledgeVaultConfiguration", roots: [], exactPaths: REQUIRED_KNOWLEDGE_VAULT_CONFIG },
  { name: "remediationControl", roots: [], exactPaths: REQUIRED_REMEDIATION_CONTROL_FILES },
]);

export const REQUIRED_GENERATED_CONTRACTS = Object.freeze([
  "packages/workbench-contracts/openapi/baseline/workbench.v1.yaml",
  "packages/workbench-contracts/openapi/workbench.v1.yaml",
  "integrations/deerflow/skills/workbench/references/runtime-result.schema.json",
  "integrations/deerflow/skills/workbench/references/prd-runtime-result.schema.json",
  "integrations/deerflow/runtime-tools/deerflow_workbench_tools/runtime_result_validator.bundle.mjs",
]);

const REQUIRED_HARD_CUT_FILES = Object.freeze([
  "docs/workbench-hard-cut-deletion-manifest.json",
  "scripts/workbench-hard-cut-manifest.mjs",
]);

const CRITICAL_GROUP_DEFINITIONS = Object.freeze([
  {
    name: "lockfile",
    exactPaths: ["package-lock.json"],
    includeEntries: true,
  },
  {
    name: "generatedContracts",
    exactPaths: REQUIRED_GENERATED_CONTRACTS,
    includeEntries: true,
  },
  {
    name: "databaseSchema",
    exactPaths: ["packages/workbench-db/prisma/schema.prisma"],
    includeEntries: true,
  },
  {
    name: "migrations",
    roots: ["packages/workbench-db/prisma/migrations/"],
    predicate: (candidatePath) => candidatePath.endsWith("/migration.sql"),
    includeEntries: true,
  },
  {
    name: "ci",
    roots: [".github/workflows/"],
  },
  {
    name: "deployment",
    roots: ["deploy/"],
  },
  {
    name: "hardCutDeletion",
    exactPaths: REQUIRED_HARD_CUT_FILES,
    includeEntries: true,
  },
  {
    name: "brandAssets",
    roots: ["apps/web/public/brand/"],
    exactPaths: ["apps/web/app/icon.png", "apps/web/app/favicon.ico"],
  },
  {
    name: "knowledgeVaultMarkdown",
    roots: ["knowledge-vault/"],
    predicate: (candidatePath) => candidatePath.endsWith(".md"),
  },
  {
    name: "knowledgeVaultConfiguration",
    exactPaths: REQUIRED_KNOWLEDGE_VAULT_CONFIG,
    includeEntries: true,
  },
  {
    name: "remediationControl",
    exactPaths: REQUIRED_REMEDIATION_CONTROL_FILES,
    includeEntries: true,
  },
  {
    name: "evidenceContracts",
    roots: ["docs/evidence/", "schemas/"],
  },
]);

const EXCLUDED_PATH_RULES = Object.freeze([
  { reasonCode: "dependencyCache", test: (candidatePath) => hasSegment(candidatePath, "node_modules") },
  { reasonCode: "nextBuildOutput", test: (candidatePath) => hasSegment(candidatePath, ".next") },
  { reasonCode: "compiledOutput", test: (candidatePath) => hasSegment(candidatePath, "dist") },
  { reasonCode: "coverageOutput", test: (candidatePath) => hasSegment(candidatePath, "coverage") },
  { reasonCode: "pythonCache", test: (candidatePath) => hasSegment(candidatePath, "__pycache__") || candidatePath.endsWith(".pyc") },
  { reasonCode: "testEvidenceOutput", test: (candidatePath) => candidatePath === "output" || candidatePath.startsWith("output/") },
  { reasonCode: "playwrightLocalOutput", test: (candidatePath) => candidatePath === ".playwright-cli" || candidatePath.startsWith(".playwright-cli/") },
  { reasonCode: "generatedPrismaClient", test: (candidatePath) => candidatePath.startsWith("packages/workbench-db/generated/") },
  { reasonCode: "figmaBuildOutput", test: (candidatePath) => candidatePath.startsWith("apps/workbench-figma-importer/build/") },
  { reasonCode: "typescriptBuildInfo", test: (candidatePath) => candidatePath.endsWith(".tsbuildinfo") },
  { reasonCode: "localEditorState", test: (candidatePath) => candidatePath === ".DS_Store" || candidatePath.startsWith(".claude/") },
  { reasonCode: "transientFile", test: (candidatePath) => /(?:\.log|\.tmp|\.temp|\.bak|\.backup|\.orig|\.rej|\.swp|~)$/.test(candidatePath) },
]);

const SECRET_BASENAME_PATTERNS = Object.freeze([
  /^\.env(?:\..+)?$/i,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  /^(?:credentials|service-account|service_account)(?:\.[^.]+)?\.json$/i,
  /^(?:secrets?|tokens?|private[-_]?keys?)$/i,
  /^(?:secrets?|tokens?|private[-_]?keys?)\.(?:json|ya?ml|txt)$/i,
  /secret-channel-attestation\.json$/i,
]);

const SECRET_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx", ".jks"]);

const REASON_DESCRIPTIONS = Object.freeze({
  trackedCandidateFile: "Tracked repository content is part of the immutable source candidate.",
  untrackedCandidateFile: "Untracked content has no immutable source provenance and blocks G1.",
  ignoredCriticalFile: "A runtime-critical ignored file can make a fresh clone diverge and blocks G1.",
  secretMaterial: "Secret-like material is never read into evidence and blocks candidate creation.",
  referencedKnowledgeStorageAsset: "Large source asset stays in storage and is bound through a knowledge-vault reference, byte size, and SHA-256.",
  unreferencedStorageAsset: "Unreferenced raw storage is outside the candidate and is explicitly excluded.",
  knowledgeVaultNonMarkdown: "Knowledge-vault publishes structured Markdown; non-Markdown assets must live under storage and be referenced by an index.",
  trackedExcludedArtifact: "Cache or generated output must not be tracked as candidate source.",
  ignoredNonCriticalFile: "Ignored local-only content is excluded and represented only in the external inventory.",
  dependencyCache: "Dependency cache is excluded.",
  nextBuildOutput: "Next.js build output is excluded.",
  compiledOutput: "Compiled output is excluded; reproducibility must rebuild it from source.",
  coverageOutput: "Coverage output is excluded.",
  pythonCache: "Python cache is excluded.",
  testEvidenceOutput: "Mutable local evidence output is excluded from source provenance.",
  playwrightLocalOutput: "Mutable browser automation output is excluded.",
  generatedPrismaClient: "Generated Prisma client is excluded and must be reproduced during G2.",
  figmaBuildOutput: "Figma build output is excluded and must be reproduced during G2.",
  typescriptBuildInfo: "TypeScript incremental build metadata is excluded and must be regenerated.",
  localEditorState: "Local editor state is excluded.",
  transientFile: "Transient file is excluded.",
});

export async function createReleaseCandidateManifest({
  repoRoot,
  audit,
  signedTag = null,
  expectedMigrationCount = null,
  releaseMetadata,
  inventoryArtifactName = "release-candidate-inventory.ndjson",
  knowledgeAuditOptions = {},
} = {}) {
  const resolvedRepoRoot = await validateRepositoryRoot(repoRoot);
  const findings = [];
  const normalizedAudit = validateAuditMetadata(audit, findings);
  const normalizedReleaseMetadata = normalizeReleaseMetadata(releaseMetadata);
  const expectedMigrations = normalizeExpectedMigrationCount(expectedMigrationCount, findings);

  const before = await collectGitIdentity(resolvedRepoRoot, signedTag);
  const knowledgeClosure = await collectKnowledgeClosure(resolvedRepoRoot, knowledgeAuditOptions, findings);
  const snapshot = await collectRepositorySnapshot({
    repoRoot: resolvedRepoRoot,
    referencedStorageAssets: knowledgeClosure.referencedAssets,
    findings,
  });
  const after = await collectGitIdentity(resolvedRepoRoot, signedTag);
  validateCaptureConsistency(before, after, findings);

  validateRepositoryIdentity(before, signedTag, findings);
  validateInventory(snapshot.entries, findings);

  const inventory = createInventoryArtifact(snapshot.entries);
  const includedEntries = snapshot.entries.filter((entry) => entry.disposition === "included");
  const sourceTreeSha256 = digestEntrySet(includedEntries);
  const sourceScopes = buildSourceScopes(snapshot.entries, findings);
  const criticalArtifacts = buildCriticalArtifactGroups({
    entries: snapshot.entries,
    expectedMigrationCount: expectedMigrations,
    findings,
  });
  validateKnowledgeStorageInventory({
    entries: snapshot.entries,
    knowledgeClosure,
    findings,
  });

  if (before.status.porcelainV1 !== "") {
    addFinding(findings, "DIRTY_WORKTREE", "git status --porcelain=v1 --untracked-files=all is not empty");
  }

  const normalizedFindings = sortAndDedupeFindings(findings);
  const candidateIdentity = {
    sourceCommit: before.sourceCommit,
    sourceTree: sourceTreeSha256,
    signedTag: before.signedTag.verified ? {
      name: before.signedTag.name,
      tagObject: before.signedTag.tagObject,
      payloadSha256: before.signedTag.payloadSha256,
    } : null,
  };
  const candidateId = `sha256:${sha256(canonicalJson(candidateIdentity))}`;

  const manifest = {
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    product: "产品工作台",
    technicalIdentifier: "workbench",
    candidateId,
    sourceCommit: before.sourceCommit,
    sourceTree: {
      gitTree: before.gitTree,
      sha256: sourceTreeSha256,
      entryCount: includedEntries.length,
    },
    branch: before.branch,
    signedTag: before.signedTag,
    sourceCommitSignature: before.sourceCommitSignature,
    status: before.status,
    environmentId: normalizedReleaseMetadata.environmentId,
    deployId: normalizedReleaseMetadata.deployId,
    configRevision: normalizedReleaseMetadata.configRevision,
    audit: normalizedAudit,
    releaseMetadata: {
      postgresVersion: normalizedReleaseMetadata.postgresVersion,
      pgvectorVersion: normalizedReleaseMetadata.pgvectorVersion,
      deerFlow: normalizedReleaseMetadata.deerFlow,
      images: normalizedReleaseMetadata.images,
      artifacts: normalizedReleaseMetadata.artifacts,
    },
    inventory: {
      artifactName: validateArtifactName(inventoryArtifactName),
      mediaType: "application/x-ndjson",
      canonicalization: "one canonical JSON object per LF-terminated line; paths sorted by Unicode code point",
      sha256: inventory.sha256,
      byteSize: Buffer.byteLength(inventory.ndjson),
      entryCount: snapshot.entries.length,
      byRepositoryState: inventory.byRepositoryState,
      byDisposition: inventory.byDisposition,
    },
    sourceScopes,
    criticalArtifacts,
    knowledgeStorage: knowledgeClosure.manifestValue,
    scopePolicy: {
      inventoryStates: ["tracked", "untracked", "ignored"],
      sourceCandidateIncludes: "all tracked repository files except forbidden cache, generated output, secret material, and raw storage assets",
      rawStoragePolicy: "only knowledge-vault referenced storage assets are bound as external assets; binaries remain under storage and outside the public candidate",
      reasonDescriptions: REASON_DESCRIPTIONS,
    },
    captureConsistency: {
      sourceCommitStable: before.sourceCommit === after.sourceCommit,
      gitTreeStable: before.gitTree === after.gitTree,
      branchStable: before.branch === after.branch,
      statusStable: before.status.sha256 === after.status.sha256,
    },
    gate: {
      gateId: "G1",
      status: normalizedFindings.length === 0 ? "PASS" : "FAIL",
      findingCount: normalizedFindings.length,
    },
    findings: normalizedFindings,
  };

  return {
    manifest,
    manifestJson: `${canonicalJson(manifest)}\n`,
    inventoryNdjson: inventory.ndjson,
    passed: normalizedFindings.length === 0,
  };
}

async function validateRepositoryRoot(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
    throw new Error("repoRoot is required");
  }
  const requested = await realpath(path.resolve(repoRoot));
  const topLevel = (await runGit(requested, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  const canonicalTopLevel = await realpath(topLevel);
  if (requested !== canonicalTopLevel) {
    throw new Error(`repoRoot must be the Git top level: ${canonicalTopLevel}`);
  }
  return requested;
}

function validateAuditMetadata(audit, findings) {
  const input = isPlainObject(audit) ? audit : {};
  const startedAt = validateUtcTimestamp(input.startedAt, "audit.startedAt", findings);
  const endedAt = validateUtcTimestamp(input.endedAt, "audit.endedAt", findings);
  const executor = validateNonEmptyString(input.executor, "audit.executor", findings);
  const verifier = validateNonEmptyString(input.verifier, "audit.verifier", findings);
  if (startedAt && endedAt && Date.parse(endedAt) < Date.parse(startedAt)) {
    addFinding(findings, "AUDIT_TIME_RANGE_INVALID", "audit.endedAt must not precede audit.startedAt");
  }
  return { startedAt, endedAt, executor, verifier };
}

export function normalizeReleaseMetadata(value) {
  const issues = [];
  const input = isPlainObject(value) ? value : {};
  if (!isPlainObject(value)) issues.push("releaseMetadata must be an object");
  const allowedKeys = new Set([
    "environmentId",
    "deployId",
    "configRevision",
    "postgresVersion",
    "pgvectorVersion",
    "deerFlow",
    "images",
    "artifacts",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) issues.push(`releaseMetadata.${key} is not supported`);
  }
  assertNoSecretMetadataKeys(input, issues);

  const normalized = {
    environmentId: requiredMetadataString(input.environmentId, "releaseMetadata.environmentId", issues),
    deployId: requiredMetadataString(input.deployId, "releaseMetadata.deployId", issues),
    configRevision: requiredMetadataString(input.configRevision, "releaseMetadata.configRevision", issues),
    postgresVersion: requiredMetadataString(input.postgresVersion, "releaseMetadata.postgresVersion", issues),
    pgvectorVersion: requiredMetadataString(input.pgvectorVersion, "releaseMetadata.pgvectorVersion", issues),
    deerFlow: normalizeDeerFlowMetadata(input.deerFlow, issues),
    images: normalizeDigestMap(input.images, "releaseMetadata.images", issues),
    artifacts: normalizeDigestMap(input.artifacts, "releaseMetadata.artifacts", issues),
  };
  if (issues.length > 0) throw new Error(`invalid release metadata: ${issues.join("; ")}`);
  return normalized;
}

function normalizeDeerFlowMetadata(value, issues) {
  const label = "releaseMetadata.deerFlow";
  if (!isPlainObject(value)) {
    issues.push(`${label} must be an object`);
    return { sourceCommit: null, baseImageDigest: null, overlayConfigSha256: null };
  }
  const allowedKeys = new Set(["sourceCommit", "baseImageDigest", "overlayConfigSha256"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(`${label}.${key} is not supported`);
  }
  const sourceCommit = requiredMetadataString(value.sourceCommit, `${label}.sourceCommit`, issues);
  const baseImageDigest = requiredMetadataString(
    value.baseImageDigest,
    `${label}.baseImageDigest`,
    issues,
  );
  const overlayConfigSha256 = requiredMetadataString(value.overlayConfigSha256, `${label}.overlayConfigSha256`, issues);
  if (sourceCommit && !GIT_OBJECT_ID_PATTERN.test(sourceCommit)) {
    issues.push(`${label}.sourceCommit must be a lowercase 40- or 64-character Git object ID`);
  }
  if (baseImageDigest && !IMAGE_DIGEST_PATTERN.test(baseImageDigest)) {
    issues.push(`${label}.baseImageDigest must be an immutable sha256 image digest`);
  }
  if (overlayConfigSha256 && !SHA256_PATTERN.test(overlayConfigSha256)) {
    issues.push(`${label}.overlayConfigSha256 must be a lowercase SHA-256 digest`);
  }
  return { sourceCommit, baseImageDigest, overlayConfigSha256 };
}

function normalizeDigestMap(value, label, issues) {
  if (!isPlainObject(value)) {
    issues.push(`${label} must be an explicit object (use {} when no R0 digests exist)`);
    return {};
  }
  const result = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    const candidate = value[key];
    if (typeof candidate !== "string" || candidate.trim() === "") {
      issues.push(`${label}.${key} must be an immutable sha256 digest`);
      continue;
    }
    if (!IMAGE_DIGEST_PATTERN.test(candidate)) {
      issues.push(`${label}.${key} must be an immutable sha256 digest`);
    }
    result[key] = candidate;
  }
  return result;
}

function requiredMetadataString(value, label, issues) {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${label} must be a non-empty string`);
    return null;
  }
  return value.trim();
}

function assertNoSecretMetadataKeys(value, issues, prefix = "releaseMetadata") {
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const label = `${prefix}.${key}`;
    if (/(?:password|passwd|secret|token|credential|private.?key|api.?key)/i.test(key)) {
      issues.push(`${label} must never be written to a candidate manifest`);
      continue;
    }
    if (isPlainObject(child)) assertNoSecretMetadataKeys(child, issues, label);
  }
}

function normalizeExpectedMigrationCount(value, findings) {
  if (!Number.isInteger(value) || value < 1) {
    addFinding(findings, "EXPECTED_MIGRATION_COUNT_REQUIRED", "expectedMigrationCount must be an explicitly injected positive integer");
    return null;
  }
  return value;
}

async function collectGitIdentity(repoRoot, requestedTag) {
  const sourceCommit = await runGitText(repoRoot, ["rev-parse", "HEAD"]);
  const gitTree = await runGitText(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  let branch = null;
  try {
    branch = await runGitText(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    branch = null;
  }
  const statusRaw = (await runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toString("utf8");
  const signedTag = await inspectSignedTag(repoRoot, requestedTag, sourceCommit);
  const sourceCommitSignature = await inspectCommitSignature(repoRoot, sourceCommit);
  return {
    sourceCommit,
    gitTree,
    branch,
    signedTag,
    sourceCommitSignature,
    status: {
      command: "git status --porcelain=v1 --untracked-files=all",
      clean: statusRaw === "",
      porcelainV1: statusRaw,
      sha256: sha256(statusRaw),
    },
  };
}

async function inspectSignedTag(repoRoot, requestedTag, sourceCommit) {
  if (typeof requestedTag !== "string" || requestedTag.trim() === "") {
    return { name: null, tagObject: null, targetCommit: null, payloadSha256: null, verified: false };
  }
  const name = requestedTag.trim();
  try {
    if (name.startsWith("-") || name.includes("..") || name.includes("@{")) throw new Error("invalid tag name");
    await runGit(repoRoot, ["check-ref-format", `refs/tags/${name}`]);
    const objectType = await runGitText(repoRoot, ["cat-file", "-t", name]);
    const tagObject = await runGitText(repoRoot, ["rev-parse", `${name}^{tag}`]);
    const targetCommit = await runGitText(repoRoot, ["rev-list", "-n", "1", name]);
    const payload = await runGit(repoRoot, ["cat-file", "tag", name]);
    let signatureVerified = false;
    try {
      await runGit(repoRoot, ["verify-tag", "--raw", name]);
      signatureVerified = true;
    } catch {
      signatureVerified = false;
    }
    return {
      name,
      tagObject: objectType === "tag" ? tagObject : null,
      targetCommit,
      payloadSha256: objectType === "tag" ? sha256(payload) : null,
      verified: objectType === "tag" && targetCommit === sourceCommit && signatureVerified,
    };
  } catch {
    return { name, tagObject: null, targetCommit: null, payloadSha256: null, verified: false };
  }
}

async function inspectCommitSignature(repoRoot, sourceCommit) {
  try {
    await runGit(repoRoot, ["verify-commit", "--raw", sourceCommit]);
    return { verified: true };
  } catch {
    return { verified: false };
  }
}

function validateRepositoryIdentity(identity, requestedTag, findings) {
  if (!/^[a-f0-9]{40,64}$/.test(identity.sourceCommit)) {
    addFinding(findings, "SOURCE_COMMIT_INVALID", "HEAD did not resolve to a Git object ID");
  }
  if (!identity.branch) addFinding(findings, "BRANCH_DETACHED", "candidate capture requires a named branch");
  if (!requestedTag) {
    addFinding(findings, "SIGNED_TAG_REQUIRED", "an explicitly selected signed annotated tag is required");
  } else if (!identity.signedTag.verified) {
    addFinding(findings, "SIGNED_TAG_UNVERIFIED", "tag must be annotated, cryptographically verified, and target sourceCommit");
  }
}

async function collectKnowledgeClosure(repoRoot, options, findings) {
  let report;
  try {
    report = await auditKnowledgeVault({
      vaultRoot: path.join(repoRoot, "knowledge-vault"),
      storageRoot: path.join(repoRoot, "storage"),
      ...options,
    });
  } catch (error) {
    addFinding(findings, "KNOWLEDGE_CLOSURE_CAPTURE_FAILED", `knowledge closure capture failed (${errorCode(error)})`);
    return emptyKnowledgeClosure();
  }
  if (!report.passed) {
    addFinding(findings, "KNOWLEDGE_CLOSURE_INVALID", `knowledge-vault audit reported ${report.errors.length} error(s)`);
  }
  const referencedAssets = new Map();
  for (const asset of report.assetClosure?.referencedAssets ?? []) {
    referencedAssets.set(asset.path, {
      path: asset.path,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      symbolicLink: asset.symbolicLink,
      references: asset.references,
    });
  }
  const referencedList = [...referencedAssets.values()].sort((left, right) => compareStrings(left.path, right.path));
  return {
    referencedAssets,
    manifestValue: {
      policy: "raw assets remain under storage; only explicit knowledge-vault references enter the external closure",
      auditPassed: report.passed,
      referencedAssetCount: referencedList.length,
      referencedBytes: referencedList.reduce((sum, entry) => sum + entry.byteSize, 0),
      referencedAssets: referencedList,
      unreferencedStorage: report.assetClosure?.unreferencedStorage ?? {
        totalFiles: 0,
        totalBytes: 0,
        unreferencedFiles: 0,
        unreferencedBytes: 0,
        byTopLevel: [],
      },
    },
  };
}

function emptyKnowledgeClosure() {
  return {
    referencedAssets: new Map(),
    manifestValue: {
      policy: "raw assets remain under storage; only explicit knowledge-vault references enter the external closure",
      auditPassed: false,
      referencedAssetCount: 0,
      referencedBytes: 0,
      referencedAssets: [],
      unreferencedStorage: {
        totalFiles: 0,
        totalBytes: 0,
        unreferencedFiles: 0,
        unreferencedBytes: 0,
        byTopLevel: [],
      },
    },
  };
}

async function collectRepositorySnapshot({ repoRoot, referencedStorageAssets, findings }) {
  const [stageBuffer, untrackedBuffer, ignoredBuffer] = await Promise.all([
    runGit(repoRoot, ["ls-files", "--stage", "-z"]),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    runGit(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
  ]);
  const tracked = parseStageEntries(stageBuffer);
  const untracked = decodeNulPaths(untrackedBuffer);
  const ignored = decodeNulPaths(ignoredBuffer);
  const pathOwners = new Map();
  const seeds = [];

  for (const entry of tracked) {
    if (entry.stage !== "0") addFinding(findings, "UNMERGED_INDEX_ENTRY", `index stage ${entry.stage} is not a candidate`, entry.path);
    addInventorySeed(seeds, pathOwners, {
      path: entry.path,
      repositoryState: "tracked",
      gitMode: entry.mode,
      gitBlobId: entry.objectId,
    }, findings);
  }
  for (const candidatePath of untracked) {
    addInventorySeed(seeds, pathOwners, {
      path: candidatePath,
      repositoryState: "untracked",
      gitMode: null,
      gitBlobId: null,
    }, findings);
  }
  for (const candidatePath of ignored) {
    addInventorySeed(seeds, pathOwners, {
      path: candidatePath,
      repositoryState: "ignored",
      gitMode: null,
      gitBlobId: null,
    }, findings);
  }

  seeds.sort((left, right) => compareStrings(left.path, right.path));
  const entries = await mapConcurrent(seeds, 24, async (seed) => {
    const classification = classifyInventorySeed(seed, referencedStorageAssets);
    return inspectInventorySeed(repoRoot, seed, classification, referencedStorageAssets, findings);
  });
  return { entries };
}

function addInventorySeed(seeds, pathOwners, seed, findings) {
  validateRepositoryPath(seed.path);
  if (pathOwners.has(seed.path)) {
    addFinding(findings, "INVENTORY_PATH_DUPLICATE", `path appears as both ${pathOwners.get(seed.path)} and ${seed.repositoryState}`, seed.path);
    return;
  }
  pathOwners.set(seed.path, seed.repositoryState);
  seeds.push(seed);
}

function classifyInventorySeed(seed, referencedStorageAssets) {
  const candidatePath = seed.path;
  const secret = isSecretPath(candidatePath);
  if (secret) return { disposition: "blocked", reasonCode: "secretMaterial", inspectContent: false };

  if (candidatePath === "storage" || candidatePath.startsWith("storage/")) {
    if (referencedStorageAssets.has(candidatePath)) {
      return { disposition: "external", reasonCode: "referencedKnowledgeStorageAsset", inspectContent: false };
    }
    return { disposition: "excluded", reasonCode: "unreferencedStorageAsset", inspectContent: false };
  }

  if (candidatePath.startsWith("knowledge-vault/")
    && !candidatePath.endsWith(".md")
    && !REQUIRED_KNOWLEDGE_VAULT_CONFIG.includes(candidatePath)) {
    return {
      disposition: seed.repositoryState === "tracked" ? "blocked" : "excluded",
      reasonCode: "knowledgeVaultNonMarkdown",
      inspectContent: false,
    };
  }

  const exclusion = EXCLUDED_PATH_RULES.find((rule) => rule.test(candidatePath));
  if (exclusion) {
    return {
      disposition: seed.repositoryState === "tracked" ? "blocked" : "excluded",
      reasonCode: seed.repositoryState === "tracked" ? "trackedExcludedArtifact" : exclusion.reasonCode,
      inspectContent: false,
    };
  }

  if (seed.repositoryState === "tracked") {
    return { disposition: "included", reasonCode: "trackedCandidateFile", inspectContent: true };
  }
  if (seed.repositoryState === "untracked") {
    return { disposition: "blocked", reasonCode: "untrackedCandidateFile", inspectContent: true };
  }
  if (isCriticalCandidatePath(candidatePath)) {
    return { disposition: "blocked", reasonCode: "ignoredCriticalFile", inspectContent: true };
  }
  return { disposition: "excluded", reasonCode: "ignoredNonCriticalFile", inspectContent: false };
}

async function inspectInventorySeed(repoRoot, seed, classification, referencedStorageAssets, findings) {
  const base = {
    path: seed.path,
    repositoryState: seed.repositoryState,
    disposition: classification.disposition,
    reasonCode: classification.reasonCode,
    fileType: "notInspected",
    byteSize: null,
    sha256: null,
    gitMode: seed.gitMode,
    gitBlobId: seed.gitBlobId,
  };

  if (classification.reasonCode === "secretMaterial") {
    addFinding(findings, "SECRET_MATERIAL_PRESENT", "secret-like path is forbidden; content was not read", seed.path);
    return base;
  }
  if (classification.reasonCode === "trackedExcludedArtifact") {
    addFinding(findings, "TRACKED_EXCLUDED_ARTIFACT", "cache/generated output is tracked", seed.path);
  }
  if (classification.reasonCode === "knowledgeVaultNonMarkdown" && seed.repositoryState === "tracked") {
    addFinding(findings, "TRACKED_KNOWLEDGE_BINARY", "move the asset to storage and reference it from a Markdown index", seed.path);
  }
  if (classification.reasonCode === "untrackedCandidateFile") {
    addFinding(findings, isCriticalCandidatePath(seed.path) ? "UNTRACKED_CRITICAL_FILE" : "UNTRACKED_UNCLASSIFIED_FILE", "untracked content must be committed or covered by an explicit exclusion", seed.path);
  }
  if (classification.reasonCode === "ignoredCriticalFile") {
    addFinding(findings, "IGNORED_CRITICAL_FILE", "runtime-critical ignored content must be tracked", seed.path);
  }

  if (classification.reasonCode === "referencedKnowledgeStorageAsset") {
    const reference = referencedStorageAssets.get(seed.path);
    if (seed.repositoryState !== "ignored") {
      addFinding(findings, "REFERENCED_STORAGE_NOT_IGNORED", "referenced raw storage must remain outside Git", seed.path);
    }
    return {
      ...base,
      fileType: reference.symbolicLink ? "symbolicLink" : "file",
      byteSize: reference.byteSize,
      sha256: reference.sha256,
    };
  }

  if (!classification.inspectContent) return base;

  const absolutePath = path.join(repoRoot, ...seed.path.split("/"));
  try {
    const info = await lstat(absolutePath, { bigint: true });
    if (info.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      return {
        ...base,
        fileType: "symbolicLink",
        byteSize: Buffer.byteLength(target),
        sha256: sha256(target),
      };
    }
    if (seed.gitMode === "160000") {
      return {
        ...base,
        fileType: "gitlink",
        byteSize: null,
        sha256: sha256(seed.gitBlobId ?? ""),
      };
    }
    if (!info.isFile()) {
      addFinding(findings, "SPECIAL_FILE_FORBIDDEN", "candidate entries must be regular files, symlinks, or Git links", seed.path);
      return { ...base, fileType: "other" };
    }
    const digest = await sha256FileStable(absolutePath, info);
    return {
      ...base,
      fileType: "file",
      byteSize: Number(info.size),
      sha256: digest,
    };
  } catch (error) {
    addFinding(findings, "INVENTORY_FILE_UNREADABLE", `file inspection failed (${errorCode(error)})`, seed.path);
    return { ...base, fileType: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

function validateInventory(entries, findings) {
  for (const entry of entries) {
    if (entry.disposition === "included" && !SHA256_PATTERN.test(entry.sha256 ?? "")) {
      addFinding(findings, "INCLUDED_FILE_DIGEST_MISSING", "included file must have a SHA-256 digest", entry.path);
    }
    if (entry.repositoryState === "tracked" && entry.disposition !== "included" && entry.reasonCode !== "referencedKnowledgeStorageAsset") {
      addFinding(findings, "TRACKED_FILE_NOT_INCLUDED", `tracked path has disposition ${entry.disposition}`, entry.path);
    }
  }
}

function createInventoryArtifact(entries) {
  const lines = entries.map((entry) => canonicalJson(entry));
  const ndjson = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const byRepositoryState = summarizeInventory(entries, "repositoryState", ["tracked", "untracked", "ignored"]);
  const byDisposition = summarizeInventory(entries, "disposition", ["included", "blocked", "excluded", "external"]);
  return {
    ndjson,
    sha256: sha256(ndjson),
    byRepositoryState,
    byDisposition,
  };
}

function summarizeInventory(entries, field, requiredValues = []) {
  const values = [...new Set([...requiredValues, ...entries.map((entry) => entry[field])])].sort(compareStrings);
  return Object.fromEntries(values.map((value) => {
    const selected = entries.filter((entry) => entry[field] === value);
    const ndjson = selected.length > 0 ? `${selected.map((entry) => canonicalJson(entry)).join("\n")}\n` : "";
    return [value, { entryCount: selected.length, sha256: sha256(ndjson) }];
  }));
}

function buildSourceScopes(entries, findings) {
  return REQUIRED_SOURCE_SCOPES.map((scope) => {
    const selected = entries.filter((entry) => scopeMatches(scope, entry.path));
    const included = selected.filter((entry) => entry.disposition === "included");
    const blocked = selected.filter((entry) => entry.disposition === "blocked");
    const missingExactPaths = (scope.exactPaths ?? []).filter((requiredPath) => !included.some((entry) => entry.path === requiredPath));
    if (included.length === 0) {
      addFinding(findings, "REQUIRED_SOURCE_SCOPE_MISSING", `required source scope ${scope.name} has no tracked candidate files`);
    }
    for (const requiredPath of missingExactPaths) {
      addFinding(findings, "REQUIRED_SOURCE_FILE_MISSING", `required tracked source file is missing from ${scope.name}`, requiredPath);
    }
    return {
      name: scope.name,
      roots: scope.roots,
      exactPaths: scope.exactPaths ?? [],
      entryCount: included.length,
      blockedEntryCount: blocked.length,
      sha256: digestEntrySet(included),
      status: included.length > 0 && blocked.length === 0 && missingExactPaths.length === 0 ? "complete" : "blocked",
    };
  });
}

function buildCriticalArtifactGroups({ entries, expectedMigrationCount, findings }) {
  return Object.fromEntries(CRITICAL_GROUP_DEFINITIONS.map((definition) => {
    const selected = entries.filter((entry) => groupMatches(definition, entry.path));
    const included = selected.filter((entry) => entry.disposition === "included");
    const blocked = selected.filter((entry) => entry.disposition === "blocked");
    const missingExactPaths = (definition.exactPaths ?? []).filter((requiredPath) => !included.some((entry) => entry.path === requiredPath));
    for (const requiredPath of missingExactPaths) {
      addFinding(findings, "CRITICAL_ARTIFACT_MISSING", `${definition.name} requires a tracked file`, requiredPath);
    }
    if ((definition.roots?.length ?? 0) > 0 && included.length === 0) {
      addFinding(findings, "CRITICAL_ARTIFACT_GROUP_EMPTY", `${definition.name} has no tracked candidate entries`);
    }
    if (definition.name === "migrations" && expectedMigrationCount !== null && included.length !== expectedMigrationCount) {
      addFinding(findings, "MIGRATION_COUNT_MISMATCH", `expected ${expectedMigrationCount} tracked migrations, found ${included.length}`);
    }
    const value = {
      entryCount: included.length,
      blockedEntryCount: blocked.length,
      sha256: digestEntrySet(included),
      status: missingExactPaths.length === 0
        && blocked.length === 0
        && included.length > 0
        && (definition.name !== "migrations" || expectedMigrationCount === included.length)
        ? "complete"
        : "blocked",
    };
    if (definition.includeEntries) {
      value.entries = included.map(compactDigestEntry);
    }
    return [definition.name, value];
  }));
}

function validateKnowledgeStorageInventory({ entries, knowledgeClosure, findings }) {
  const inventoryPaths = new Set(entries.map((entry) => entry.path));
  for (const referencedPath of knowledgeClosure.referencedAssets.keys()) {
    if (!inventoryPaths.has(referencedPath)) {
      addFinding(findings, "REFERENCED_STORAGE_NOT_IN_INVENTORY", "knowledge-vault referenced storage asset was not reported by Git ignored inventory", referencedPath);
    }
  }
}

function validateCaptureConsistency(before, after, findings) {
  const checks = [
    ["sourceCommit", before.sourceCommit, after.sourceCommit],
    ["gitTree", before.gitTree, after.gitTree],
    ["branch", before.branch, after.branch],
    ["status", before.status.sha256, after.status.sha256],
  ];
  for (const [field, beforeValue, afterValue] of checks) {
    if (beforeValue !== afterValue) {
      addFinding(findings, "REPOSITORY_CHANGED_DURING_CAPTURE", `${field} changed while inventory was being captured`);
    }
  }
}

function scopeMatches(scope, candidatePath) {
  if ((scope.exactPaths ?? []).includes(candidatePath)) return true;
  if (scope.markdownOnly && !candidatePath.endsWith(".md")) return false;
  return (scope.roots ?? []).some((root) => pathMatchesRoot(candidatePath, root));
}

function groupMatches(group, candidatePath) {
  if ((group.exactPaths ?? []).includes(candidatePath)) return true;
  if (!(group.roots ?? []).some((root) => pathMatchesRoot(candidatePath, root))) return false;
  return group.predicate ? group.predicate(candidatePath) : true;
}

function isCriticalCandidatePath(candidatePath) {
  if (REQUIRED_GENERATED_CONTRACTS.includes(candidatePath) || REQUIRED_HARD_CUT_FILES.includes(candidatePath)) return true;
  if (candidatePath === "packages/workbench-db/prisma/schema.prisma") return true;
  if (candidatePath.startsWith("packages/workbench-db/prisma/migrations/") && candidatePath.endsWith("/migration.sql")) return true;
  return REQUIRED_SOURCE_SCOPES.some((scope) => scopeMatches(scope, candidatePath));
}

function pathMatchesRoot(candidatePath, root) {
  if (root.endsWith("-")) return candidatePath.startsWith(root);
  return candidatePath.startsWith(root);
}

function isSecretPath(candidatePath) {
  if (/(?:^|\/)\.env(?:\..+)?$/i.test(candidatePath)) {
    return !/(?:\.example|\.sample|\.template)$/i.test(candidatePath);
  }
  const basename = path.posix.basename(candidatePath);
  if (/(?:\.example|\.sample|\.template)(?:\.[^.]+)?$/i.test(basename)) return false;
  return SECRET_EXTENSIONS.has(path.posix.extname(basename).toLowerCase())
    || SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

function hasSegment(candidatePath, segment) {
  return candidatePath.split("/").includes(segment);
}

function parseStageEntries(buffer) {
  return decodeNulRecords(buffer).map((record) => {
    const separator = record.indexOf(0x09);
    if (separator < 0) throw new Error("git ls-files --stage returned an invalid record");
    const header = record.subarray(0, separator).toString("ascii");
    const match = header.match(/^(\d{6}) ([a-f0-9]{40,64}) ([0-3])$/);
    if (!match) throw new Error(`git ls-files --stage returned invalid metadata: ${header}`);
    return {
      mode: match[1],
      objectId: match[2],
      stage: match[3],
      path: decodeGitPath(record.subarray(separator + 1)),
    };
  });
}

function decodeNulPaths(buffer) {
  return decodeNulRecords(buffer).map(decodeGitPath);
}

function decodeNulRecords(buffer) {
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0) throw new Error("NUL-delimited Git output was not terminated");
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function decodeGitPath(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("repository contains a path that is not valid UTF-8");
  }
}

function validateRepositoryPath(candidatePath) {
  if (candidatePath === "" || path.posix.isAbsolute(candidatePath) || candidatePath.includes("\\") || candidatePath.includes("\0")) {
    throw new Error(`invalid repository path: ${JSON.stringify(candidatePath)}`);
  }
  const normalized = path.posix.normalize(candidatePath);
  if (normalized !== candidatePath || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`repository path escapes root: ${JSON.stringify(candidatePath)}`);
  }
}

async function sha256FileStable(filePath, beforeInfo) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const afterInfo = await stat(filePath, { bigint: true });
  if (beforeInfo.size !== afterInfo.size
    || beforeInfo.mtimeNs !== afterInfo.mtimeNs
    || beforeInfo.ino !== afterInfo.ino) {
    throw new Error("file changed while SHA-256 was being calculated");
  }
  return digest.digest("hex");
}

function digestEntrySet(entries) {
  return sha256(canonicalJson(entries.map(compactDigestEntry)));
}

function compactDigestEntry(entry) {
  return {
    path: entry.path,
    fileType: entry.fileType,
    byteSize: entry.byteSize,
    sha256: entry.sha256,
    gitMode: entry.gitMode,
    gitBlobId: entry.gitBlobId,
  };
}

export function canonicalJson(value) {
  return serializeCanonical(value, new Set());
}

function serializeCanonical(value, ancestors) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("canonical JSON does not support cyclic values");
    ancestors.add(value);
    const serialized = `[${value.map((item) => serializeCanonical(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }
  if (!isPlainObject(value)) throw new TypeError(`canonical JSON does not support ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("canonical JSON does not support cyclic values");
  ancestors.add(value);
  const serialized = `{${Object.keys(value).sort(compareStrings).map((key) => {
    const child = value[key];
    if (child === undefined) throw new TypeError(`canonical JSON does not support undefined at ${key}`);
    return `${JSON.stringify(key)}:${serializeCanonical(child, ancestors)}`;
  }).join(",")}}`;
  ancestors.delete(value);
  return serialized;
}

function validateUtcTimestamp(value, label, findings) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    addFinding(findings, "AUDIT_METADATA_INVALID", `${label} must be an explicitly injected UTC ISO-8601 timestamp`);
    return null;
  }
  return value;
}

function validateNonEmptyString(value, label, findings) {
  if (typeof value !== "string" || value.trim() === "") {
    addFinding(findings, "AUDIT_METADATA_INVALID", `${label} must be explicitly injected`);
    return null;
  }
  return value.trim();
}

function validateArtifactName(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("/") || value.includes("\\")) {
    throw new Error("inventoryArtifactName must be a plain file name");
  }
  return value;
}

function addFinding(findings, code, detail, findingPath = null) {
  findings.push({ code, path: findingPath, detail });
}

function sortAndDedupeFindings(findings) {
  const keyed = new Map();
  for (const finding of findings) keyed.set(canonicalJson(finding), finding);
  return [...keyed.values()].sort((left, right) => compareStrings(left.code, right.code)
    || compareStrings(left.path ?? "", right.path ?? "")
    || compareStrings(left.detail, right.detail));
}

async function mapConcurrent(values, concurrency, mapper) {
  const result = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

async function runGit(repoRoot, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "buffer",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      LANG: "C",
    },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function runGitText(repoRoot, args) {
  return (await runGit(repoRoot, args)).toString("utf8").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function errorCode(error) {
  return typeof error?.code === "string" && error.code ? error.code : "UNKNOWN";
}
