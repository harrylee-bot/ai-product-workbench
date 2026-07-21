#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const REPRODUCIBILITY_SCHEMA_VERSION = "workbench.reproducibility-receipt.v1";
export const REDACTED_OUTPUT_SCHEMA_VERSION = "workbench.command-output-redaction.v1";

const scriptPath = fileURLToPath(import.meta.url);
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const COMMAND_OUTPUT_LIMIT = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const SAFE_ARTIFACT_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SECRET_OUTPUT_PATTERNS = Object.freeze([
  {
    id: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu,
  },
  {
    id: "bearer-credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/iu,
  },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  },
  {
    id: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  },
  {
    id: "api-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    id: "assigned-secret",
    pattern: /\b(?:api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|secret|token)\b\s*[:=]\s*["']?(?!\$\{|\$[A-Z_]|<redacted>|\[redacted\]|redacted\b|none\b|null\b)[A-Za-z0-9._~+/-]{8,}/iu,
  },
]);
const GENERATED_PATH_RULES = Object.freeze([
  {
    id: "dependencies",
    description: "a node_modules path segment",
    test: (candidate) => hasSegment(candidate, "node_modules"),
  },
  {
    id: "compiled-output",
    description: "apps/<workspace>/dist or packages/<workspace>/dist",
    test: (candidate) => /^(?:apps|packages)\/[^/]+\/dist(?:\/|$)/u.test(candidate),
  },
  {
    id: "next-output",
    description: "apps/web/.next",
    test: (candidate) => candidate === "apps/web/.next" || candidate.startsWith("apps/web/.next/"),
  },
  {
    id: "coverage-output",
    description: "root coverage or a workspace coverage directory",
    test: (candidate) => candidate === "coverage" || /^(?:apps|packages)\/[^/]+\/coverage(?:\/|$)/u.test(candidate),
  },
  {
    id: "prisma-client",
    description: "packages/workbench-db/generated",
    test: (candidate) => candidate === "packages/workbench-db/generated"
      || candidate.startsWith("packages/workbench-db/generated/"),
  },
  {
    id: "figma-build",
    description: "apps/workbench-figma-importer/build",
    test: (candidate) => candidate === "apps/workbench-figma-importer/build"
      || candidate.startsWith("apps/workbench-figma-importer/build/"),
  },
  {
    id: "typescript-build-info",
    description: "files ending in .tsbuildinfo",
    test: (candidate) => candidate.endsWith(".tsbuildinfo"),
  },
  {
    id: "python-cache",
    description: "a __pycache__ path segment or files ending in .pyc",
    test: (candidate) => hasSegment(candidate, "__pycache__") || candidate.endsWith(".pyc"),
  },
  {
    id: "turbo-cache",
    description: "a .turbo path segment",
    test: (candidate) => hasSegment(candidate, ".turbo"),
  },
  {
    id: "vercel-cache",
    description: "a .vercel path segment",
    test: (candidate) => hasSegment(candidate, ".vercel"),
  },
]);

export class ReproducibilityVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReproducibilityVerificationError";
    this.code = code;
    this.details = details;
  }
}

