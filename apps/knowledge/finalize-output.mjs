#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readlink,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const PUBLISH_ROOTS = [
  "00-知识库使用规范",
  "01-产品架构",
  "02-业务域知识",
  "03-产品进化规划",
  "04-产品文档规范",
  "05-原型设计规范",
  "06-历史案例库",
];

if (process.argv[2] === "run") {
  const cwd = path.resolve(process.argv[3] || ".");
  const command = process.argv[4];
  const args = process.argv.slice(5);
  if (!command) throw new Error("Process command is required");
  process.exitCode = await runProcessGroup(cwd, command, args);
} else if (process.argv[2] === "activate") {
  const generationRoot = path.resolve(process.argv[3] || "");
  const outputRoot = path.resolve(process.argv[4] || process.env.QUARTZ_OUTPUT_DIR || "public");
  const generationPrefix = path.resolve(process.argv[5] || `${outputRoot}.generation`);
  const report = await activateGeneratedOutput(generationRoot, outputRoot, generationPrefix);
  console.log(JSON.stringify(report));
} else if (process.argv[2] === "prepare") {
  const sourceRoot = path.resolve(process.argv[3] || process.env.QUARTZ_CONTENT_DIR || "/vault");
  const outputRoot = path.resolve(process.argv[4] || process.env.QUARTZ_BUILD_CONTENT_DIR || "/tmp/quartz-content");
  const report = await preparePublishedContent(sourceRoot, outputRoot);
  console.log(JSON.stringify(report));
} else {
  const outputRoot = path.resolve(process.argv[2] || process.env.QUARTZ_OUTPUT_DIR || "public");
  const basePath = resolveBasePath(process.argv[3] || process.env.QUARTZ_BASE_URL || "");
  const report = await finalizeGeneratedOutput(outputRoot, basePath);
  console.log(JSON.stringify(report));
}

async function runProcessGroup(cwd, command, args) {
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  let forcedKillTimer;
  const forwardSignal = (signal) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    forcedKillTimer ??= setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process group has already exited.
      }
    }, 5_000);
    forcedKillTimer.unref();
  };
  const onTerm = () => forwardSignal("SIGTERM");
  const onInt = () => forwardSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  if (forcedKillTimer) clearTimeout(forcedKillTimer);
  if (result.code !== null) return result.code;
  return result.signal === "SIGINT" ? 130 : 143;
}

async function activateGeneratedOutput(generationRoot, outputRoot, generationPrefix) {
  if (generationRoot === outputRoot) throw new Error("Generation and output paths must be different");
  if (!await fileExists(path.join(generationRoot, "__health"))) {
    throw new Error(`Generation is missing __health: ${generationRoot}`);
  }
  if (!(await collectHtmlFiles(generationRoot)).length) {
    throw new Error(`Generation has no HTML files: ${generationRoot}`);
  }

  await mkdir(path.dirname(outputRoot), { recursive: true });
  const temporaryLink = `${outputRoot}.link-${process.pid}`;
  const legacyRoot = `${outputRoot}.legacy-${process.pid}`;
  await rm(temporaryLink, { recursive: true, force: true });
  await rm(legacyRoot, { recursive: true, force: true });

  const relativeTarget = path.relative(path.dirname(outputRoot), generationRoot) || ".";
  await symlink(relativeTarget, temporaryLink, "dir");
  let previousRoot;
  let migratedLegacyDirectory = false;

  try {
    const outputStat = await lstat(outputRoot).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (outputStat?.isSymbolicLink()) {
      const target = await readlink(outputRoot);
      previousRoot = path.resolve(path.dirname(outputRoot), target);
    } else if (outputStat) {
      await rename(outputRoot, legacyRoot);
      previousRoot = legacyRoot;
      migratedLegacyDirectory = true;
    }

    await rename(temporaryLink, outputRoot);
  } catch (error) {
    await rm(temporaryLink, { recursive: true, force: true });
    if (migratedLegacyDirectory && !await pathExists(outputRoot)) {
      await rename(legacyRoot, outputRoot).catch(() => undefined);
    }
    throw error;
  }

  let cleanupWarning;
  try {
    await cleanupManagedGenerations(
      outputRoot,
      generationPrefix,
      new Set([generationRoot, previousRoot].filter(Boolean)),
    );
  } catch (error) {
    cleanupWarning = error instanceof Error ? error.message : String(error);
  }

  return {
    operation: "activate",
    generationRoot,
    generationPrefix,
    outputRoot,
    previousRoot,
    atomic: !migratedLegacyDirectory,
    cleanupWarning,
  };
}

