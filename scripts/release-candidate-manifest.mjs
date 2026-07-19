#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createReleaseCandidateManifest,
  normalizeReleaseMetadata,
} from "./release-candidate-manifest-lib.mjs";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

export async function main(args) {
  try {
    const options = parseArguments(args);
    if (options.help) {
      process.stdout.write(usage());
    } else {
      await run(options);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    process.exitCode = 2;
  }
}

async function run(options) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const manifestOutput = requiredPath(options.manifestOutput, "--manifest-output");
  const inventoryOutput = requiredPath(options.inventoryOutput, "--inventory-output");
  const metadataFile = requiredPath(options.metadataFile, "--metadata-file");
  if (manifestOutput === inventoryOutput) throw new Error("manifest and inventory outputs must be different files");

  const releaseMetadata = normalizeReleaseMetadata(JSON.parse(await readFile(metadataFile, "utf8")));

  await assertOutputOutsideRepository(repoRoot, manifestOutput);
  await assertOutputOutsideRepository(repoRoot, inventoryOutput);
  await assertImmutableTargetsAvailable(manifestOutput, inventoryOutput);

  const result = await createReleaseCandidateManifest({
    repoRoot,
    audit: {
      startedAt: requiredValue(options.auditStartedAt, "--audit-started-at"),
      endedAt: requiredValue(options.auditEndedAt, "--audit-ended-at"),
      executor: requiredValue(options.executor, "--executor"),
      verifier: requiredValue(options.verifier, "--verifier"),
    },
    signedTag: options.signedTag ?? null,
    expectedMigrationCount: parsePositiveInteger(options.expectedMigrationCount, "--expected-migration-count"),
    releaseMetadata,
    inventoryArtifactName: path.basename(inventoryOutput),
  });

  const written = await writeImmutableArtifactSet({
    manifestOutput,
    inventoryOutput,
    manifestContent: result.manifestJson,
    inventoryContent: result.inventoryNdjson,
  });

  const receipt = {
    candidateId: result.manifest.candidateId,
    gateStatus: result.manifest.gate.status,
    findingCount: result.manifest.gate.findingCount,
    manifest: {
      path: manifestOutput,
      byteSize: Buffer.byteLength(result.manifestJson),
      sha256: written.manifest.sha256,
      sha256Sidecar: written.manifest.sidecarPath,
    },
    inventory: {
      path: inventoryOutput,
      byteSize: Buffer.byteLength(result.inventoryNdjson),
      sha256: written.inventory.sha256,
      sha256Sidecar: written.inventory.sidecarPath,
      entryCount: result.manifest.inventory.entryCount,
    },
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

function parseArguments(args) {
  const result = {};
  const names = new Map([
    ["--repo-root", "repoRoot"],
    ["--manifest-output", "manifestOutput"],
    ["--inventory-output", "inventoryOutput"],
    ["--audit-started-at", "auditStartedAt"],
    ["--audit-ended-at", "auditEndedAt"],
    ["--executor", "executor"],
    ["--verifier", "verifier"],
    ["--signed-tag", "signedTag"],
    ["--expected-migration-count", "expectedMigrationCount"],
    ["--metadata-file", "metadataFile"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    const property = names.get(argument);
    if (!property) throw new Error(`unknown argument: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (result[property] !== undefined) throw new Error(`${argument} may only be provided once`);
    result[property] = value;
    index += 1;
  }
  return result;
}

async function assertOutputOutsideRepository(repoRoot, outputPath) {
  const canonicalRepoRoot = await realpath(repoRoot);
  const canonicalParent = await realpath(path.dirname(outputPath));
  const resolvedOutput = path.join(canonicalParent, path.basename(outputPath));
  const relative = path.relative(canonicalRepoRoot, resolvedOutput);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error(`release candidate artifacts must be written outside the repository: ${outputPath}`);
  }
  try {
    const info = await lstat(outputPath);
    if (info.isSymbolicLink()) throw new Error(`output must not be a symbolic link: ${outputPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function writeImmutableArtifactSet({
  manifestOutput,
  inventoryOutput,
  manifestContent,
  inventoryContent,
  linkFile = link,
} = {}) {
  const targets = createArtifactTargets({ manifestOutput, inventoryOutput, manifestContent, inventoryContent });
  await assertTargetsDoNotOverlap(targets);
  await assertTargetsAbsent(targets);

  const temporaryPaths = [];
  const createdTargets = [];
  try {
    for (const target of targets) {
      target.temporaryPath = await writeExclusiveTemporaryFile(target.path, target.content);
      temporaryPaths.push(target.temporaryPath);
    }
    for (const target of targets) {
      await linkFile(target.temporaryPath, target.path);
      createdTargets.push(target.path);
    }
    for (const temporaryPath of [...temporaryPaths]) {
      await unlink(temporaryPath);
      temporaryPaths.splice(temporaryPaths.indexOf(temporaryPath), 1);
    }
  } catch (error) {
    const cleanupErrors = await removeCreatedFiles([...createdTargets].reverse(), temporaryPaths);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "immutable artifact transaction failed and cleanup was incomplete");
    }
    throw error;
  }

  const manifestSha256 = sha256(manifestContent);
  const inventorySha256 = sha256(inventoryContent);
  return {
    manifest: {
      path: manifestOutput,
      sha256: manifestSha256,
      sidecarPath: `${manifestOutput}.sha256`,
    },
    inventory: {
      path: inventoryOutput,
      sha256: inventorySha256,
      sidecarPath: `${inventoryOutput}.sha256`,
    },
  };
}

async function assertImmutableTargetsAvailable(manifestOutput, inventoryOutput) {
  const targets = createArtifactTargets({
    manifestOutput,
    inventoryOutput,
    manifestContent: "",
    inventoryContent: "",
  });
  await assertTargetsDoNotOverlap(targets);
  await assertTargetsAbsent(targets);
}

function createArtifactTargets({ manifestOutput, inventoryOutput, manifestContent, inventoryContent }) {
  const manifestSha256 = sha256(manifestContent);
  const inventorySha256 = sha256(inventoryContent);
  return [
    {
      path: inventoryOutput,
      content: inventoryContent,
    },
    {
      path: `${inventoryOutput}.sha256`,
      content: `${inventorySha256}  ${path.basename(inventoryOutput)}\n`,
    },
    {
      path: manifestOutput,
      content: manifestContent,
    },
    {
      path: `${manifestOutput}.sha256`,
      content: `${manifestSha256}  ${path.basename(manifestOutput)}\n`,
    },
  ];
}

async function assertTargetsDoNotOverlap(targets) {
  const normalized = targets.map((target) => path.resolve(target.path));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("manifest, inventory, and SHA-256 sidecar paths must be distinct");
  }
}

async function assertTargetsAbsent(targets) {
  for (const target of targets) {
    try {
      await lstat(target.path);
      throw new Error(`immutable artifact already exists: ${target.path}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function writeExclusiveTemporaryFile(targetPath, content) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      return temporaryPath;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`could not allocate an exclusive temporary file for ${targetPath}`);
}

async function removeCreatedFiles(createdTargets, temporaryPaths) {
  const errors = [];
  for (const candidatePath of [...createdTargets, ...temporaryPaths]) {
    try {
      await unlink(candidatePath);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }
  return errors;
}

function requiredPath(value, label) {
  return path.resolve(requiredValue(value, label));
}

function requiredValue(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function parsePositiveInteger(value, label) {
  const raw = requiredValue(value, label);
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function usage() {
  return `Usage:
  node scripts/release-candidate-manifest.mjs \\
    --manifest-output /immutable/path/release-candidate.json \\
    --inventory-output /immutable/path/release-candidate-inventory.ndjson \\
    --audit-started-at 2026-07-18T00:00:00Z \\
    --audit-ended-at 2026-07-18T00:10:00Z \\
    --executor <identity> \\
    --verifier <identity> \\
    --signed-tag <signed-annotated-tag> \\
    --expected-migration-count <count> \\
    --metadata-file /path/release-metadata.json \\
    [--repo-root /path/repository]

The output files must be outside the repository and must not already exist. The command
writes the manifest, inventory, and a .sha256 sidecar for each even when G1 fails, then
exits 1. Invalid invocation, capture failure, or immutable-output conflict exits 2.
`;
}
