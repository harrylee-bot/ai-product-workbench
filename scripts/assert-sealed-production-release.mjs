#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readDeploymentEnv } from "./workbench-origin-manifest.mjs";

const MAX_UID = 4_294_967_294;
const GROUP_OR_WORLD_WRITE = 0o022;
const STICKY = 0o1000;

const SEALED_FILE_ENVIRONMENT = Object.freeze([
  ["WORKBENCH_IMAGE_INVENTORY_PATH", null],
  ["WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH", null],
  ["WORKBENCH_DEPLOYMENT_CONFIG_MANIFEST_PATH", null],
  ["WORKBENCH_DEPLOYMENT_CONFIG_BUNDLE_PATH", null],
  ["WORKBENCH_PRODUCTION_TRUST_POLICY_PATH", null],
  ["WORKBENCH_DEERFLOW_BASE_CONFIG_PATH", null],
  ["WORKBENCH_DEERFLOW_PROVIDER_ENV_FILE", null],
  ["WORKBENCH_DEERFLOW_SECRET_CHANNEL_ATTESTATION_PATH", null],
  ["WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_HOST_PATH", "WORKBENCH_RUNTIME_WORKER_UID"],
]);

const SEALED_DIRECTORY_ENVIRONMENT = Object.freeze([
  "WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR",
  "WORKBENCH_KNOWLEDGE_VAULT_HOST_DIR",
  "WORKBENCH_STORAGE_HOST_DIR",
]);

export function assertSealedProductionRelease({
  releaseRoot,
  environmentFile,
  ownerUid = 0,
  sealedFiles = [],
  sealedDirectories = [],
} = {}) {
  const trustedUid = numericUid(ownerUid, "release owner UID");
  const root = absoluteExistingPath(releaseRoot, "release root");
  assertDirectory(root, trustedUid, "release root");
  assertAncestorChain(root, trustedUid, "release root");
  assertDirectoryTree(root, trustedUid, "release root");

  const envPath = absoluteExistingPath(environmentFile, "release environment file");
  assertRegularFile(envPath, trustedUid, "release environment file");
  assertAncestorChain(envPath, trustedUid, "release environment file");
  const environment = readDeploymentEnv(readFileSync(envPath), {
    label: "release environment",
  });

  for (const [name, ownerEnvironmentName] of SEALED_FILE_ENVIRONMENT) {
    const configuredPath = environment.get(name)?.trim();
    if (!configuredPath) continue;
    const expectedUids = ownerEnvironmentName
      ? [trustedUid, numericUid(environment.get(ownerEnvironmentName), ownerEnvironmentName)]
      : [trustedUid];
    assertSealedFile(configuredPath, expectedUids, trustedUid, name);
  }
  for (const name of SEALED_DIRECTORY_ENVIRONMENT) {
    const configuredPath = environment.get(name)?.trim();
    if (!configuredPath) continue;
    assertSealedDirectory(configuredPath, trustedUid, name);
  }
  for (const definition of sealedFiles) {
    const { filePath, expectedUid } = sealedPathDefinition(definition, trustedUid, "sealed file");
    assertSealedFile(filePath, expectedUid, trustedUid, "sealed file");
  }
  for (const definition of sealedDirectories) {
    const { filePath, expectedUid } = sealedPathDefinition(definition, trustedUid, "sealed directory");
    assertSealedDirectory(filePath, expectedUid, "sealed directory");
  }

  return Object.freeze({
    status: "PASS",
    releaseRoot: root,
    environmentFile: envPath,
    ownerUid: trustedUid,
  });
}

function assertSealedFile(filePath, expectedUid, ancestorOwnerUid, label) {
  const resolved = absoluteExistingPath(filePath, label);
  assertRegularFile(resolved, expectedUid, label);
  assertAncestorChain(resolved, ancestorOwnerUid, label);
}

function assertSealedDirectory(directoryPath, expectedUid, label) {
  const resolved = absoluteExistingPath(directoryPath, label);
  assertDirectory(resolved, expectedUid, label);
  assertAncestorChain(resolved, expectedUid, label);
  assertDirectoryTree(resolved, expectedUid, label);
}