async function cleanupManagedGenerations(outputRoot, generationPrefix, retainedRoots) {
  const parents = new Set([path.dirname(outputRoot), path.dirname(generationPrefix)]);
  for (const parent of parents) {
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(parent, entry.name);
      if (retainedRoots.has(candidate)
        || !isManagedGeneration(candidate, outputRoot, generationPrefix)) continue;
      await rm(candidate, { recursive: true, force: true });
    }
  }
}

function isManagedGeneration(candidate, outputRoot, generationPrefix) {
  if (candidate.startsWith(`${generationPrefix}.`)) return true;
  if (path.dirname(candidate) !== path.dirname(outputRoot)) return false;
  const outputName = path.basename(outputRoot);
  const candidateName = path.basename(candidate);
  return candidateName.startsWith(`${outputName}.generation.`)
    || candidateName.startsWith(`${outputName}.generation-`)
    || candidateName.startsWith(`${outputName}.next.`)
    || candidateName.startsWith(`${outputName}.next-`)
    || candidateName.startsWith(`${outputName}.legacy-`);
}

async function preparePublishedContent(sourceRoot, outputRoot) {
  const nextRoot = `${outputRoot}.next-${process.pid}`;
  let stopping = false;
  const stop = (exitCode) => {
    if (stopping) return;
    stopping = true;
    void rm(nextRoot, { recursive: true, force: true }).finally(() => process.exit(exitCode));
  };
  const onTerm = () => stop(143);
  const onInt = () => stop(130);
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  await rm(nextRoot, { recursive: true, force: true });
  await mkdir(nextRoot, { recursive: true });

  const candidates = [
    "README.md",
    ...await collectAllowedMarkdown(sourceRoot),
  ];
  const uniqueCandidates = [...new Set(candidates)];
  const sourceSnapshot = new Map();
  const generation = createHash("sha256");
  let published = 0;
  let excludedByStatus = 0;

  try {
    for (const relativePath of uniqueCandidates) {
      const sourcePath = path.join(sourceRoot, relativePath);
      const raw = await readFile(sourcePath, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
      if (raw === undefined) continue;
      sourceSnapshot.set(relativePath, raw);

      const metadata = parsePublicationMetadata(raw, relativePath);
      if (!metadata.active) {
        excludedByStatus += 1;
        continue;
      }
      const internalPathLines = findInternalAbsolutePathLines(raw);
      if (internalPathLines.length) {
        throw new Error(
          `Refusing to publish ${relativePath}: internal absolute path on line(s) ${internalPathLines.join(", ")}`,
        );
      }

      const targetPath = path.join(nextRoot, relativePath);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, raw, "utf8");
      generation.update(relativePath);
      generation.update("\0");
      generation.update(raw);
      generation.update("\0");
      published += 1;
    }

    if (!published || !await fileExists(path.join(nextRoot, "README.md"))) {
      throw new Error("Published knowledge snapshot must contain an active README.md");
    }
    await assertSourceSnapshotStable(sourceRoot, uniqueCandidates, sourceSnapshot);
    await writeFile(path.join(nextRoot, ".publish-generation"), `${generation.digest("hex")}\n`, "utf8");
    await rm(outputRoot, { recursive: true, force: true });
    await rename(nextRoot, outputRoot);
  } catch (error) {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    await rm(nextRoot, { recursive: true, force: true });
    throw error;
  }
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);

  return {
    operation: "prepare",
    sourceRoot,
    outputRoot,
    published,
    excludedByStatus,
  };
}

async function assertSourceSnapshotStable(sourceRoot, expectedCandidates, expectedContent) {
  const currentCandidates = [...new Set(["README.md", ...await collectAllowedMarkdown(sourceRoot)])];
  if (currentCandidates.length !== expectedCandidates.length
    || currentCandidates.some((item, index) => item !== expectedCandidates[index])) {
    throw new Error("Knowledge source changed while the publish snapshot was being prepared; retry the build");
  }
  for (const [relativePath, expected] of expectedContent) {
    const current = await readFile(path.join(sourceRoot, relativePath), "utf8").catch(() => undefined);
    if (current !== expected) {
      throw new Error(`Knowledge source changed while reading ${relativePath}; retry the build`);
    }
  }
}

async function finalizeGeneratedOutput(outputRoot, basePath) {
  const htmlFiles = await collectHtmlFiles(outputRoot);
  if (!htmlFiles.length) {
    throw new Error(`No generated HTML files found under ${outputRoot}`);
  }

  let updated = 0;
  let redirects = 0;
  for (const filePath of htmlFiles) {
    const raw = await readFile(filePath, "utf8");
    if (!/<body\b/i.test(raw)) {
      redirects += 1;
      continue;
    }
    const next = injectBasePath(raw, basePath);
    if (next === raw) continue;
    await writeFile(filePath, next, "utf8");
    updated += 1;
  }

  return { operation: "finalize", outputRoot, basePath, htmlFiles: htmlFiles.length, updated, redirects };
}