export async function verifyWorkbenchReproducibility({
  repoRoot,
  commit,
  tag,
  checks = {},
  commandRunner = createCommandRunner(),
  now = () => new Date().toISOString(),
  processNodeVersion = process.version,
  tempParent = os.tmpdir(),
  platform = process.platform,
  architecture = process.arch,
  evidenceDirectoryName = "receipt.json.evidence",
} = {}) {
  const startedAtUtc = utcNow(now);
  const commands = [];
  const evidenceArtifacts = [];
  const generationRounds = [];
  const sourceAudits = [];
  const checkResults = [];
  const requestedCommit = normalizeCommit(commit);
  const requestedTag = normalizeTag(tag);
  const selectedChecks = normalizeChecks(checks);
  const normalizedEvidenceDirectory = normalizeEvidenceDirectoryName(evidenceDirectoryName);
  const binding = {
    requestedCommit,
    sourceCommit: null,
    sourceTree: null,
    cloneCommit: null,
    cloneTree: null,
    tag: {
      name: requestedTag,
      objectId: null,
      peeledCommit: null,
      payloadSha256: null,
      verified: false,
    },
  };
  const tools = {
    git: null,
    node: {
      commandVersion: null,
      processVersion: processNodeVersion,
      major: null,
    },
    npm: null,
  };
  const isolation = {
    cloneMode: "git clone --no-hardlinks --no-checkout",
    checkoutMode: "detached",
    cleanupStatus: "NOT_RUN",
    initialClean: false,
  };
  let sourceRoot = null;
  let temporaryRoot = null;
  let cloneRoot = null;
  let failure = null;

  const recorder = createRecorder({
    commandRunner,
    commands,
    evidenceArtifacts,
    evidenceDirectoryName: normalizedEvidenceDirectory,
    roots: () => ({ sourceRoot, temporaryRoot, cloneRoot }),
  });

  try {
    sourceRoot = await resolveRepositoryRoot(repoRoot, recorder);
    await collectSourceBinding({
      recorder,
      sourceRoot,
      requestedCommit,
      requestedTag,
      binding,
    });
    await collectAndValidateToolVersions({ recorder, sourceRoot, tools, processNodeVersion });

    temporaryRoot = await mkdtemp(path.join(path.resolve(tempParent), "workbench-reproducibility-"));
    cloneRoot = path.join(temporaryRoot, "checkout");
    await recorder.run({
      id: "clone.create",
      executable: "git",
      args: ["clone", "--no-hardlinks", "--no-checkout", "--quiet", "--", sourceRoot, cloneRoot],
      cwd: sourceRoot,
      scope: "source",
    });
    await recorder.run({
      id: "clone.checkout",
      executable: "git",
      args: ["checkout", "--detach", "--quiet", requestedCommit],
      cwd: cloneRoot,
      scope: "clone",
    });
    await validateCloneBinding({ recorder, cloneRoot, binding, requestedTag });

    const initialStatus = await recorder.run({
      id: "clone.initial-status",
      executable: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
      cwd: cloneRoot,
      scope: "clone",
    });
    if (initialStatus.stdout.length !== 0) {
      throw new ReproducibilityVerificationError(
        "CLONE_NOT_CLEAN",
        "isolated checkout is not clean before dependency installation",
        { statusSha256: sha256(initialStatus.stdout), byteSize: initialStatus.stdout.length },
      );
    }
    isolation.initialClean = true;

    await recorder.run({
      id: "install.npm-ci",
      executable: "npm",
      args: ["ci", "--no-audit", "--no-fund"],
      cwd: cloneRoot,
      scope: "clone",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    sourceAudits.push(await auditSourceChanges({ recorder, cloneRoot, phase: "post-install" }));

    for (let round = 1; round <= 2; round += 1) {
      const generationResult = {
        round,
        status: "FAIL",
        sourceAuditSha256: null,
      };
      generationRounds.push(generationResult);
      await recorder.run({
        id: `generation.${round}.prepare`,
        executable: "npm",
        args: ["run", "workbench:prepare"],
        cwd: cloneRoot,
        scope: "clone",
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      await recorder.run({
        id: `generation.${round}.brand-assets`,
        executable: "npm",
        args: ["run", "brand:assets"],
        cwd: cloneRoot,
        scope: "clone",
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      const audit = await auditSourceChanges({ recorder, cloneRoot, phase: `generation-round-${round}` });
      sourceAudits.push(audit);
      generationResult.status = "PASS";
      generationResult.sourceAuditSha256 = sha256(canonicalJson(audit));
    }

    await runDefaultChecks({
      recorder,
      cloneRoot,
      selectedChecks,
      checkResults,
    });
    sourceAudits.push(await auditSourceChanges({ recorder, cloneRoot, phase: "post-checks" }));
  } catch (error) {
    failure = normalizeFailure(error);
  } finally {
    if (temporaryRoot) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
        isolation.cleanupStatus = "PASS";
      } catch (error) {
        isolation.cleanupStatus = "FAIL";
        failure ??= normalizeFailure(new ReproducibilityVerificationError(
          "ISOLATED_CHECKOUT_CLEANUP_FAILED",
          "failed to remove the isolated checkout",
          { causeCode: typeof error?.code === "string" ? error.code : null },
        ));
      }
    }
  }

  const skippedChecks = checkResults.filter((entry) => entry.status === "NOT_RUN").map((entry) => entry.id);
  const status = failure ? "FAIL" : skippedChecks.length ? "INCONCLUSIVE" : "PASS";
  const endedAtUtc = utcNow(now);
  const payload = {
    product: "产品工作台",
    technicalIdentifier: "workbench",
    gateId: "G2",
    status,
    startedAtUtc,
    endedAtUtc,
    binding,
    tools: {
      platform,
      architecture,
      ...tools,
    },
    isolation,
    evidenceDirectory: normalizedEvidenceDirectory,
    generatedPathExclusions: GENERATED_PATH_RULES.map(({ id, description }) => ({ id, description })),
    sourceAudits,
    generationRounds,
    checks: checkResults,
    commands,
    skippedChecks,
    failure,
  };
  const receipt = sealReceipt(payload);
  return {
    passed: status === "PASS",
    status,
    receipt,
    receiptJson: canonicalJsonFile(receipt),
    evidenceArtifacts,
  };
}

export function createCommandRunner({ maxBuffer = COMMAND_OUTPUT_LIMIT } = {}) {
  return ({ executable, args, cwd, env, timeoutMs = COMMAND_TIMEOUT_MS }) => new Promise((resolve) => {
    execFile(executable, args, {
      cwd,
      env: env ?? process.env,
      encoding: "buffer",
      maxBuffer,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const exitCode = error
        ? (Number.isInteger(error.code) ? error.code : null)
        : 0;
      resolve({
        exitCode,
        signal: typeof error?.signal === "string" ? error.signal : null,
        errorCode: typeof error?.code === "string" ? error.code : null,
        stdout: toBuffer(stdout),
        stderr: toBuffer(stderr),
      });
    });
  });
}

export function evidenceDirectoryNameForOutput(outputPath) {
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    throw new Error("outputPath is required");
  }
  const basename = path.basename(path.resolve(outputPath));
  if (!SAFE_ARTIFACT_BASENAME.test(basename)) {
    throw new Error("receipt basename must contain only safe ASCII filename characters");
  }
  return `${basename}.evidence`;
}

export async function writeReproducibilityReceipt(outputPath, receipt, evidenceArtifacts) {
  const evidenceDirectoryName = evidenceDirectoryNameForOutput(outputPath);
  validateReceiptSeal(receipt);
  if (receipt.payload.evidenceDirectory !== evidenceDirectoryName) {
    throw new Error("receipt evidenceDirectory does not match --output basename");
  }
  const absoluteOutput = path.resolve(outputPath);
  const sidecarPath = `${absoluteOutput}.sha256`;
  const evidenceDirectoryPath = path.join(path.dirname(absoluteOutput), evidenceDirectoryName);
  if (
    await pathExists(absoluteOutput)
    || await pathExists(sidecarPath)
    || await pathExists(evidenceDirectoryPath)
  ) {
    throw new Error("refusing to overwrite an existing receipt, sidecar, or evidence directory");
  }
  const validatedArtifacts = validateEvidenceArtifacts({
    receipt,
    evidenceArtifacts,
    evidenceDirectoryName,
  });
  const outputDirectory = path.dirname(absoluteOutput);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const receiptBytes = Buffer.from(canonicalJsonFile(receipt), "utf8");
  const receiptSha256 = sha256(receiptBytes);
  const sidecarBytes = Buffer.from(`${receiptSha256}  ${path.basename(absoluteOutput)}\n`, "utf8");
  const stagingRoot = await mkdtemp(path.join(outputDirectory, `.${path.basename(absoluteOutput)}.package-`));
  const stagingReceipt = path.join(stagingRoot, "receipt.json");
  const stagingSidecar = path.join(stagingRoot, "receipt.sha256");
  const stagingEvidence = path.join(stagingRoot, evidenceDirectoryName);
  let createdEvidenceDirectory = false;
  let createdReceipt = false;
  let createdSidecar = false;
  try {
    await writeFile(stagingReceipt, receiptBytes, { flag: "wx", mode: 0o600 });
    await writeFile(stagingSidecar, sidecarBytes, { flag: "wx", mode: 0o600 });
    await mkdir(path.join(stagingEvidence, "commands"), { recursive: true, mode: 0o700 });
    for (const artifact of validatedArtifacts) {
      const relativeInsideEvidence = artifact.relativePath.slice(evidenceDirectoryName.length + 1);
      const stagingPath = safeArtifactPath(stagingEvidence, relativeInsideEvidence);
      await mkdir(path.dirname(stagingPath), { recursive: true, mode: 0o700 });
      await writeFile(stagingPath, artifact.bytes, { flag: "wx", mode: 0o600 });
    }

    await mkdir(evidenceDirectoryPath, { mode: 0o700 });
    createdEvidenceDirectory = true;
    await rename(path.join(stagingEvidence, "commands"), path.join(evidenceDirectoryPath, "commands"));
    await link(stagingReceipt, absoluteOutput);
    createdReceipt = true;
    await link(stagingSidecar, sidecarPath);
    createdSidecar = true;
  } catch (error) {
    if (createdSidecar) await rm(sidecarPath, { force: true });
    if (createdReceipt) await rm(absoluteOutput, { force: true });
    if (createdEvidenceDirectory) await rm(evidenceDirectoryPath, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  return {
    outputPath: absoluteOutput,
    sidecarPath,
    evidenceDirectoryPath,
    evidenceArtifactCount: validatedArtifacts.length,
    receiptSha256,
  };
}

export function parseCliArguments(argv) {
  const options = {
    repoRoot: process.cwd(),
    commit: null,
    tag: null,
    output: null,
    checks: {},
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--repo") options.repoRoot = requiredValue(argv, ++index, argument);
    else if (argument === "--commit") options.commit = requiredValue(argv, ++index, argument);
    else if (argument === "--tag") options.tag = requiredValue(argv, ++index, argument);
    else if (argument === "--output") options.output = requiredValue(argv, ++index, argument);
    else if (argument === "--skip-openapi-check") options.checks.openapi = false;
    else if (argument === "--skip-runtime-schema-check") options.checks.runtimeSchema = false;
    else if (argument === "--skip-runtime-validator-check") options.checks.runtimeValidator = false;
    else if (argument === "--skip-typecheck") options.checks.typecheck = false;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.help) {
    if (!options.commit) throw new Error("--commit is required");
    if (!options.tag) throw new Error("--tag is required");
    if (!options.output) throw new Error("--output is required");
  }
  return options;
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonical(value));
}

export function canonicalJsonFile(value) {
  return `${canonicalJson(value)}\n`;
}

export function sealReceipt(payload) {
  const sealed = {
    schemaVersion: REPRODUCIBILITY_SCHEMA_VERSION,
    payload: normalizeCanonical(payload),
  };
  return {
    ...sealed,
    payloadSha256: sha256(canonicalJson(sealed)),
  };
}

async function resolveRepositoryRoot(repoRoot, recorder) {
  if (typeof repoRoot !== "string" || !repoRoot.trim()) {
    throw new ReproducibilityVerificationError("REPOSITORY_REQUIRED", "repoRoot is required");
  }
  let requested;
  try {
    requested = await realpath(path.resolve(repoRoot));
  } catch (error) {
    throw new ReproducibilityVerificationError(
      "REPOSITORY_UNAVAILABLE",
      "repoRoot cannot be resolved",
      { causeCode: typeof error?.code === "string" ? error.code : null },
    );
  }
  const result = await recorder.run({
    id: "source.repository-root",
    executable: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: requested,
    scope: "source",
  });
  const topLevel = await realpath(singleLine(result.stdout, "Git top-level path"));
  if (topLevel !== requested) {
    throw new ReproducibilityVerificationError(
      "REPOSITORY_NOT_TOP_LEVEL",
      "repoRoot must be the Git top level",
    );
  }
  return requested;
}

async function collectSourceBinding({ recorder, sourceRoot, requestedCommit, requestedTag, binding }) {
  const commitResult = await recorder.run({
    id: "source.commit",
    executable: "git",
    args: ["rev-parse", "--verify", `${requestedCommit}^{commit}`],
    cwd: sourceRoot,
    scope: "source",
  });
  const resolvedCommit = normalizeObjectId(singleLine(commitResult.stdout, "source commit"), "SOURCE_COMMIT_INVALID");
  if (resolvedCommit !== requestedCommit) {
    throw new ReproducibilityVerificationError(
      "SOURCE_COMMIT_MISMATCH",
      "--commit did not resolve to the exact requested commit",
      { requestedCommit, resolvedCommit },
    );
  }
  binding.sourceCommit = resolvedCommit;

  const treeResult = await recorder.run({
    id: "source.tree",
    executable: "git",
    args: ["rev-parse", "--verify", `${resolvedCommit}^{tree}`],
    cwd: sourceRoot,
    scope: "source",
  });
  binding.sourceTree = normalizeObjectId(singleLine(treeResult.stdout, "source tree"), "SOURCE_TREE_INVALID");

  const tagRef = `refs/tags/${requestedTag}`;
  const tagObjectResult = await recorder.run({
    id: "source.tag-object",
    executable: "git",
    args: ["show-ref", "--verify", "--hash", tagRef],
    cwd: sourceRoot,
    scope: "source",
  });
  const tagObject = normalizeObjectId(singleLine(tagObjectResult.stdout, "tag object"), "TAG_OBJECT_INVALID");
  binding.tag.objectId = tagObject;

  const tagTypeResult = await recorder.run({
    id: "source.tag-type",
    executable: "git",
    args: ["cat-file", "-t", tagObject],
    cwd: sourceRoot,
    scope: "source",
  });
  if (singleLine(tagTypeResult.stdout, "tag object type") !== "tag") {
    throw new ReproducibilityVerificationError(
      "ANNOTATED_TAG_REQUIRED",
      "--tag must name an annotated tag object",
    );
  }

  await recorder.run({
    id: "source.tag-verify",
    executable: "git",
    args: ["verify-tag", "--raw", tagRef],
    cwd: sourceRoot,
    scope: "source",
  });

  const peeledResult = await recorder.run({
    id: "source.tag-peeled",
    executable: "git",
    args: ["rev-parse", "--verify", `${tagRef}^{commit}`],
    cwd: sourceRoot,
    scope: "source",
  });
  const peeledCommit = normalizeObjectId(singleLine(peeledResult.stdout, "tag peeled commit"), "TAG_COMMIT_INVALID");
  binding.tag.peeledCommit = peeledCommit;
  if (peeledCommit !== resolvedCommit) {
    throw new ReproducibilityVerificationError(
      "TAG_COMMIT_MISMATCH",
      "signed tag does not peel to --commit",
      { requestedCommit: resolvedCommit, peeledCommit },
    );
  }

  const tagPayload = await recorder.run({
    id: "source.tag-payload",
    executable: "git",
    args: ["cat-file", "tag", tagObject],
    cwd: sourceRoot,
    scope: "source",
  });
  binding.tag.payloadSha256 = sha256(tagPayload.stdout);
  binding.tag.verified = true;
}

async function collectAndValidateToolVersions({ recorder, sourceRoot, tools, processNodeVersion }) {
  const git = await recorder.run({
    id: "tool.git-version",
    executable: "git",
    args: ["--version"],
    cwd: sourceRoot,
    scope: "source",
  });
  const node = await recorder.run({
    id: "tool.node-version",
    executable: "node",
    args: ["--version"],
    cwd: sourceRoot,
    scope: "source",
  });
  const npm = await recorder.run({
    id: "tool.npm-version",
    executable: "npm",
    args: ["--version"],
    cwd: sourceRoot,
    scope: "source",
  });
  tools.git = singleLine(git.stdout, "Git version");
  tools.node.commandVersion = singleLine(node.stdout, "Node version");
  tools.npm = singleLine(npm.stdout, "npm version");
  const commandMajor = parseNodeMajor(tools.node.commandVersion);
  const processMajor = parseNodeMajor(processNodeVersion);
  tools.node.major = commandMajor;
  if (commandMajor !== 22 || processMajor !== 22) {
    throw new ReproducibilityVerificationError(
      "NODE_VERSION_UNSUPPORTED",
      "fresh-clone verification requires Node major 22 for both the verifier and PATH",
      { commandMajor, processMajor },
    );
  }
}

async function validateCloneBinding({ recorder, cloneRoot, binding, requestedTag }) {
  const commitResult = await recorder.run({
    id: "clone.commit",
    executable: "git",
    args: ["rev-parse", "--verify", "HEAD^{commit}"],
    cwd: cloneRoot,
    scope: "clone",
  });
  binding.cloneCommit = normalizeObjectId(singleLine(commitResult.stdout, "clone commit"), "CLONE_COMMIT_INVALID");
  const treeResult = await recorder.run({
    id: "clone.tree",
    executable: "git",
    args: ["rev-parse", "--verify", "HEAD^{tree}"],
    cwd: cloneRoot,
    scope: "clone",
  });
  binding.cloneTree = normalizeObjectId(singleLine(treeResult.stdout, "clone tree"), "CLONE_TREE_INVALID");
  if (binding.cloneCommit !== binding.sourceCommit || binding.cloneTree !== binding.sourceTree) {
    throw new ReproducibilityVerificationError(
      "CLONE_BINDING_MISMATCH",
      "isolated checkout commit/tree differs from the source binding",
      {
        sourceCommit: binding.sourceCommit,
        cloneCommit: binding.cloneCommit,
        sourceTree: binding.sourceTree,
        cloneTree: binding.cloneTree,
      },
    );
  }

  const tagRef = `refs/tags/${requestedTag}`;
  const tagObjectResult = await recorder.run({
    id: "clone.tag-object",
    executable: "git",
    args: ["rev-parse", "--verify", `${tagRef}^{tag}`],
    cwd: cloneRoot,
    scope: "clone",
  });
  const cloneTagObject = normalizeObjectId(singleLine(tagObjectResult.stdout, "clone tag object"), "CLONE_TAG_INVALID");
  const peeledResult = await recorder.run({
    id: "clone.tag-peeled",
    executable: "git",
    args: ["rev-parse", "--verify", `${tagRef}^{commit}`],
    cwd: cloneRoot,
    scope: "clone",
  });
  const clonePeeledCommit = normalizeObjectId(singleLine(peeledResult.stdout, "clone tag commit"), "CLONE_TAG_COMMIT_INVALID");
  await recorder.run({
    id: "clone.tag-verify",
    executable: "git",
    args: ["verify-tag", "--raw", tagRef],
    cwd: cloneRoot,
    scope: "clone",
  });
  if (cloneTagObject !== binding.tag.objectId || clonePeeledCommit !== binding.sourceCommit) {
    throw new ReproducibilityVerificationError(
      "CLONE_TAG_BINDING_MISMATCH",
      "isolated clone tag object/peeled commit differs from the verified source tag",
      { cloneTagObject, clonePeeledCommit },
    );
  }
}

async function auditSourceChanges({ recorder, cloneRoot, phase }) {
  const tracked = await recorder.run({
    id: `${phase}.tracked-diff`,
    executable: "git",
    args: ["diff", "--name-only", "--no-renames", "-z", "--"],
    cwd: cloneRoot,
    scope: "clone",
  });
  const staged = await recorder.run({
    id: `${phase}.staged-diff`,
    executable: "git",
    args: ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"],
    cwd: cloneRoot,
    scope: "clone",
  });
  const untracked = await recorder.run({
    id: `${phase}.untracked-files`,
    executable: "git",
    args: ["ls-files", "--others", "--exclude-standard", "-z"],
    cwd: cloneRoot,
    scope: "clone",
  });

  const ignored = await recorder.run({
    id: `${phase}.ignored-files`,
    executable: "git",
    args: [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
    ],
    cwd: cloneRoot,
    scope: "clone",
  });

  const classified = {
    tracked: classifyChangedPaths(parseNulPaths(tracked.stdout), { allowGenerated: false }),
    staged: classifyChangedPaths(parseNulPaths(staged.stdout), { allowGenerated: false }),
    untracked: classifyChangedPaths(parseNulPaths(untracked.stdout)),
    ignored: classifyChangedPaths(parseNulPaths(ignored.stdout)),
  };
  const unexpected = [
    ...classified.tracked.unexpected.map((candidate) => ({ state: "tracked", path: candidate })),
    ...classified.staged.unexpected.map((candidate) => ({ state: "staged", path: candidate })),
    ...classified.untracked.unexpected.map((candidate) => ({ state: "untracked", path: candidate })),
    ...classified.ignored.unexpected.map((candidate) => ({ state: "ignored", path: candidate })),
  ];
  const audit = {
    phase,
    status: unexpected.length ? "FAIL" : "PASS",
    tracked: summarizePathClassification(classified.tracked),
    staged: summarizePathClassification(classified.staged),
    untracked: summarizePathClassification(classified.untracked),
    ignored: summarizePathClassification(classified.ignored),
  };
  if (unexpected.length) {
    throw new ReproducibilityVerificationError(
      "SOURCE_DIFF_DETECTED",
      `${phase} changed tracked or untracked source`,
      {
        phase,
        unexpectedCount: unexpected.length,
        unexpectedSample: unexpected.slice(0, 20),
        auditSha256: sha256(canonicalJson(audit)),
      },
    );
  }
  return audit;
}

async function runDefaultChecks({ recorder, cloneRoot, selectedChecks, checkResults }) {
  const definitions = [
    { id: "openapi", args: ["run", "openapi:check"] },
    { id: "runtimeSchema", args: ["run", "runtime:schema:check"] },
    { id: "runtimeValidator", args: ["run", "runtime:validator:check"] },
    { id: "typecheck", args: ["run", "typecheck"] },
  ];
  for (const definition of definitions) {
    if (!selectedChecks[definition.id]) {
      recorder.skip({
        id: `check.${definition.id}`,
        executable: "npm",
        args: definition.args,
        cwd: cloneRoot,
        scope: "clone",
      });
      checkResults.push({ id: definition.id, status: "NOT_RUN" });
      continue;
    }
    await recorder.run({
      id: `check.${definition.id}`,
      executable: "npm",
      args: definition.args,
      cwd: cloneRoot,
      scope: "clone",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    checkResults.push({ id: definition.id, status: "PASS" });
  }
}

function createRecorder({
  commandRunner,
  commands,
  evidenceArtifacts,
  evidenceDirectoryName,
  roots,
}) {
  if (typeof commandRunner !== "function") throw new TypeError("commandRunner must be a function");
  let sequence = 0;
  return {
    async run(specification) {
      let result;
      try {
        result = normalizeCommandResult(await commandRunner(specification));
      } catch (error) {
        result = {
          exitCode: null,
          signal: null,
          errorCode: typeof error?.code === "string" ? error.code : "RUNNER_THROW",
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      }
      sequence += 1;
      const recorded = commandRecord({
        specification,
        result,
        roots: roots(),
        status: result.exitCode === 0 ? "PASS" : "FAIL",
        sequence,
        evidenceDirectoryName,
      });
      commands.push(recorded.record);
      evidenceArtifacts.push(...recorded.artifacts);
      if (recorded.secretFindings.length) {
        throw new ReproducibilityVerificationError(
          "COMMAND_OUTPUT_SECRET_DETECTED",
          `verification command output was redacted: ${specification.id}`,
          {
            commandId: specification.id,
            streams: recorded.secretFindings,
          },
        );
      }
      if (result.exitCode !== 0) {
        throw new ReproducibilityVerificationError(
          "COMMAND_FAILED",
          `verification command failed: ${specification.id}`,
          {
            commandId: specification.id,
            exitCode: result.exitCode,
            signal: result.signal,
            errorCode: result.errorCode,
            stdoutSha256: sha256(result.stdout),
            stderrSha256: sha256(result.stderr),
          },
        );
      }
      return result;
    },
    skip(specification) {
      const empty = {
        exitCode: null,
        signal: null,
        errorCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
      sequence += 1;
      const recorded = commandRecord({
        specification,
        result: empty,
        roots: roots(),
        status: "NOT_RUN",
        sequence,
        evidenceDirectoryName,
      });
      commands.push(recorded.record);
    },
  };
}

function commandRecord({
  specification,
  result,
  roots,
  status,
  sequence,
  evidenceDirectoryName,
}) {
  const stdout = commandStreamEvidence({
    commandId: specification.id,
    evidenceDirectoryName,
    bytes: result.stdout,
    sequence,
    stream: "stdout",
  });
  const stderr = commandStreamEvidence({
    commandId: specification.id,
    evidenceDirectoryName,
    bytes: result.stderr,
    sequence,
    stream: "stderr",
  });
  const secretFindings = [stdout, stderr]
    .filter((entry) => entry.secretFindings.length)
    .map((entry) => ({
      stream: entry.stream,
      findingIds: entry.secretFindings,
      byteSize: entry.descriptor.byteSize,
      sha256: entry.descriptor.sha256,
    }));
  return {
    record: {
      id: specification.id,
      executable: specification.executable,
      args: specification.args.map((argument) => redactPath(String(argument), roots)),
      cwd: specification.scope,
      status: secretFindings.length ? "FAIL" : status,
      exitCode: result.exitCode,
      signal: result.signal,
      errorCode: result.errorCode,
      stdout: stdout.descriptor,
      stderr: stderr.descriptor,
    },
    artifacts: [...stdout.artifacts, ...stderr.artifacts],
    secretFindings,
  };
}

function commandStreamEvidence({ commandId, evidenceDirectoryName, bytes, sequence, stream }) {
  const digest = sha256(bytes);
  const secretFindings = scanCommandOutput(bytes);
  const descriptor = {
    byteSize: bytes.length,
    sha256: digest,
    artifact: null,
    redactionWarning: null,
    secretScan: {
      status: secretFindings.length ? "BLOCKED" : "PASS",
      findingIds: secretFindings,
    },
  };
  if (bytes.length === 0) return { descriptor, artifacts: [], secretFindings, stream };

  const stem = `${String(sequence).padStart(4, "0")}-${safeCommandId(commandId)}.${stream}`;
  if (!secretFindings.length) {
    const relativePath = `${evidenceDirectoryName}/commands/${stem}.log`;
    const reference = evidenceReference(relativePath, bytes);
    descriptor.artifact = reference;
    return {
      descriptor,
      artifacts: [{
        kind: "raw-command-output",
        relativePath,
        bytes,
        ...reference,
      }],
      secretFindings,
      stream,
    };
  }

  const warningDocument = {
    schemaVersion: REDACTED_OUTPUT_SCHEMA_VERSION,
    commandId,
    stream,
    status: "REDACTED",
    findingIds: secretFindings,
    originalByteSize: bytes.length,
    originalSha256: digest,
  };
  const warningBytes = Buffer.from(canonicalJsonFile(warningDocument), "utf8");
  const relativePath = `${evidenceDirectoryName}/commands/${stem}.redaction-warning.json`;
  const reference = evidenceReference(relativePath, warningBytes);
  descriptor.redactionWarning = reference;
  return {
    descriptor,
    artifacts: [{
      kind: "redaction-warning",
      relativePath,
      bytes: warningBytes,
      ...reference,
    }],
    secretFindings,
    stream,
  };
}

function evidenceReference(relativePath, bytes) {
  return {
    uri: `file:./${relativePath}`,
    sha256: sha256(bytes),
    byteSize: bytes.length,
  };
}

function safeCommandId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new ReproducibilityVerificationError(
      "COMMAND_ID_INVALID",
      "command IDs must be safe artifact filename components",
    );
  }
  return value;
}

function scanCommandOutput(bytes) {
  if (bytes.length === 0) return [];
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return ["non-utf8-output"];
  }
  return SECRET_OUTPUT_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ id }) => id)
    .sort(compareStrings);
}

function validateEvidenceArtifacts({ receipt, evidenceArtifacts, evidenceDirectoryName }) {
  if (!Array.isArray(evidenceArtifacts)) throw new Error("evidenceArtifacts must be an array");
  const expected = new Map();
  for (const command of receipt.payload.commands ?? []) {
    if (command.status === "FAIL" && receipt.payload.status !== "FAIL") {
      throw new Error(`failed command ${command.id} cannot appear in a non-FAIL receipt`);
    }
    if (command.status === "NOT_RUN" && receipt.payload.status === "PASS") {
      throw new Error(`NOT_RUN command ${command.id} cannot appear in a PASS receipt`);
    }
    for (const stream of ["stdout", "stderr"]) {
      collectExpectedStreamArtifact({
        commandId: command.id,
        commandStatus: command.status,
        receiptStatus: receipt.payload.status,
        stream,
        descriptor: command[stream],
        evidenceDirectoryName,
        expected,
      });
    }
  }
  if (evidenceArtifacts.length !== expected.size) {
    throw new Error(`evidence artifact count mismatch: expected ${expected.size}, got ${evidenceArtifacts.length}`);
  }

  const observed = new Set();
  const validated = [];
  for (const artifact of evidenceArtifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("evidence artifacts must be objects");
    }
    const expectedArtifact = expected.get(artifact.relativePath);
    if (!expectedArtifact) throw new Error(`unexpected evidence artifact: ${String(artifact.relativePath)}`);
    if (observed.has(artifact.relativePath)) throw new Error(`duplicate evidence artifact: ${artifact.relativePath}`);
    observed.add(artifact.relativePath);
    if (!Buffer.isBuffer(artifact.bytes)) throw new Error(`evidence artifact bytes missing: ${artifact.relativePath}`);
    if (artifact.kind !== expectedArtifact.kind) throw new Error(`evidence artifact kind mismatch: ${artifact.relativePath}`);
    const actual = evidenceReference(artifact.relativePath, artifact.bytes);
    if (
      artifact.uri !== actual.uri
      || artifact.sha256 !== actual.sha256
      || artifact.byteSize !== actual.byteSize
      || expectedArtifact.reference.uri !== actual.uri
      || expectedArtifact.reference.sha256 !== actual.sha256
      || expectedArtifact.reference.byteSize !== actual.byteSize
    ) {
      throw new Error(`evidence artifact integrity mismatch: ${artifact.relativePath}`);
    }
    if (artifact.kind === "raw-command-output" && scanCommandOutput(artifact.bytes).length) {
      throw new Error(`raw evidence artifact failed the pre-write secret scan: ${artifact.relativePath}`);
    }
    if (artifact.kind === "redaction-warning") {
      validateRedactionWarning(artifact.bytes, expectedArtifact);
    }
    validated.push(artifact);
  }
  for (const relativePath of expected.keys()) {
    if (!observed.has(relativePath)) throw new Error(`missing evidence artifact: ${relativePath}`);
  }
  return validated.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

function collectExpectedStreamArtifact({
  commandId,
  commandStatus,
  receiptStatus,
  stream,
  descriptor,
  evidenceDirectoryName,
  expected,
}) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error(`command ${commandId} ${stream} descriptor is invalid`);
  }
  if (!Number.isInteger(descriptor.byteSize) || descriptor.byteSize < 0) {
    throw new Error(`command ${commandId} ${stream} byteSize is invalid`);
  }
  if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256)) {
    throw new Error(`command ${commandId} ${stream} SHA-256 is invalid`);
  }
  const scanStatus = descriptor.secretScan?.status;
  const findingIds = descriptor.secretScan?.findingIds;
  if (!new Set(["PASS", "BLOCKED"]).has(scanStatus) || !Array.isArray(findingIds)) {
    throw new Error(`command ${commandId} ${stream} secret scan is invalid`);
  }
  if (scanStatus === "PASS" && findingIds.length !== 0) {
    throw new Error(`command ${commandId} ${stream} PASS scan cannot contain findings`);
  }
  if (descriptor.byteSize === 0) {
    if (descriptor.sha256 !== sha256("") || descriptor.artifact !== null || descriptor.redactionWarning !== null) {
      throw new Error(`command ${commandId} ${stream} empty stream must have null artifacts`);
    }
    return;
  }
  if (scanStatus === "PASS") {
    if (!descriptor.artifact || descriptor.redactionWarning !== null) {
      throw new Error(`command ${commandId} ${stream} raw artifact reference is required`);
    }
    if (
      descriptor.artifact.sha256 !== descriptor.sha256
      || descriptor.artifact.byteSize !== descriptor.byteSize
    ) {
      throw new Error(`command ${commandId} ${stream} raw artifact binding is invalid`);
    }
    addExpectedArtifact({
      reference: descriptor.artifact,
      kind: "raw-command-output",
      commandId,
      stream,
      descriptor,
      evidenceDirectoryName,
      expected,
    });
    return;
  }
  if (findingIds.length === 0 || descriptor.artifact !== null || !descriptor.redactionWarning) {
    throw new Error(`command ${commandId} ${stream} blocked stream must reference one warning artifact`);
  }
  if (commandStatus !== "FAIL" || receiptStatus !== "FAIL") {
    throw new Error(`command ${commandId} ${stream} blocked output requires command and receipt FAIL`);
  }
  addExpectedArtifact({
    reference: descriptor.redactionWarning,
    kind: "redaction-warning",
    commandId,
    stream,
    descriptor,
    evidenceDirectoryName,
    expected,
  });
}

