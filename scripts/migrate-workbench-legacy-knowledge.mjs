#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT_DATE = "2026-07-16";
const DEFAULT_INPUT_ROOT = "/tmp/workbench-knowledge-preservation-20260716";
const DEFAULT_VAULT_DIRECTORY = "knowledge-vault/07-来源资产索引/旧版整理/05-旧数据库知识库";
const DEFAULT_ARCHIVE_DIRECTORY = "storage/source-assets/legacy-knowledge-20260716";
const ITEM_INDEX_PAGE_SIZE = 100;

const CATEGORY_FIELDS = [
  "id",
  "name",
  "order",
  "parentId",
  "createdAt",
  "updatedAt",
  "description",
];
const ITEM_FIELDS = [
  "id",
  "tags",
  "type",
  "scope",
  "title",
  "source",
  "status",
  "content",
  "summary",
  "priority",
  "createdAt",
  "updatedAt",
  "categoryId",
];
const VERSION_FIELDS = [
  "id",
  "version",
  "snapshot",
  "createdAt",
  "changeSummary",
  "knowledgeItemId",
];
const SNAPSHOT_FIELDS = [
  "id",
  "tags",
  "type",
  "scope",
  "title",
  "source",
  "status",
  "content",
  "summary",
  "priority",
  "categoryId",
];

