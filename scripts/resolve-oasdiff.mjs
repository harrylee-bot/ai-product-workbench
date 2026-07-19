#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OASDIFF_VERSION = "v1.23.0";

const RELEASE_ROOT = `https://github.com/oasdiff/oasdiff/releases/download/${OASDIFF_VERSION}`;
const ARTIFACTS = Object.freeze({
  "darwin-arm64": Object.freeze({
    file: "oasdiff_1.23.0_darwin_all.tar.gz",
    sha256: "85598e5b1c756bba9e8d3cda776b91de0cbe5e2c62fda65d36312febed7f9d13",
  }),
  "darwin-x64": Object.freeze({
    file: "oasdiff_1.23.0_darwin_all.tar.gz",
    sha256: "85598e5b1c756bba9e8d3cda776b91de0cbe5e2c62fda65d36312febed7f9d13",
  }),
  "linux-arm64": Object.freeze({
    file: "oasdiff_1.23.0_linux_arm64.tar.gz",
    sha256: "dcb5fdf425b4dbf401f2d41befebda6580f5d97ef4acc270006314addc817e2e",
  }),
  "linux-x64": Object.freeze({
    file: "oasdiff_1.23.0_linux_amd64.tar.gz",
    sha256: "972b10535c3db4366b9dc3ebc11ca021279af3095267c3cffdca854a3a3c4f89",
  }),
});

export function artifactFor(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const artifact = ARTIFACTS[key];
  if (!artifact) {
    throw new Error(`oasdiff ${OASDIFF_VERSION} has no approved artifact for ${key}`);
  }
  return { ...artifact, url: `${RELEASE_ROOT}/${artifact.file}` };
}

export function acceptedVersionOutput(output) {
  const normalized = String(output).trim();
  return normalized === `oasdiff version ${OASDIFF_VERSION}`
    || normalized === `oasdiff version ${OASDIFF_VERSION.slice(1)}`;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function verifyBinary(binaryPath) {
  const result = spawnSync(binaryPath, ["-v"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0 || !acceptedVersionOutput(output)) {
    throw new Error(
      `oasdiff version mismatch at ${binaryPath}: expected ${OASDIFF_VERSION}, got ${output || result.error?.message || `exit ${result.status}`}`,
    );
  }
}

async function regularFileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function downloadVerifiedArchive({ artifact, archivePath, fetchImpl }) {
  const temporaryPath = `${archivePath}.partial`;
  let preservePartial = false;
  try {
    if (fetchImpl) {
      const response = await fetchImpl(artifact.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
      await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    } else {
      if (await regularFileExists(temporaryPath)) {
        const partialStat = await stat(temporaryPath);
        if (partialStat.size > 32 * 1024 * 1024) await unlink(temporaryPath);
        else if (partialStat.size > 0 && await sha256File(temporaryPath) === artifact.sha256) {
          await rename(temporaryPath, archivePath);
          return;
        }
      }
      const result = spawnSync("curl", [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--retry",
        "5",
        "--retry-all-errors",
        "--retry-delay",
        "2",
        "--connect-timeout",
        "15",
        "--max-time",
        "600",
        "--continue-at",
        "-",
        "--output",
        temporaryPath,
        artifact.url,
      ], { encoding: "utf8", timeout: 610_000 });
      if (result.error || result.status !== 0) {
        preservePartial = true;
        throw new Error(`${result.stderr ?? ""}${result.stdout ?? ""}`.trim() || result.error?.message || `curl exit ${result.status}`);
      }
    }
    const archiveStat = await stat(temporaryPath);
    if (!archiveStat.isFile() || archiveStat.size === 0 || archiveStat.size > 32 * 1024 * 1024) {
      throw new Error(`download size ${archiveStat.size} is outside the approved range`);
    }
    const digest = await sha256File(temporaryPath);
    if (digest !== artifact.sha256) {
      throw new Error(`archive SHA-256 mismatch: expected ${artifact.sha256}, got ${digest}`);
    }
    await rename(temporaryPath, archivePath);
  } catch (error) {
    if (!preservePartial) await rm(temporaryPath, { force: true });
    throw new Error(`unable to install pinned oasdiff artifact ${artifact.url}: ${error.message}`, { cause: error });
  }
}

async function ensureVerifiedArchive({ artifact, archivePath, fetchImpl }) {
  if (await regularFileExists(archivePath)) {
    const digest = await sha256File(archivePath);
    if (digest === artifact.sha256) return;
    await unlink(archivePath);
  }
  await downloadVerifiedArchive({ artifact, archivePath, fetchImpl });
}

function extractArchive(archivePath, extractDirectory) {
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractDirectory], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    throw new Error(`failed to extract pinned oasdiff archive: ${detail || result.error?.message || `exit ${result.status}`}`);
  }
}

export async function resolveOasdiff({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  fetchImpl,
  artifact: suppliedArtifact,
} = {}) {
  const explicitBinary = env.WORKBENCH_OASDIFF_BIN?.trim();
  if (explicitBinary) {
    verifyBinary(explicitBinary);
    return path.resolve(explicitBinary);
  }
  if (fetchImpl !== undefined && typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function when supplied");
  }

  const artifact = suppliedArtifact ?? artifactFor(platform, arch);
  if (
    path.basename(artifact.file) !== artifact.file
    || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    || !String(artifact.url).startsWith("https://")
  ) {
    throw new Error("oasdiff artifact descriptor is invalid");
  }
  const defaultCacheRoot = path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "workbench", "tools");
  const cacheRoot = path.resolve(env.WORKBENCH_TOOL_CACHE_DIR || defaultCacheRoot);
  const versionDirectory = path.join(cacheRoot, "oasdiff", OASDIFF_VERSION);
  const archivePath = path.join(versionDirectory, artifact.file);
  const binaryPath = path.join(versionDirectory, "oasdiff");
  await mkdir(versionDirectory, { recursive: true, mode: 0o700 });
  await ensureVerifiedArchive({ artifact, archivePath, fetchImpl });

  const extractDirectory = await mkdtemp(path.join(versionDirectory, ".extract-"));
  const temporaryBinary = `${binaryPath}.install-${process.pid}-${randomUUID()}`;
  try {
    extractArchive(archivePath, extractDirectory);
    const extractedBinary = path.join(extractDirectory, "oasdiff");
    if (!(await regularFileExists(extractedBinary))) {
      throw new Error("pinned oasdiff archive does not contain the expected binary");
    }
    await chmod(extractedBinary, 0o755);
    verifyBinary(extractedBinary);
    const expectedBinarySha256 = await sha256File(extractedBinary);

    if (await regularFileExists(binaryPath)) {
      const installedSha256 = await sha256File(binaryPath);
      if (installedSha256 === expectedBinarySha256) {
        verifyBinary(binaryPath);
        return binaryPath;
      }
    }

    await copyFile(extractedBinary, temporaryBinary);
    await chmod(temporaryBinary, 0o755);
    await rename(temporaryBinary, binaryPath);
    verifyBinary(binaryPath);
    return binaryPath;
  } finally {
    await rm(temporaryBinary, { force: true });
    await rm(extractDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.length > 2 && process.argv[2] !== "--print") {
    throw new Error("Usage: resolve-oasdiff.mjs [--print]");
  }
  process.stdout.write(`${await resolveOasdiff()}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`oasdiff resolver: ${error.message}\n`);
    process.exitCode = 69;
  });
}
