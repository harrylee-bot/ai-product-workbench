import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { auditKnowledgeVault } from "./knowledge-vault-audit.mjs";

test("builds a deterministic asset closure and validates declared integrity", async (t) => {
  const payload = Buffer.from("knowledge asset\n", "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const fixture = await createFixture({
    markdown: markdownDocument(`
| 项目 | 内容 |
| --- | --- |
| 项目归档 | \`storage/source-assets/asset.bin\` |
| SHA-256 | \`${sha256}\` |
| byteSize | ${payload.length} bytes |

目录 \`storage/source-assets/\` 只用于定位，不得自动扩展闭包。
${"有效知识正文。".repeat(20)}
`, "source: storage/source-assets/asset.bin"),
    assets: {
      "source-assets/asset.bin": payload,
      "imports/orphan.bin": Buffer.from("not referenced", "utf8"),
    },
  });
  t.after(fixture.cleanup);

  const report = await auditFixture(fixture);

  assert.equal(report.passed, true, report.errors.join("\n"));
  assert.equal(report.markdownFiles, 1);
  assert.equal(report.publishedFiles, 1);
  assert.equal(report.assetClosure.referencedAssetCount, 1);
  assert.equal(report.assetClosure.referencedBytes, payload.length);
  assert.deepEqual(report.assetClosure.referencedAssets[0], {
    path: "storage/source-assets/asset.bin",
    mediaType: "application/octet-stream",
    byteSize: payload.length,
    sha256,
    symbolicLink: false,
    references: [
      { file: "README.md", line: 7, kind: "frontmatter" },
      { file: "README.md", line: 14, kind: "inline-code" },
    ],
    declaredIntegrity: {
      sha256: [sha256],
      byteSize: [payload.length],
      sources: [
        { file: "README.md", line: 15, kind: "sha256", value: sha256 },
        { file: "README.md", line: 16, kind: "byteSize", value: payload.length },
      ],
    },
  });
  assert.equal(report.assetClosure.directoryReferences.length, 1);
  const imports = report.assetClosure.unreferencedStorage.byTopLevel.find((item) => item.category === "imports");
  assert.equal(imports.unreferencedFiles, 1);
  assert.equal(imports.unreferencedBytes, Buffer.byteLength("not referenced"));
});

test("fails closed for missing assets", async (t) => {
  const fixture = await createFixture({
    markdown: markdownDocument(`引用缺失文件 \`storage/imports/missing.pdf\`。\n${"正文。".repeat(50)}`),
  });
  t.after(fixture.cleanup);

  const report = await auditFixture(fixture);

  assert.equal(report.passed, false);
  assert.equal(report.assetClosure.unresolvedAssets.length, 1);
  assert.match(report.errors.join("\n"), /知识资产不可用：storage\/imports\/missing\.pdf/);
});

test("rejects traversal, absolute storage paths, and non-allowlisted storage categories", async (t) => {
  const fixture = await createFixture({
    markdown: markdownDocument(`
- \`storage/source-assets/../../outside.bin\`
- \`/tmp/storage/source-assets/absolute.bin\`
- \`storage/uploads/chat.bin\`
- [编码穿越](storage%2Fsource-assets%2F..%2Foutside.bin)
${"正文。".repeat(50)}
`),
  });
  t.after(fixture.cleanup);

  const report = await auditFixture(fixture);

  assert.equal(report.passed, false);
  assert.equal(report.assetClosure.rejectedReferences.length, 4);
  const errors = report.errors.join("\n");
  assert.match(errors, /禁止路径穿越/);
  assert.match(errors, /禁止绝对路径或 file URI/);
  assert.match(errors, /不允许引用 storage\/uploads/);
});

test("rejects a storage symlink that escapes its allowed category", async (t) => {
  const fixture = await createFixture({
    markdown: markdownDocument(`引用 \`storage/source-assets/escape.bin\`。\n${"正文。".repeat(50)}`),
  });
  t.after(fixture.cleanup);
  const outsidePath = path.join(fixture.root, "outside.bin");
  await writeFile(outsidePath, "outside", "utf8");
  await symlink(outsidePath, path.join(fixture.storageRoot, "source-assets", "escape.bin"));

  const report = await auditFixture(fixture);

  assert.equal(report.passed, false);
  assert.match(report.errors.join("\n"), /符号链接逃逸允许的 storage 分类/);
});

test("enforces declared SHA-256 and byteSize", async (t) => {
  const fixture = await createFixture({
    markdown: markdownDocument(`
| 项目 | 内容 |
| --- | --- |
| 项目归档 | \`storage/source-assets/mismatch.bin\` |
| SHA-256 | \`${"0".repeat(64)}\` |
| 文件大小 | 999 bytes |
${"正文。".repeat(50)}
`),
    assets: { "source-assets/mismatch.bin": Buffer.from("actual", "utf8") },
  });
  t.after(fixture.cleanup);

  const report = await auditFixture(fixture);

  assert.equal(report.passed, false);
  const errors = report.errors.join("\n");
  assert.match(errors, /SHA-256 不匹配/);
  assert.match(errors, /byteSize 不匹配/);
});

async function auditFixture(fixture) {
  return auditKnowledgeVault({
    vaultRoot: fixture.vaultRoot,
    storageRoot: fixture.storageRoot,
    requiredFiles: [],
    unreferencedSampleLimit: 3,
  });
}

async function createFixture({ markdown, assets = {} }) {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-vault-audit-"));
  const vaultRoot = path.join(root, "knowledge-vault");
  const storageRoot = path.join(root, "storage");
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(path.join(storageRoot, "source-assets"), { recursive: true });
  await mkdir(path.join(storageRoot, "imports"), { recursive: true });
  await writeFile(path.join(vaultRoot, "README.md"), markdown, "utf8");
  for (const [relativePath, content] of Object.entries(assets)) {
    const absolutePath = path.join(storageRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  return {
    root,
    vaultRoot,
    storageRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function markdownDocument(body, extraFrontmatter = "") {
  return `---
title: 测试知识
description: 用于验证知识资产闭包审计。
status: 已整理
tags:
  - 测试
${extraFrontmatter}
---

# 测试知识

${body.trim()}
`;
}