export async function migrateLegacyKnowledge({
  inputRoot = DEFAULT_INPUT_ROOT,
  projectRoot = process.cwd(),
  vaultDirectory = DEFAULT_VAULT_DIRECTORY,
  archiveDirectory = DEFAULT_ARCHIVE_DIRECTORY,
  check = false,
} = {}) {
  const resolvedInputRoot = path.resolve(inputRoot);
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedVaultDirectory = path.resolve(resolvedProjectRoot, vaultDirectory);
  const resolvedArchiveDirectory = path.resolve(resolvedProjectRoot, archiveDirectory);

  const [rawCategories, rawItems, rawVersions] = await Promise.all([
    readNdjson(path.join(resolvedInputRoot, "knowledge-categories.ndjson")),
    readNdjson(path.join(resolvedInputRoot, "knowledge-items.ndjson")),
    readNdjson(path.join(resolvedInputRoot, "knowledge-versions.ndjson")),
  ]);

  const categories = rawCategories
    .map((value, index) => sanitizeCategory(value, index + 1))
    .sort((left, right) => numberCompare(left.order, right.order) || codePointCompare(left.id, right.id));
  const items = rawItems
    .map((value, index) => sanitizeItem(value, index + 1))
    .sort((left, right) => codePointCompare(left.id, right.id));
  const versions = rawVersions
    .map((value, index) => sanitizeVersion(value, index + 1))
    .sort((left, right) =>
      codePointCompare(left.knowledgeItemId, right.knowledgeItemId)
      || numberCompare(left.version, right.version)
      || codePointCompare(left.id, right.id));

  validateDataset(categories, items, versions);

  const archiveFiles = new Map([
    ["knowledge-categories.ndjson", serializeNdjson(categories)],
    ["knowledge-items.ndjson", serializeNdjson(items)],
    ["knowledge-versions.ndjson", serializeNdjson(versions)],
  ]);
  const archiveMetadata = new Map([...archiveFiles].map(([name, content]) => [name, fileMetadata(content)]));
  const archiveReadme = renderArchiveReadme({ categories, items, versions, archiveMetadata });
  archiveFiles.set("README.md", archiveReadme);
  archiveMetadata.set("README.md", fileMetadata(archiveReadme));
  const checksums = [...archiveMetadata]
    .sort(([left], [right]) => codePointCompare(left, right))
    .map(([name, metadata]) => `${metadata.sha256}  ${name}`)
    .join("\n") + "\n";
  archiveFiles.set("SHA256SUMS", checksums);
  archiveMetadata.set("SHA256SUMS", fileMetadata(checksums));

  const versionsByItemId = groupBy(versions, (version) => version.knowledgeItemId);
  const itemsByCategoryId = groupBy(items, (item) => item.categoryId);
  const vaultFiles = new Map();
  const itemPaths = new Map();
  const categoryPaths = new Map();

  for (const [index, category] of categories.entries()) {
    const categoryDirectory = `${String(index + 1).padStart(2, "0")}-${fileSegment(category.name, 48)}-${shortId(category.id)}`;
    categoryPaths.set(category.id, categoryDirectory);
    for (const item of itemsByCategoryId.get(category.id) ?? []) {
      const relativePath = `${categoryDirectory}/${fileSegment(item.title, 72)}--${shortId(item.id)}.md`;
      if ([...itemPaths.values()].includes(relativePath)) {
        throw new Error(`生成的知识条目路径冲突：${relativePath}`);
      }
      itemPaths.set(item.id, relativePath);
    }
  }

  const archiveLogicalDirectory = toPosix(path.relative(resolvedProjectRoot, resolvedArchiveDirectory));
  for (const category of categories) {
    const categoryItems = itemsByCategoryId.get(category.id) ?? [];
    const categoryDirectory = categoryPaths.get(category.id);
    const indexPages = categoryItems.length > ITEM_INDEX_PAGE_SIZE
      ? chunks(categoryItems, ITEM_INDEX_PAGE_SIZE).map((pageItems, pageIndex, pages) => {
          const filename = `index-${String(pageIndex + 1).padStart(3, "0")}.md`;
          vaultFiles.set(
            `${categoryDirectory}/${filename}`,
            renderItemIndexPage({
              category,
              items: pageItems,
              itemPaths,
              archiveLogicalDirectory,
              page: pageIndex + 1,
              pages: pages.length,
            }),
          );
          return { filename, items: pageItems };
        })
      : [];
    vaultFiles.set(
      `${categoryDirectory}/README.md`,
      renderCategoryIndex({
        category,
        items: categoryItems,
        itemPaths,
        archiveLogicalDirectory,
        indexPages,
      }),
    );
    for (const item of categoryItems) {
      vaultFiles.set(
        itemPaths.get(item.id),
        renderKnowledgeItem({
          item,
          category,
          versions: versionsByItemId.get(item.id) ?? [],
          archiveLogicalDirectory,
        }),
      );
    }
  }

  vaultFiles.set("README.md", renderVaultIndex({
    categories,
    items,
    versions,
    itemsByCategoryId,
    categoryPaths,
    archiveLogicalDirectory,
    archiveMetadata,
  }));

  const expectedWrites = [
    ...[...archiveFiles].map(([relativePath, content]) => ({
      absolutePath: path.join(resolvedArchiveDirectory, relativePath),
      content,
    })),
    ...[...vaultFiles].map(([relativePath, content]) => ({
      absolutePath: path.join(resolvedVaultDirectory, relativePath),
      content,
    })),
  ];

  const changedFiles = [];
  const mismatches = [];
  for (const expected of expectedWrites.sort((left, right) => codePointCompare(left.absolutePath, right.absolutePath))) {
    const state = await ensureFile(expected.absolutePath, expected.content, { check });
    if (state === "changed") changedFiles.push(toPosix(path.relative(resolvedProjectRoot, expected.absolutePath)));
    if (state === "mismatch") mismatches.push(toPosix(path.relative(resolvedProjectRoot, expected.absolutePath)));
  }
  if (mismatches.length > 0) {
    throw new Error(`知识库迁移产物不是最新确定性输出：\n${mismatches.map((entry) => `- ${entry}`).join("\n")}`);
  }

  return {
    snapshotDate: SNAPSHOT_DATE,
    categories: categories.length,
    items: items.length,
    activeItems: items.filter((item) => item.status === "active").length,
    archivedItems: items.filter((item) => item.status === "archived").length,
    versions: versions.length,
    itemMarkdownFiles: itemPaths.size,
    indexMarkdownFiles: vaultFiles.size - itemPaths.size,
    archiveFiles: archiveFiles.size,
    changedFiles,
    checked: check,
    vaultDirectory: toPosix(path.relative(resolvedProjectRoot, resolvedVaultDirectory)),
    archiveDirectory: archiveLogicalDirectory,
  };
}