async function collectAllowedMarkdown(sourceRoot) {
  const files = [];
  for (const rootName of PUBLISH_ROOTS) {
    files.push(...await collectMarkdownFiles(path.join(sourceRoot, rootName), sourceRoot));
  }
  return files.sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

async function collectMarkdownFiles(directory, sourceRoot) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(absolutePath, sourceRoot));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.relative(sourceRoot, absolutePath).split(path.sep).join("/"));
    }
  }
  return files;
}

function parsePublicationMetadata(raw, relativePath) {
  const normalized = raw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)(?:\n|$)/);
  if (!frontmatter) throw new Error(`Refusing to publish ${relativePath}: frontmatter is required`);

  const properties = new Map();
  for (const [index, line] of frontmatter[1].split("\n").entries()) {
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s+/.test(line)) continue;
    const property = line.match(/^([\p{L}\p{N}_-]+):(?:\s*(.*))?$/u);
    if (!property) throw new Error(`${relativePath} has invalid frontmatter on line ${index + 2}`);
    if (properties.has(property[1])) throw new Error(`${relativePath} has duplicate frontmatter key ${property[1]}`);
    properties.set(property[1], parseSimpleScalar(property[2] ?? "", relativePath, index + 2));
  }

  const draft = properties.get("draft");
  if (draft !== undefined) {
    if (draft === true || /^(?:true|yes|1|是)$/i.test(String(draft))) return { active: false };
    if (draft !== false && !/^(?:false|no|0|否)$/i.test(String(draft))) {
      throw new Error(`Refusing to publish ${relativePath}: frontmatter draft must be a boolean`);
    }
  }
  const rawStatus = properties.get("status") ?? properties.get("状态");
  if (rawStatus === undefined) {
    throw new Error(`Refusing to publish ${relativePath}: frontmatter status is required`);
  }
  if (typeof rawStatus !== "string" || /[\[\]{}]/.test(rawStatus)) {
    throw new Error(`Refusing to publish ${relativePath}: frontmatter status must be a scalar`);
  }
  const status = rawStatus.trim().toLowerCase();
  if (!status) throw new Error(`Refusing to publish ${relativePath}: frontmatter status is required`);
  const inactive = /^(?:draft|草稿|待审核|待发布|未发布|待整理|disabled|inactive|停用|已停用|禁用|已禁用|不参与检索|archived|archive|归档|已归档)$/.test(status);
  return { active: !inactive };
}

function parseSimpleScalar(raw, relativePath, lineNumber) {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith("\"") || value.startsWith("'")) {
    if (value.at(-1) !== value[0]) throw new Error(`${relativePath} has an unterminated quote on line ${lineNumber}`);
    if (value[0] === "'") return value.slice(1, -1).replaceAll("''", "'");
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${relativePath} has an invalid quoted value on line ${lineNumber}`);
    }
  }
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  if (/^(?:true|false)$/i.test(withoutComment)) return withoutComment.toLowerCase() === "true";
  return withoutComment;
}

function findInternalAbsolutePathLines(raw) {
  const patterns = [
    /(?:^|[\s(`'"：])\/(?:Users|home|private|tmp|Volumes|var\/(?:folders|tmp))\/[\w./~@%+,:=\-\u4e00-\u9fff]+/,
    /(?:^|[\s(`'"：])[A-Za-z]:\\[^\s)`'"，。]+/,
    /\bfile:\/\/[^\s)`'"，。]+/i,
  ];
  const lines = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (patterns.some((pattern) => pattern.test(line))) lines.push(index + 1);
  }
  return lines;
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectHtmlFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(absolutePath);
    }
  }
  return files;
}

function resolveBasePath(value) {
  const raw = value.trim();
  if (!raw) return "";

  let pathname;
  if (raw.startsWith("/")) {
    pathname = raw;
  } else {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    pathname = url.pathname;
  }

  const normalized = `/${pathname.split("/").filter(Boolean).join("/")}`;
  return normalized === "/" ? "" : normalized;
}

function injectBasePath(html, value) {
  const body = html.match(/<body\b([^>]*)>/i);
  if (!body) throw new Error("Generated HTML is missing a body element");

  const escaped = escapeAttribute(value);
  const attributes = body[1] || "";
  const nextAttributes = /\sdata-basepath=(?:"[^"]*"|'[^']*')/i.test(attributes)
    ? attributes.replace(/\sdata-basepath=(?:"[^"]*"|'[^']*')/i, ` data-basepath="${escaped}"`)
    : `${attributes} data-basepath="${escaped}"`;
  return html.replace(body[0], `<body${nextAttributes}>`);
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
