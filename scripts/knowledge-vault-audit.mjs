#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectKnowledgeStorageDeclarations,
  knowledgeStorageMediaType,
  KNOWLEDGE_STORAGE_ALLOWED_CATEGORIES,
  validateKnowledgeStorageIntegrity,
} from "../packages/workbench-knowledge/src/storage-asset-policy.mjs";

export const DEFAULT_REQUIRED_FILES = [
  "README.md",
  "00-知识库使用规范/README.md",
  "00-知识库使用规范/Agent任务分类与补全规则.md",
  "00-知识库使用规范/知识分层与冲突裁决.md",
  "01-产品架构/产品能力地图.md",
  "02-业务域知识/活动发布与模板配置.md",
  "02-业务域知识/签到与任务积分活动.md",
  "02-业务域知识/奖品券与资损核销.md",
  "04-产品文档规范/PRD标准结构.md",
  "05-原型设计规范/原型生成总规则.md",
  "05-原型设计规范/签到活动高保真HTML原型框架.md",
  "06-历史案例库/案例复用索引.md",
  "07-来源资产索引/README.md",
  "99-收件箱/README.md",
];

const DEFAULT_UNREFERENCED_SAMPLE_LIMIT = 12;

export async function auditKnowledgeVault({
  vaultRoot = path.resolve(process.env.KNOWLEDGE_VAULT_ROOT || "knowledge-vault"),
  storageRoot = path.resolve(process.env.KNOWLEDGE_STORAGE_ROOT || "storage"),
  requiredFiles = DEFAULT_REQUIRED_FILES,
  unreferencedSampleLimit = DEFAULT_UNREFERENCED_SAMPLE_LIMIT,
} = {}) {
  const root = path.resolve(vaultRoot);
  const resolvedStorageRoot = path.resolve(storageRoot);
  const files = await collectMarkdown(root);
  const fileSet = new Set(files);
  const titleOwners = new Map();
  const errors = [];
  const warnings = [];
  const legacyMetadataGaps = [];
  const links = [];
  const internalPathFindings = [];
  const publicationStatusByFile = new Map();
  const documents = [];
  const tiers = {
    main: { files: 0, characters: 0 },
    source: { files: 0, characters: 0 },
    inbox: { files: 0, characters: 0 },
    template: { files: 0, characters: 0 },
  };

  for (const required of requiredFiles) {
    if (!fileSet.has(required)) errors.push(`缺少必备知识文件：${required}`);
  }

  for (const relativePath of files) {
    const raw = await readFile(path.join(root, relativePath), "utf8");
    const metadata = parseMarkdown(raw);
    const tier = knowledgeTier(relativePath);
    documents.push({ relativePath, raw, metadata });
    publicationStatusByFile.set(relativePath, isPublicationActive(metadata));
    tiers[tier].files += 1;
    tiers[tier].characters += metadata.body.length;

    if (!metadata.hasFrontmatter) errors.push(`缺少 frontmatter：${relativePath}`);
    if (!metadata.title) errors.push(`缺少 title：${relativePath}`);
    if (!metadata.description) {
      if (tier === "main" || tier === "template") errors.push(`缺少 description：${relativePath}`);
      else legacyMetadataGaps.push(relativePath);
    }
    if (!metadata.status) errors.push(`缺少 status：${relativePath}`);
    if (!metadata.tags.length) errors.push(`缺少 tags：${relativePath}`);

    if (metadata.title) {
      const owners = titleOwners.get(metadata.title) ?? [];
      owners.push(relativePath);
      titleOwners.set(metadata.title, owners);
    }

    if (metadata.body.trim().length < 100) warnings.push(`正文过短：${relativePath}`);
    if (metadata.body.length > 30_000) warnings.push(`单文件过长，建议拆成主题知识：${relativePath}`);

    const internalPathLines = findInternalAbsolutePathLines(raw);
    if (internalPathLines.length) {
      const publishable = tier === "main" && isPublicationActive(metadata);
      internalPathFindings.push({ file: relativePath, lines: internalPathLines, publishable });
      const message = `检测到本机绝对路径：${relativePath}（行 ${internalPathLines.join("、")}）`;
      if (publishable) errors.push(message);
      else warnings.push(`${message}；该文件不在发布快照中。`);
    }

    for (const match of metadata.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      links.push({ from: relativePath, to: match[1].trim() });
    }

    if (tier === "main") {
      const forbiddenHeadings = [
        /^(?:#{1,6}\s+)(?:\d+(?:\.\d+)*\s*)?本需求涉及新增\/修改的接口\s*$/m,
        /^(?:#{1,6}\s+)(?:知识库引用|模型与联网补齐说明|联网补齐证据)\s*$/m,
      ];
      if (forbiddenHeadings.some((pattern) => pattern.test(metadata.body))) {
        errors.push(`现行主知识包含禁止进入 PRD 的章节：${relativePath}`);
      }
    }
  }

  for (const [title, owners] of titleOwners) {
    if (owners.length > 1) errors.push(`标题重复「${title}」：${owners.join("、")}`);
  }

  if (legacyMetadataGaps.length) {
    warnings.push(`来源/收件箱有 ${legacyMetadataGaps.length} 个旧条目缺少 description；这些条目不参与正式生成，可在再次整理时补齐。`);
  }

  const linkTargets = new Set(files.map((file) => file.replace(/\.md$/, "")));
  for (const link of links) {
    if (linkTargets.has(link.to) || linkTargets.has(`${link.to}/README`)) continue;
    errors.push(`失效链接：${link.from} -> ${link.to}`);
  }

  const assetClosure = await auditAssetClosure({
    documents,
    storageRoot: resolvedStorageRoot,
    errors,
    warnings,
    unreferencedSampleLimit,
  });
  const indexedFiles = tiers.main.files + tiers.source.files;
  const publishedFiles = files.filter((relativePath) => {
    if (knowledgeTier(relativePath) !== "main") return false;
    return publicationStatusByFile.get(relativePath) === true
      && !internalPathFindings.some((finding) => finding.file === relativePath && finding.publishable);
  }).length;

  return {
    passed: errors.length === 0,
    root,
    storageRoot: resolvedStorageRoot,
    markdownFiles: files.length,
    indexedFiles,
    publishedFiles,
    excludedFiles: tiers.inbox.files + tiers.template.files,
    internalPathFindings,
    tiers,
    assetClosure,
    errors,
    warnings,
  };
}

async function auditAssetClosure({
  documents,
  storageRoot,
  errors,
  warnings,
  unreferencedSampleLimit,
}) {
  const declarations = collectKnowledgeStorageDeclarations(documents.map(({ relativePath, raw, metadata }) => ({
    relativePath,
    raw,
    header: metadata.header,
  })));
  const directoryReferences = [];
  const rejectedReferences = [...declarations.rejectedReferences];
  const storageBoundary = await resolveStorageBoundary(storageRoot, errors);

  for (const reference of rejectedReferences) {
    errors.push(`非法 storage 引用：${reference.file}:${reference.line} ${reference.raw}（${reference.reason}）`);
  }

  for (const reference of declarations.directoryReferences) {
    const directoryResult = await validateDirectoryReference({
      logicalPath: reference.path,
      storageRoot,
      storageBoundary,
    });
    const finding = { ...reference, ...directoryResult };
    directoryReferences.push(finding);
    if (!directoryResult.valid) {
      errors.push(`无效 storage 目录引用：${reference.file}:${reference.line} ${reference.path}（${directoryResult.reason}）`);
    }
  }

  for (const issue of declarations.issues) {
    if (issue.code === "INVALID_STORAGE_REFERENCE") continue;
    if (issue.code === "STORAGE_INTEGRITY_INVALID") {
      errors.push(`知识资产完整性声明格式错误：${issue.file}:${issue.line}（${issue.detail}）`);
    } else if (issue.code === "STORAGE_INTEGRITY_AMBIGUOUS") {
      errors.push(`无法确定完整性声明对应的知识资产：${issue.file}:${issue.line}`);
    } else if (issue.code === "STORAGE_INTEGRITY_CONFLICT") {
      errors.push(`知识资产完整性声明冲突：${issue.path}（${issue.detail}）`);
    }
  }

  const referencedAssets = [];
  const unresolvedAssets = [];
  for (const entry of declarations.assets) {
    const verified = await verifyReferencedAsset({ logicalPath: entry.path, storageRoot, storageBoundary });
    if (!verified.ok) {
      unresolvedAssets.push({
        path: entry.path,
        references: entry.references,
        reason: verified.reason,
      });
      errors.push(`知识资产不可用：${entry.path}（${verified.reason}）`);
      continue;
    }

    for (const issue of validateKnowledgeStorageIntegrity(entry, verified)) {
      if (issue.code === "STORAGE_CHECKSUM_MISMATCH") {
        errors.push(`知识资产 SHA-256 不匹配：${entry.path}，${issue.detail}`);
      } else if (issue.code === "STORAGE_BYTE_SIZE_MISMATCH") {
        errors.push(`知识资产 byteSize 不匹配：${entry.path}，${issue.detail}`);
      }
    }

    referencedAssets.push({
      path: entry.path,
      mediaType: knowledgeStorageMediaType(entry.path),
      byteSize: verified.byteSize,
      sha256: verified.sha256,
      symbolicLink: verified.symbolicLink,
      references: entry.references,
      declaredIntegrity: entry.declaredIntegrity,
    });
  }

  if (directoryReferences.length) {
    warnings.push(`检测到 ${directoryReferences.length} 个 storage 目录提及；目录不会自动扩展为迁移资产，只有明确引用的文件进入闭包。`);
  }

  const storageInventory = await inventoryStorage(storageRoot, errors, unreferencedSampleLimit, new Set(
    referencedAssets.map((asset) => asset.path),
  ));
  return {
    policy: {
      allowedCategories: [...KNOWLEDGE_STORAGE_ALLOWED_CATEGORIES].sort(),
      directoryReferencesExpand: false,
      declaredIntegrityRequiredToMatch: true,
    },
    referencedAssetCount: referencedAssets.length,
    referencedBytes: referencedAssets.reduce((total, asset) => total + asset.byteSize, 0),
    referencedAssets,
    directoryReferences: directoryReferences.sort(compareSourceLocations),
    rejectedReferences: rejectedReferences.sort(compareSourceLocations),
    unresolvedAssets,
    unreferencedStorage: storageInventory,
  };
}

async function resolveStorageBoundary(storageRoot, errors) {
  try {
    const canonicalRoot = await realpath(storageRoot);
    return { canonicalRoot };
  } catch (error) {
    errors.push(`storage 根目录不可用：${storageRoot}（${errorMessage(error)}）`);
    return { canonicalRoot: null };
  }
}

async function validateDirectoryReference({ logicalPath, storageRoot, storageBoundary }) {
  const relativePath = logicalPath === "storage" ? "" : logicalPath.slice("storage/".length);
  const absolutePath = path.resolve(storageRoot, relativePath);
  try {
    const info = await lstat(absolutePath);
    const canonicalPath = await realpath(absolutePath);
    if (!info.isDirectory()) return { valid: false, reason: "目标不是目录" };
    if (!isInside(storageBoundary.canonicalRoot, canonicalPath)) {
      return { valid: false, reason: "符号链接逃逸 storage 根目录" };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `目录缺失或不可读：${errorMessage(error)}` };
  }
}

async function verifyReferencedAsset({ logicalPath, storageRoot, storageBoundary }) {
  const relativePath = logicalPath.slice("storage/".length);
  const category = relativePath.split("/")[0];
  const categoryRoot = path.resolve(storageRoot, category);
  const absolutePath = path.resolve(storageRoot, relativePath);
  if (!isInside(categoryRoot, absolutePath)) return { ok: false, reason: "路径越过允许的 storage 分类" };
  try {
    const linkInfo = await lstat(absolutePath);
    const canonicalPath = await realpath(absolutePath);
    let canonicalCategoryRoot;
    try {
      canonicalCategoryRoot = await realpath(categoryRoot);
    } catch (error) {
      return { ok: false, reason: `允许目录不可用：${errorMessage(error)}` };
    }
    if (!isInside(storageBoundary.canonicalRoot, canonicalPath) || !isInside(canonicalCategoryRoot, canonicalPath)) {
      return { ok: false, reason: "符号链接逃逸允许的 storage 分类" };
    }
    const targetInfo = await lstat(canonicalPath);
    if (!targetInfo.isFile()) return { ok: false, reason: "目标不是普通文件" };
    return {
      ok: true,
      byteSize: targetInfo.size,
      sha256: await sha256File(canonicalPath),
      symbolicLink: linkInfo.isSymbolicLink(),
    };
  } catch (error) {
    return { ok: false, reason: `文件缺失或不可读：${errorMessage(error)}` };
  }
}

async function inventoryStorage(storageRoot, errors, sampleLimit, referencedPaths) {
  const summaries = new Map();
  let entries;
  try {
    entries = await readdir(storageRoot, { withFileTypes: true });
  } catch (error) {
    errors.push(`无法汇总 storage：${storageRoot}（${errorMessage(error)}）`);
    return { totalFiles: 0, totalBytes: 0, unreferencedFiles: 0, unreferencedBytes: 0, byTopLevel: [] };
  }

  for (const entry of entries) ensureStorageSummary(summaries, entry.name);
  const inventory = await collectStorageFiles(storageRoot);
  for (const item of inventory) {
    const category = item.relativePath.split("/")[0];
    const summary = ensureStorageSummary(summaries, category);
    summary.files += 1;
    summary.bytes += item.byteSize;
    if (item.symbolicLink) summary.symbolicLinks += 1;
    const logicalPath = `storage/${item.relativePath}`;
    if (referencedPaths.has(logicalPath)) {
      summary.referencedFiles += 1;
      summary.referencedBytes += item.byteSize;
    } else {
      summary.unreferencedFiles += 1;
      summary.unreferencedBytes += item.byteSize;
      if (summary.sampleUnreferenced.length < sampleLimit) summary.sampleUnreferenced.push(logicalPath);
    }
  }

  const byTopLevel = [...summaries.values()].sort((a, b) => a.category.localeCompare(b.category, "zh-Hans-CN"));
  return {
    totalFiles: byTopLevel.reduce((total, item) => total + item.files, 0),
    totalBytes: byTopLevel.reduce((total, item) => total + item.bytes, 0),
    unreferencedFiles: byTopLevel.reduce((total, item) => total + item.unreferencedFiles, 0),
    unreferencedBytes: byTopLevel.reduce((total, item) => total + item.unreferencedBytes, 0),
    byTopLevel,
  };
}

function ensureStorageSummary(summaries, category) {
  const existing = summaries.get(category);
  if (existing) return existing;
  const created = {
    category,
    allowedForKnowledgeClosure: KNOWLEDGE_STORAGE_ALLOWED_CATEGORIES.includes(category),
    files: 0,
    bytes: 0,
    referencedFiles: 0,
    referencedBytes: 0,
    unreferencedFiles: 0,
    unreferencedBytes: 0,
    symbolicLinks: 0,
    sampleUnreferenced: [],
  };
  summaries.set(category, created);
  return created;
}

async function collectStorageFiles(directory, base = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))) {
    const relativePath = path.posix.join(base, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectStorageFiles(absolutePath, relativePath));
      continue;
    }
    const info = await lstat(absolutePath);
    result.push({ relativePath, byteSize: info.size, symbolicLink: info.isSymbolicLink() });
  }
  return result;
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