function addExpectedArtifact({
  reference,
  kind,
  commandId,
  stream,
  descriptor,
  evidenceDirectoryName,
  expected,
}) {
  const relativePath = relativePathFromEvidenceUri(reference?.uri, evidenceDirectoryName);
  if (!/^[0-9a-f]{64}$/u.test(reference?.sha256) || !Number.isInteger(reference?.byteSize)) {
    throw new Error(`command ${commandId} ${stream} artifact reference is invalid`);
  }
  if (expected.has(relativePath)) throw new Error(`duplicate receipt artifact URI: ${reference.uri}`);
  expected.set(relativePath, { reference, kind, commandId, stream, descriptor });
}

function relativePathFromEvidenceUri(uri, evidenceDirectoryName) {
  const prefix = `file:./${evidenceDirectoryName}/commands/`;
  if (typeof uri !== "string" || !uri.startsWith(prefix)) {
    throw new Error(`evidence URI must be relative to ${evidenceDirectoryName}/commands`);
  }
  const relativePath = uri.slice("file:./".length);
  validateArtifactRelativePath(relativePath);
  return relativePath;
}

function validateRedactionWarning(bytes, expectedArtifact) {
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("redaction warning artifact is not valid JSON");
  }
  if (canonicalJsonFile(document) !== bytes.toString("utf8")) {
    throw new Error("redaction warning artifact is not canonical JSON");
  }
  const descriptor = expectedArtifact.descriptor;
  if (
    document.schemaVersion !== REDACTED_OUTPUT_SCHEMA_VERSION
    || document.commandId !== expectedArtifact.commandId
    || document.stream !== expectedArtifact.stream
    || document.status !== "REDACTED"
    || document.originalByteSize !== descriptor.byteSize
    || document.originalSha256 !== descriptor.sha256
    || canonicalJson(document.findingIds) !== canonicalJson(descriptor.secretScan.findingIds)
  ) {
    throw new Error("redaction warning artifact does not match its receipt stream");
  }
  if (scanCommandOutput(bytes).length) {
    throw new Error("redaction warning artifact contains secret-like material");
  }
}

