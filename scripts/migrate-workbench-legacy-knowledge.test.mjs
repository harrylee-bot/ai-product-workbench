import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateLegacyKnowledge } from "./migrate-workbench-legacy-knowledge.mjs";

test("migrates only allowlisted knowledge fields and is deterministic", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-legacy-knowledge-"));
  const inputRoot = path.join(root, "input");
  const projectRoot = path.join(root, "project");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));

  await writeNdjson(path.join(inputRoot, "knowledge-categories.ndjson"), [{
    id: "category-1",
    name: "产品规则",
    order: 1,
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    description: "测试分类",
    createdBy: "must-not-survive",
  }]);
  await writeNdjson(path.join(inputRoot, "knowledge-items.ndjson"), [
    knowledgeItem({ id: "item-active", status: "active", title: "有效规则" }),
    knowledgeItem({ id: "item-archived", status: "archived", title: "归档规则" }),
  ]);
  await writeNdjson(path.join(inputRoot, "knowledge-versions.ndjson"), [
    knowledgeVersion({ id: "version-1", knowledgeItemId: "item-active", version: 1 }),
    knowledgeVersion({ id: "version-2", knowledgeItemId: "item-archived", version: 1, status: "archived" }),
  ]);

  const first = await migrateLegacyKnowledge({ inputRoot, projectRoot });
  assert.equal(first.items, 2);
  assert.equal(first.activeItems, 1);
  assert.equal(first.archivedItems, 1);
  assert.equal(first.itemMarkdownFiles, 2);

  const archiveRoot = path.join(projectRoot, "storage/source-assets/legacy-knowledge-20260716");
  const archivedItems = await readNdjson(path.join(archiveRoot, "knowledge-items.ndjson"));
  assert.deepEqual(Object.keys(archivedItems[0]), [
    "id", "tags", "type", "scope", "title", "source", "status", "content", "summary", "priority",
    "createdAt", "updatedAt", "categoryId",
  ]);
  assert.equal(archivedItems[0].sourceConversationId, undefined);
  assert.equal(archivedItems[0].createdBy, undefined);

  const archivedVersions = await readNdjson(path.join(archiveRoot, "knowledge-versions.ndjson"));
  assert.equal(archivedVersions[0].createdBy, undefined);
  assert.equal(archivedVersions[0].snapshot.userId, undefined);

  const markdownFiles = await collectFiles(path.join(projectRoot, "knowledge-vault"));
  const activeMarkdown = await findMarkdown(markdownFiles, "legacyKnowledgeId: \"item-active\"");
  const archivedMarkdown = await findMarkdown(markdownFiles, "legacyKnowledgeId: \"item-archived\"");
  assert.match(activeMarkdown, /^status: "仅查来源"$/m);
  assert.match(archivedMarkdown, /^status: "不参与检索"$/m);
  assert.doesNotMatch(activeMarkdown, /\[\[不存在的链接\]\]/);
  assert.match(activeMarkdown, /不存在的链接/);
  assert.doesNotMatch(activeMarkdown, /\/Users\/example/);
  assert.match(activeMarkdown, /旧本机路径已移除/);

  const before = await directoryDigest(projectRoot);
  const second = await migrateLegacyKnowledge({ inputRoot, projectRoot, check: true });
  const after = await directoryDigest(projectRoot);
  assert.equal(second.changedFiles.length, 0);
  assert.equal(before, after);

  const checksumLines = (await readFile(path.join(archiveRoot, "SHA256SUMS"), "utf8")).trim().split("\n");
  assert.equal(checksumLines.length, 4);
  for (const line of checksumLines) assert.match(line, /^[0-9a-f]{64}  \S+$/);
});

function knowledgeItem({ id, status, title }) {
  return {
    id,
    tags: ["规则"],
    type: "strong_rule",
    scope: "global",
    title,
    source: "manual",
    status,
    content: "## 内容\n\n使用 [[不存在的链接]] 进行测试。旧路径：`/Users/example/private/source.md`。",
    summary: `${title}摘要`,
    priority: "high",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    categoryId: "category-1",
    sourceConversationId: "conversation-must-not-survive",
    createdBy: "user-must-not-survive",
  };
}

function knowledgeVersion({ id, knowledgeItemId, version, status = "active" }) {
  return {
    id,
    version,
    snapshot: {
      id: knowledgeItemId,
      tags: ["规则"],
      type: "strong_rule",
      scope: "global",
      title: knowledgeItemId,
      source: "manual",
      status,
      content: "版本内容",
      summary: "版本摘要",
      priority: "high",
      categoryId: "category-1",
      userId: "must-not-survive",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    changeSummary: "初始化",
    knowledgeItemId,
    createdBy: "must-not-survive",
  };
}

async function writeNdjson(filePath, values) {
  await writeFile(filePath, values.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8");
}

async function readNdjson(filePath) {
  return (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function collectFiles(directory, base = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path.join(base, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(absolutePath, relativePath));
    else result.push({ relativePath, absolutePath });
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function findMarkdown(files, needle) {
  for (const file of files.filter((entry) => entry.relativePath.endsWith(".md"))) {
    const content = await readFile(file.absolutePath, "utf8");
    if (content.includes(needle)) return content;
  }
  throw new Error(`找不到包含 ${needle} 的 Markdown`);
}

async function directoryDigest(directory) {
  const digest = createHash("sha256");
  for (const file of await collectFiles(directory)) {
    digest.update(file.relativePath);
    digest.update("\0");
    digest.update(await readFile(file.absolutePath));
    digest.update("\0");
  }
  return digest.digest("hex");
}
