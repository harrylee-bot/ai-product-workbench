#!/usr/bin/env node

import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonFile, sha256Bytes } from "../evidence-ledger.mjs";
import { ProductionAcceptanceContractError } from "./catalog.mjs";
import { createStrictAjv2020 } from "./schema.mjs";

export const OBSERVATION_SOURCE_SCHEMA_VERSION = "workbench.production-observation-source.v1";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const schemaPath = path.join(repoRoot, "docs/evidence/production-observation-source.schema.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_PATH_PATTERN = /^(?:observations|raw)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MAX_DECODED_BYTES = 100 * 1024 * 1024;
let validatorPromise;

export async function materializeProductionObservationSource({
  sourcePath,
  expectedSha256,
  outputRoot,
} = {}) {
  if (!SHA256_PATTERN.test(expectedSha256 ?? "")) {
    throw new ProductionAcceptanceContractError(["expected observation source SHA-256 is invalid"]);
  }
  const source = await readStableRegularFile(sourcePath, "observation source bundle");
  if (sha256Bytes(source.bytes) !== expectedSha256) {
    throw new ProductionAcceptanceContractError(["observation source bundle SHA-256 mismatch"]);
  }
  let document;
  try {
    document = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `observation source bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (source.bytes.toString("utf8") !== canonicalJsonFile(document)) {
    throw new ProductionAcceptanceContractError([
      "observation source bundle must be canonical JSON with one trailing LF",
    ]);
  }
  const validate = await sourceValidator();
  if (!validate(document)) {
    throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
      `observation source bundle${error.instancePath || "/"} ${error.message}`
    )));
  }

  const destination = await validateOutputRoot(outputRoot, source.path);
  const seen = new Set();
  const decoded = [];
  let totalBytes = 0;
  for (const [index, file] of document.files.entries()) {
    if (!safeSourcePath(file.path)) {
      throw new ProductionAcceptanceContractError([`observation source files[${index}].path is unsafe`]);
    }
    if (seen.has(file.path)) {
      throw new ProductionAcceptanceContractError([`observation source path is duplicated: ${file.path}`]);
    }
    if (!isCanonicalBase64(file.contentBase64)) {
      throw new ProductionAcceptanceContractError([`observation source ${file.path} is not canonical base64`]);
    }
    const content = Buffer.from(file.contentBase64, "base64");
    totalBytes += content.length;
    if (totalBytes > MAX_DECODED_BYTES) {
      throw new ProductionAcceptanceContractError(["decoded observation source exceeds 100 MiB"]);
    }
    if (sha256Bytes(content) !== file.sha256) {
      throw new ProductionAcceptanceContractError([`observation source ${file.path} SHA-256 mismatch`]);
    }
    seen.add(file.path);
    decoded.push({ path: file.path, content });
  }

  await mkdir(destination, { mode: 0o700 });
  const sentinel = path.join(destination, ".incomplete");
  await writeExclusive(sentinel, Buffer.from(`${OBSERVATION_SOURCE_SCHEMA_VERSION}\n`, "utf8"));
  try {
    for (const file of decoded) {
      await writeExclusive(path.join(destination, ...file.path.split("/")), file.content);
    }
    await rm(sentinel);
  } catch (error) {
    throw error;
  }
  return Object.freeze({
    status: "READY",
    outputRoot: destination,
    sha256: expectedSha256,
    fileCount: decoded.length,
    decodedBytes: totalBytes,
  });
}

async function sourceValidator() {
  validatorPromise ??= readFile(schemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return validatorPromise;
}

async function readStableRegularFile(candidatePath, label) {
  const resolved = path.resolve(candidatePath ?? "");
  const before = await lstat(resolved).catch((error) => {
    throw new ProductionAcceptanceContractError([`${label} cannot be read: ${error.message}`]);
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ProductionAcceptanceContractError([`${label} must be a regular non-symlink file`]);
  }
  const canonical = await realpath(resolved);
  const bytes = await readFile(canonical);
  const after = await lstat(canonical);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new ProductionAcceptanceContractError([`${label} changed while it was read`]);
  }
  return { path: canonical, bytes };
}

async function validateOutputRoot(candidatePath, sourcePath) {
  const resolved = path.resolve(candidatePath ?? "");
  const parent = await realpath(path.dirname(resolved)).catch((error) => {
    throw new ProductionAcceptanceContractError([`observation source output parent cannot be read: ${error.message}`]);
  });
  const destination = path.join(parent, path.basename(resolved));
  if (isWithin(repoRoot, destination)) {
    throw new ProductionAcceptanceContractError(["observation source output must be outside the source repository"]);
  }
  if (destination === sourcePath) {
    throw new ProductionAcceptanceContractError(["observation source output must not overlap the source bundle"]);
  }
  try {
    await lstat(destination);
    throw new ProductionAcceptanceContractError(["observation source output must not already exist"]);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return destination;
}

function safeSourcePath(value) {
  return typeof value === "string"
    && SOURCE_PATH_PATTERN.test(value)
    && !value.includes("\\")
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function isCanonicalBase64(value) {
  return typeof value === "string"
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
    && Buffer.from(value, "base64").toString("base64") === value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function writeExclusive(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseArguments(argv) {
  const values = {};
  const aliases = new Map([
    ["--source", "sourcePath"],
    ["--source-sha256", "expectedSha256"],
    ["--output-root", "outputRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = aliases.get(argv[index]);
    if (!key) throw new Error(`unsupported argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index - 1]} requires a value`);
    if (Object.hasOwn(values, key)) throw new Error(`${argv[index - 1]} was provided more than once`);
    values[key] = value;
  }
  return values;
}

async function main() {
  try {
    const report = await materializeProductionObservationSource(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