function sanitizeCategory(value, lineNumber) {
  assertRecord(value, `knowledge-categories.ndjson:${lineNumber}`);
  const category = projectFields(value, CATEGORY_FIELDS);
  requireNonEmptyString(category.id, `knowledge-categories.ndjson:${lineNumber}.id`);
  requireNonEmptyString(category.name, `knowledge-categories.ndjson:${lineNumber}.name`);
  if (!Number.isSafeInteger(category.order)) {
    throw new Error(`knowledge-categories.ndjson:${lineNumber}.order 必须是整数`);
  }
  return category;
}

function sanitizeItem(value, lineNumber) {
  assertRecord(value, `knowledge-items.ndjson:${lineNumber}`);
  const item = projectFields(value, ITEM_FIELDS);
  for (const field of ["id", "type", "scope", "title", "source", "status", "content", "priority", "categoryId"]) {
    requireNonEmptyString(item[field], `knowledge-items.ndjson:${lineNumber}.${field}`);
  }
  if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`knowledge-items.ndjson:${lineNumber}.tags 必须是字符串数组`);
  }
  if (!new Set(["active", "archived"]).has(item.status)) {
    throw new Error(`knowledge-items.ndjson:${lineNumber}.status 不受支持：${item.status}`);
  }
  return item;
}

function sanitizeVersion(value, lineNumber) {
  assertRecord(value, `knowledge-versions.ndjson:${lineNumber}`);
  const version = projectFields(value, VERSION_FIELDS);
  requireNonEmptyString(version.id, `knowledge-versions.ndjson:${lineNumber}.id`);
  requireNonEmptyString(version.knowledgeItemId, `knowledge-versions.ndjson:${lineNumber}.knowledgeItemId`);
  if (!Number.isSafeInteger(version.version) || version.version < 1) {
    throw new Error(`knowledge-versions.ndjson:${lineNumber}.version 必须是正整数`);
  }
  assertRecord(version.snapshot, `knowledge-versions.ndjson:${lineNumber}.snapshot`);
  version.snapshot = projectFields(version.snapshot, SNAPSHOT_FIELDS);
  return version;
}

function validateDataset(categories, items, versions) {
  const categoryIds = uniqueIds(categories, "knowledge category");
  const itemIds = uniqueIds(items, "knowledge item");
  uniqueIds(versions, "knowledge version");

  for (const category of categories) {
    if (category.parentId != null && !categoryIds.has(category.parentId)) {
      throw new Error(`知识分类 ${category.id} 引用了不存在的父分类 ${category.parentId}`);
    }
  }
  for (const item of items) {
    if (!categoryIds.has(item.categoryId)) {
      throw new Error(`知识条目 ${item.id} 引用了不存在的分类 ${item.categoryId}`);
    }
  }

  const versionKeys = new Set();
  for (const version of versions) {
    if (!itemIds.has(version.knowledgeItemId)) {
      throw new Error(`知识版本 ${version.id} 引用了不存在的条目 ${version.knowledgeItemId}`);
    }
    if (version.snapshot.id !== version.knowledgeItemId) {
      throw new Error(`知识版本 ${version.id} 的 snapshot.id 与 knowledgeItemId 不一致`);
    }
    const key = `${version.knowledgeItemId}\0${version.version}`;
    if (versionKeys.has(key)) throw new Error(`知识条目 ${version.knowledgeItemId} 的版本号 ${version.version} 重复`);
    versionKeys.add(key);
  }
}