function normalizeCommandResult(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("commandRunner must return an object");
  }
  return {
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    signal: typeof value.signal === "string" ? value.signal : null,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
    stdout: toBuffer(value.stdout),
    stderr: toBuffer(value.stderr),
  };
}

function classifyChangedPaths(paths, { allowGenerated = true } = {}) {
  const allowed = [];
  const unexpected = [];
  for (const candidate of [...new Set(paths)].sort(compareStrings)) {
    validateCandidatePath(candidate);
    if (allowGenerated && GENERATED_PATH_RULES.some((rule) => rule.test(candidate))) allowed.push(candidate);
    else unexpected.push(candidate);
  }
  return { allowed, unexpected };
}

function summarizePathClassification(classification) {
  return {
    allowedGeneratedCount: classification.allowed.length,
    allowedGeneratedSha256: digestPaths(classification.allowed),
    allowedGeneratedSample: classification.allowed.slice(0, 20),
    unexpectedCount: classification.unexpected.length,
    unexpectedSha256: digestPaths(classification.unexpected),
    unexpectedSample: classification.unexpected.slice(0, 20),
  };
}

function digestPaths(paths) {
  return sha256(paths.length ? `${paths.join("\n")}\n` : "");
}

function parseNulPaths(buffer) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) {
    throw new ReproducibilityVerificationError(
      "GIT_PATH_OUTPUT_INVALID",
      "Git path output must be NUL terminated",
    );
  }
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const bytes = buffer.subarray(start, index);
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes)) {
      throw new ReproducibilityVerificationError(
        "GIT_PATH_ENCODING_INVALID",
        "Git reported a path that is not valid UTF-8",
      );
    }
    records.push(decoded.endsWith("/") ? decoded.slice(0, -1) : decoded);
    start = index + 1;
  }
  return records;
}