function assertDirectoryTree(root, expectedUid, label) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = lstatSync(entryPath);
      assertOwnerAndMode(stat, expectedUid, `${label} entry ${entryPath}`, { symlink: stat.isSymbolicLink() });
      if (stat.isSymbolicLink()) {
        const target = realpathSync(entryPath);
        assertWithin(root, target, `${label} symlink ${entryPath}`);
        const targetStat = statSync(entryPath);
        assertOwnerAndMode(targetStat, expectedUid, `${label} symlink target ${entryPath}`);
        continue;
      }
      if (stat.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`${label} contains an unsupported filesystem entry: ${entryPath}`);
      if (stat.nlink !== 1) throw new Error(`${label} file must not have external hard links: ${entryPath}`);
    }
  }
}

function assertRegularFile(filePath, expectedUid, label) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  assertOwnerAndMode(stat, expectedUid, label);
  if (stat.nlink !== 1) throw new Error(`${label} must not have external hard links`);
}

function assertDirectory(directoryPath, expectedUid, label) {
  const stat = lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
  assertOwnerAndMode(stat, expectedUid, label);
}

function assertOwnerAndMode(stat, expectedUid, label, { symlink = false } = {}) {
  const expectedUids = Array.isArray(expectedUid) ? [...new Set(expectedUid)] : [expectedUid];
  if (!expectedUids.includes(stat.uid)) {
    throw new Error(`${label} must be owned by UID ${expectedUids.join(" or ")}`);
  }
  if (!symlink && (stat.mode & GROUP_OR_WORLD_WRITE) !== 0) {
    throw new Error(`${label} must not be writable by group or other users`);
  }
}

function assertAncestorChain(targetPath, trustedUid, label) {
  let current = path.dirname(targetPath);
  while (true) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} ancestor must be a regular non-symlink directory: ${current}`);
    }
    if (stat.uid !== 0 && stat.uid !== trustedUid) {
      throw new Error(`${label} ancestor ${current} must be owned by root or UID ${trustedUid}`);
    }
    if ((stat.mode & GROUP_OR_WORLD_WRITE) !== 0 && !isTrustedStickyDirectory(stat, trustedUid)) {
      throw new Error(`${label} ancestor must not be writable by group or other users: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isTrustedStickyDirectory(stat, trustedUid) {
  return stat.isDirectory()
    && (stat.mode & STICKY) !== 0
    && (stat.uid === 0 || stat.uid === trustedUid);
}

function absoluteExistingPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = path.resolve(value);
  if (resolved !== value) throw new Error(`${label} must use a normalized absolute path`);
  if (!existsSync(resolved)) throw new Error(`${label} is missing: ${resolved}`);
  assertNoSymlinkPathComponents(resolved, label);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  return realpathSync(resolved);
}

function assertNoSymlinkPathComponents(targetPath, label) {
  const root = path.parse(targetPath).root;
  let current = root;
  for (const component of path.relative(root, targetPath).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} path components must not be symlinks: ${current}`);
    }
  }
}

function assertWithin(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} must resolve inside the sealed release`);
}

function sealedPathDefinition(value, fallbackUid, label) {
  if (typeof value !== "string") throw new Error(`${label} definition is invalid`);
  const separator = value.indexOf(":");
  if (separator < 1) return { filePath: value, expectedUid: fallbackUid };
  const owner = value.slice(0, separator);
  const filePath = value.slice(separator + 1);
  if (!filePath.startsWith("/")) return { filePath: value, expectedUid: fallbackUid };
  return { filePath, expectedUid: numericUid(owner, `${label} owner UID`) };
}

function numericUid(value, label) {
  const source = typeof value === "number" ? String(value) : value?.trim();
  if (typeof source !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/u.test(source)) {
    throw new Error(`${label} must be a numeric UID`);
  }
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_UID) throw new Error(`${label} is out of range`);
  return parsed;
}

function parseArguments(argv) {
  const options = { ownerUid: 0, sealedFiles: [], sealedDirectories: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw usage();
    if (name === "--release-root" && !seen.has(name)) options.releaseRoot = value;
    else if (name === "--env-file" && !seen.has(name)) options.environmentFile = value;
    else if (name === "--owner-uid" && !seen.has(name)) options.ownerUid = value;
    else if (name === "--sealed-file") options.sealedFiles.push(value);
    else if (name === "--sealed-directory") options.sealedDirectories.push(value);
    else throw usage();
    seen.add(name);
    index += 1;
  }
  if (!options.releaseRoot || !options.environmentFile) throw usage();
  return options;
}

function usage() {
  return new Error("usage: assert-sealed-production-release.mjs --release-root <path> --env-file <path> [--owner-uid <uid>] [--sealed-file [uid:]<path>] [--sealed-directory [uid:]<path>]");
}

async function main() {
  try {
    const result = assertSealedProductionRelease(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`sealed production release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