function renderArchiveReadme({ categories, items, versions, archiveMetadata }) {
  const activeItems = items.filter((item) => item.status === "active").length;
  const archivedItems = items.length - activeItems;
  return `# 旧数据库知识库脱敏归档

本目录保存 ${SNAPSHOT_DATE} 从旧数据库导出的知识库专属数据。归档只包含分类、当前知识条目和知识版本；旧对话、用户身份、创建人、更新人及其关联字段均不在归档字段集合中。

## 数据规模

| 数据集 | 记录数 | 用途 |
| --- | ---: | --- |
| knowledge-categories.ndjson | ${categories.length} | 分类树 |
| knowledge-items.ndjson | ${items.length} | 当前条目；active ${activeItems}，archived ${archivedItems} |
| knowledge-versions.ndjson | ${versions.length} | 条目历史版本 |

## 字段边界

- 分类：${CATEGORY_FIELDS.join("、")}。
- 当前条目：${ITEM_FIELDS.join("、")}。
- 历史版本：${VERSION_FIELDS.join("、")}；snapshot 仅保留知识条目业务字段。
- 所有 NDJSON 都由迁移脚本按稳定顺序和固定字段顺序重新序列化，不依赖旧库行顺序。

## 完整性

| 文件 | SHA-256 | byteSize |
| --- | --- | ---: |
${[...archiveMetadata].map(([name, metadata]) => `| ${name} | \`${metadata.sha256}\` | ${metadata.byteSize} |`).join("\n")}

`;
}

function renderVaultIndex({
  categories,
  items,
  versions,
  itemsByCategoryId,
  categoryPaths,
  archiveLogicalDirectory,
  archiveMetadata,
}) {
  const activeItems = items.filter((item) => item.status === "active").length;
  const archivedItems = items.length - activeItems;
  const archiveAssets = [...archiveMetadata].sort(([left], [right]) => codePointCompare(left, right));
  return `---
title: "旧数据库知识库来源索引（${SNAPSHOT_DATE}）"
description: "旧数据库知识库的脱敏归档、分类索引和 561 个当前条目入口。"
date: "${SNAPSHOT_DATE}"
status: "仅查来源"
tags:
  - "旧数据库知识库"
  - "来源索引"
  - "数据迁移"
aliases:
  - "旧数据库知识库"
source: "${archiveLogicalDirectory}/knowledge-items.ndjson"
---

# 旧数据库知识库来源索引

本目录是旧数据库知识库在“产品工作台”中的只读来源层。有效条目只用于来源核验，不提升为现行主知识；归档条目不参与检索。旧对话和旧用户数据未进入本迁移。

## 迁移口径

| 项目 | 结果 |
| --- | --- |
| 快照日期 | ${SNAPSHOT_DATE} |
| 分类 | ${categories.length} |
| 当前知识条目 | ${items.length} |
| 有效条目 | ${activeItems}；映射为“仅查来源” |
| 归档条目 | ${archivedItems}；映射为“不参与检索” |
| 历史版本 | ${versions.length}；保存在脱敏 NDJSON 归档中 |

## 分类索引

| 分类 | 当前条目 | 有效 | 归档 |
| --- | ---: | ---: | ---: |
${categories.map((category) => {
  const categoryItems = itemsByCategoryId.get(category.id) ?? [];
  const active = categoryItems.filter((item) => item.status === "active").length;
  const archived = categoryItems.length - active;
  return `| [${escapeTable(category.name)}](./${categoryPaths.get(category.id)}/README.md) | ${categoryItems.length} | ${active} | ${archived} |`;
}).join("\n")}

## 脱敏原始归档

${archiveAssets.map(([name, metadata]) => `### ${name}

| 项目 | 内容 |
| --- | --- |
| 项目归档 | \`${archiveLogicalDirectory}/${name}\` |
| SHA-256 | \`${metadata.sha256}\` |
| byteSize | ${metadata.byteSize} bytes |
`).join("\n")}
`;
}

function renderCategoryIndex({ category, items, itemPaths, archiveLogicalDirectory, indexPages }) {
  const activeItems = items.filter((item) => item.status === "active").length;
  const archivedItems = items.length - activeItems;
  const currentDirectory = path.posix.dirname(itemPaths.get(items[0]?.id) ?? ".");
  return `---