function validateCandidatePath(candidate) {
  if (!candidate || candidate.includes("\0") || path.posix.isAbsolute(candidate)) {
    throw new ReproducibilityVerificationError("GIT_PATH_INVALID", "Git reported an invalid path");
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ReproducibilityVerificationError("GIT_PATH_INVALID", "Git reported a non-canonical path");
  }
}

function normalizeCommit(value) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new ReproducibilityVerificationError(
      "COMMIT_REQUIRED",
      "commit must be an explicit full lowercase 40- or 64-hex object ID",
    );
  }
  return value;
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
    throw new ReproducibilityVerificationError("TAG_REQUIRED", "tag must be an explicit safe tag name");
  }
  return value;
}

function normalizeObjectId(value, code) {
  if (!SHA_PATTERN.test(value)) {
    throw new ReproducibilityVerificationError(code, "Git returned an invalid full object ID");
  }
  return value;
}

function normalizeChecks(checks) {
  const input = checks && typeof checks === "object" ? checks : {};
  return {
    openapi: input.openapi !== false,
    runtimeSchema: input.runtimeSchema !== false,
    runtimeValidator: input.runtimeValidator !== false,
    typecheck: input.typecheck !== false,
  };
}

function normalizeEvidenceDirectoryName(value) {
  if (
    typeof value !== "string"
    || !value.endsWith(".evidence")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(value)
  ) {
    throw new ReproducibilityVerificationError(
      "EVIDENCE_DIRECTORY_INVALID",
      "evidenceDirectoryName must be one safe relative .evidence directory name",
    );
  }
  return value;
}