async function collectMarkdown(directory, base = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = path.posix.join(base, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectMarkdown(absolutePath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(relativePath);
    }
  }
  return result.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function parseMarkdown(raw) {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const header = frontmatter?.[1] ?? "";
  const tagBlock = header.match(/^tags:\s*\r?\n((?:\s+-\s*.+\r?\n?)+)/m)?.[1] ?? "";
  return {
    hasFrontmatter: Boolean(frontmatter),
    header,
    title: header.match(/^title:\s*(.+)$/m)?.[1]?.trim(),
    description: header.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
    status: header.match(/^status:\s*(.+)$/m)?.[1]?.trim(),
    draft: parseBoolean(header.match(/^draft:\s*(.+)$/m)?.[1]?.trim()),
    tags: [...tagBlock.matchAll(/^\s+-\s*(.+)$/gm)].map((match) => match[1].trim()),
    body: frontmatter ? raw.slice(frontmatter[0].length).trim() : raw.trim(),
  };
}

function isPublicationActive(metadata) {
  if (metadata.draft === true) return false;
  const status = metadata.status?.replace(/^['"]|['"]$/g, "").trim().toLowerCase();
  if (!status) return false;
  return !/^(?:draft|草稿|待审核|待发布|未发布|待整理|disabled|inactive|停用|已停用|禁用|已禁用|不参与检索|archived|archive|归档|已归档)$/.test(status);
}

function parseBoolean(value) {
  if (!value) return undefined;
  if (/^(?:true|yes|1|是)$/i.test(value)) return true;
  if (/^(?:false|no|0|否)$/i.test(value)) return false;
  return undefined;
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

function knowledgeTier(relativePath) {
  if (relativePath.startsWith("07-来源资产索引/")) return "source";
  if (relativePath.startsWith("99-收件箱/")) return "inbox";
  if (relativePath.startsWith("_templates/")) return "template";
  return "main";
}

function isInside(parentPath, candidatePath) {
  if (!parentPath) return false;
  const relative = path.relative(parentPath, candidatePath);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function compareSourceLocations(a, b) {
  return a.file.localeCompare(b.file, "zh-Hans-CN") || a.line - b.line;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runCli() {
  try {
    const report = await auditKnowledgeVault();
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({
      passed: false,
      root: path.resolve(process.env.KNOWLEDGE_VAULT_ROOT || "knowledge-vault"),
      storageRoot: path.resolve(process.env.KNOWLEDGE_STORAGE_ROOT || "storage"),
      errors: [`知识库审计执行失败：${errorMessage(error)}`],
      warnings: [],
    }, null, 2));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await runCli();