title: ${yamlString(`旧数据库分类：${category.name}（${shortId(category.id)}）`)}
description: ${yamlString(category.description || `旧数据库知识分类“${category.name}”的来源条目索引。`)}
date: "${SNAPSHOT_DATE}"
status: "仅查来源"
tags:
  - "旧数据库知识库"
  - "来源索引"
  - ${yamlString(category.name)}
aliases: []
source: "${archiveLogicalDirectory}/knowledge-categories.ndjson"
legacyCategoryId: ${yamlString(category.id)}
---

# ${escapeHeading(category.name)}

| 项目 | 内容 |
| --- | --- |
| 旧分类 ID | \`${escapeInlineCode(category.id)}\` |
| 当前条目 | ${items.length} |
| 有效条目 | ${activeItems}；仅查来源 |
| 归档条目 | ${archivedItems}；不参与检索 |

## 条目

${indexPages.length > 0
    ? indexPages.map((page, index) => `- [第 ${index + 1} 页](./${page.filename})：${page.items.length} 条`).join("\n")
    : renderItemLinks(items, itemPaths, currentDirectory)}

`;
}

function renderItemIndexPage({
  category,
  items,
  itemPaths,
  archiveLogicalDirectory,
  page,
  pages,
}) {
  const currentDirectory = path.posix.dirname(itemPaths.get(items[0]?.id) ?? ".");
  return `---
title: ${yamlString(`旧数据库分类条目：${category.name}（${shortId(category.id)}）第 ${page} 页`)}
description: ${yamlString(`旧数据库知识分类“${category.name}”的来源条目索引，第 ${page}/${pages} 页。`)}
date: "${SNAPSHOT_DATE}"
status: "仅查来源"
tags:
  - "旧数据库知识库"
  - "来源索引"
  - ${yamlString(category.name)}
aliases: []
source: "${archiveLogicalDirectory}/knowledge-items.ndjson"
legacyCategoryId: ${yamlString(category.id)}
---

# ${escapeHeading(category.name)}：第 ${page}/${pages} 页

${renderItemLinks(items, itemPaths, currentDirectory)}

`;
}

function renderItemLinks(items, itemPaths, currentDirectory) {
  return items.map((item) => {
    const relativeItemPath = path.posix.relative(currentDirectory, itemPaths.get(item.id));
    const status = item.status === "active" ? "仅查来源" : "不参与检索";
    return `- [${escapeLinkText(item.title)}](./${relativeItemPath})：${status}`;
  }).join("\n");
}

function renderKnowledgeItem({ item, category, versions, archiveLogicalDirectory }) {
  const status = item.status === "active" ? "仅查来源" : "不参与检索";
  const tags = uniqueStrings([
    "旧数据库知识库",
    "来源条目",
    category.name,
    item.type,
    ...item.tags,
  ]);
  const latestVersion = versions.reduce((latest, version) => Math.max(latest, version.version), 0);
  const sourceContent = neutralizeWikiLinks(item.content).trim();
  return `---
title: ${yamlString(`旧库来源｜${item.title}｜${shortId(item.id)}`)}
description: ${yamlString(item.summary || `旧数据库知识条目“${item.title}”的来源快照。`)}
date: "${SNAPSHOT_DATE}"
status: ${yamlString(status)}
tags:
${tags.map((tag) => `  - ${yamlString(tag)}`).join("\n")}
aliases:
  - ${yamlString(item.title)}
source: "${archiveLogicalDirectory}/knowledge-items.ndjson"
legacyKnowledgeId: ${yamlString(item.id)}
legacyStatus: ${yamlString(item.status)}
legacyCategoryId: ${yamlString(item.categoryId)}
retrievalScope: ${yamlString(item.status === "active" ? "source_lookup" : "excluded")}
---

# ${escapeHeading(item.title)}

## 来源元数据

| 项目 | 内容 |
| --- | --- |
| 旧知识 ID | \`${escapeInlineCode(item.id)}\` |
| 分类 | ${escapeTable(category.name)} |
| 类型 | \`${escapeInlineCode(item.type)}\` |
| 范围 | \`${escapeInlineCode(item.scope)}\` |
| 优先级 | \`${escapeInlineCode(item.priority)}\` |
| 旧状态 | \`${escapeInlineCode(item.status)}\` |
| 新检索状态 | ${status} |
| 旧来源类型 | \`${escapeInlineCode(item.source)}\` |
| 创建时间 | ${escapeTable(item.createdAt ?? "未记录")} |
| 更新时间 | ${escapeTable(item.updatedAt ?? "未记录")} |
| 历史版本 | ${versions.length} 个；最新版本号 ${latestVersion || "未记录"} |

## 旧库摘要

${item.summary}

## 旧库当前内容

${sourceContent}

`;
}