function parseNodeMajor(value) {
  const match = String(value).trim().match(/^v?(\d+)(?:\.|$)/u);
  return match ? Number.parseInt(match[1], 10) : null;
}

function singleLine(buffer, label) {
  const value = buffer.toString("utf8").trim();
  if (!value || /[\r\n]/u.test(value)) {
    throw new ReproducibilityVerificationError("COMMAND_OUTPUT_INVALID", `${label} must be one non-empty line`);
  }
  return value;
}

function normalizeFailure(error) {
  if (error instanceof ReproducibilityVerificationError) {
    return {
      code: error.code,
      message: error.message,
      details: normalizeCanonical(error.details),
    };
  }
  return {
    code: "VERIFIER_INTERNAL_ERROR",
    message: "unexpected verifier failure",
    details: {
      causeName: typeof error?.name === "string" ? error.name : null,
      causeCode: typeof error?.code === "string" ? error.code : null,
    },
  };
}

export function validateReceiptSeal(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("receipt must be an object");
  }
  if (receipt.schemaVersion !== REPRODUCIBILITY_SCHEMA_VERSION) {
    throw new Error("receipt schemaVersion is invalid");
  }
  const expected = sha256(canonicalJson({
    schemaVersion: receipt.schemaVersion,
    payload: receipt.payload,
  }));
  if (receipt.payloadSha256 !== expected) throw new Error("receipt payloadSha256 is invalid");
  if (!new Set(["PASS", "FAIL", "INCONCLUSIVE"]).has(receipt.payload?.status)) {
    throw new Error("receipt status is invalid");
  }
}