async function readNdjson(filePath) {
  const raw = await readFile(filePath, "utf8");
  const values = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} 不是有效 JSON：${errorMessage(error)}`);
    }
  }
  return values;
}

async function ensureFile(filePath, content, { check }) {
  const expected = Buffer.from(content, "utf8");
  let current;
  try {
    current = await readFile(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (current?.equals(expected)) return "unchanged";
  if (check) return "mismatch";
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, expected);
  await rename(temporaryPath, filePath);
  return "changed";
}

function projectFields(value, fields) {
  const result = {};
  for (const field of fields) {
    if (Object.hasOwn(value, field) && value[field] !== undefined) result[field] = value[field];
  }
  return result;
}

function serializeNdjson(values) {
  return values.map((value) => JSON.stringify(value)).join("\n") + "\n";
}

function fileMetadata(content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
}

function uniqueIds(values, label) {
  const ids = new Set();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${label} ID 重复：${value.id}`);
    ids.add(value.id);
  }
  return ids;
}

function groupBy(values, keyOf) {
  const result = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const group = result.get(key) ?? [];
    group.push(value);
    result.set(key, group);
  }
  return result;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim().normalize("NFC")))];
}

function fileSegment(value, maximumLength) {
  const normalized = String(value)
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|#]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "");
  return [...(normalized || "未命名")].slice(0, maximumLength).join("");
}

function shortId(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12);
}

function neutralizeWikiLinks(value) {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/!?\[\[([^\]\r\n]+)\]\]/g, (_match, inner) => {
      const parts = inner.split(/\\?\|/);
      const selected = parts.length > 1 ? parts.at(-1) : parts[0];
      return selected.replace(/\\([|\]])/g, "$1").trim();
    })
    .replace(/(?:file:\/\/)?\/(?:Users|home|private|tmp|Volumes|var\/(?:folders|tmp))\/[\w./~@%+,:=\-\u4e00-\u9fff]+/gu, "[旧本机路径已移除]")
    .replace(/[A-Za-z]:\\[^\s)`'"，。]+/g, "[旧本机路径已移除]")
    .replace(/`storage\/`/g, "`storage（旧目录）`");
}

function yamlString(value) {
  return JSON.stringify(String(value).normalize("NFC"));
}

function escapeTable(value) {
  return String(value).replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

function escapeHeading(value) {
  return String(value).replace(/\r?\n/g, " ").replace(/^#+\s*/, "").trim();
}

function escapeLinkText(value) {
  return String(value).replace(/([\\\[\]])/g, "\\$1").replace(/\r?\n/g, " ");
}

function escapeInlineCode(value) {
  return String(value).replace(/`/g, "'").replace(/\r?\n/g, " ");
}

function assertRecord(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} 必须是 JSON 对象`);
  }
}

function requireNonEmptyString(value, location) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} 必须是非空字符串`);
}

function numberCompare(left, right) {
  return Number(left) - Number(right);
}

function codePointCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (["--input", "--project-root", "--vault-directory", "--archive-directory"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} 缺少参数`);
      index += 1;
      if (argument === "--input") options.inputRoot = value;
      if (argument === "--project-root") options.projectRoot = value;
      if (argument === "--vault-directory") options.vaultDirectory = value;
      if (argument === "--archive-directory") options.archiveDirectory = value;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return options;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const report = await migrateLegacyKnowledge(parseCli(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