function normalizeCanonical(value, location = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${location} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeCanonical(entry, `${location}[${index}]`));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${location} is not a JSON object`);
  }
  const output = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (value[key] === undefined) throw new TypeError(`${location}.${key} is undefined`);
    output[key] = normalizeCanonical(value[key], `${location}.${key}`);
  }
  return output;
}

function redactPath(value, { sourceRoot, temporaryRoot, cloneRoot }) {
  let result = value;
  const replacements = [
    [cloneRoot, "$ISOLATED_CHECKOUT"],
    [temporaryRoot, "$ISOLATED_ROOT"],
    [sourceRoot, "$SOURCE_REPOSITORY"],
  ].filter(([candidate]) => typeof candidate === "string" && candidate);
  for (const [candidate, replacement] of replacements) {
    if (result === candidate) result = replacement;
    else if (result.startsWith(`${candidate}${path.sep}`)) {
      result = `${replacement}/${result.slice(candidate.length + 1).split(path.sep).join("/")}`;
    }
  }
  return result;
}

function utcNow(now) {
  const value = now();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
    throw new TypeError("now() must return an ISO UTC timestamp");
  }
  return value;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== "string" || !value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function validateArtifactRelativePath(candidate) {
  if (
    typeof candidate !== "string"
    || !candidate
    || candidate.includes("\\")
    || path.posix.isAbsolute(candidate)
  ) {
    throw new Error("evidence artifact path is invalid");
  }
  const segments = candidate.split("/");
  if (
    segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(segment)
    ))
  ) {
    throw new Error("evidence artifact path is not canonical");
  }
}

function safeArtifactPath(root, relativePath) {
  validateArtifactRelativePath(relativePath);
  const target = path.resolve(root, ...relativePath.split("/"));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("evidence artifact path escapes its package root");
  }
  return target;
}

function hasSegment(candidate, segment) {
  return candidate.split("/").includes(segment);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value), "utf8");
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/verify-workbench-reproducibility.mjs \\
  --commit <full-object-id> --tag <signed-annotated-tag> --output <receipt.json> [options]\n\nOptions:\n  --repo <path>                       Local Git repository (default: cwd)\n  --skip-openapi-check                Record OpenAPI check as NOT_RUN\n  --skip-runtime-schema-check         Record runtime schema check as NOT_RUN\n  --skip-runtime-validator-check      Record runtime validator check as NOT_RUN\n  --skip-typecheck                    Record typecheck as NOT_RUN\n`);
}

async function main() {
  let options;
  try {
    options = parseCliArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    const evidenceDirectoryName = evidenceDirectoryNameForOutput(options.output);
    const result = await verifyWorkbenchReproducibility({
      repoRoot: options.repoRoot,
      commit: options.commit,
      tag: options.tag,
      checks: options.checks,
      evidenceDirectoryName,
    });
    const written = await writeReproducibilityReceipt(
      options.output,
      result.receipt,
      result.evidenceArtifacts,
    );
    process.stdout.write(canonicalJsonFile({
      evidenceArtifactCount: written.evidenceArtifactCount,
      evidenceDirectory: written.evidenceDirectoryPath,
      output: written.outputPath,
      receiptSha256: written.receiptSha256,
      sidecar: written.sidecarPath,
      status: result.status,
    }));
    if (!result.passed) process.exitCode = result.status === "INCONCLUSIVE" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`REPRODUCIBILITY_VERIFICATION_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
