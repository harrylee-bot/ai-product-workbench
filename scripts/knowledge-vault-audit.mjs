#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { analyzeMarkdown } from "./markdown-wikilinks.mjs";

const root = path.resolve(process.env.KNOWLEDGE_VAULT_ROOT || "knowledge-vault");
const requiredFiles = [
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

const files = await collectMarkdown(root);
const fileSet = new Set(files);
const titleOwners = new Map();
const errors = [];
const warnings = [];
const legacyMetadataGaps = [];
const links = [];
const internalPathFindings = [];
const publicationStatusByFile = new Map();
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
  const markdownAnalysis = analyzeMarkdown(metadata.sourceBody);
  const tier = knowledgeTier(relativePath);
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
    const publishable = (tier === "main" || tier === "source")
      && isPublicationActive(metadata);
    internalPathFindings.push({ file: relativePath, lines: internalPathLines, publishable });
    const message = `检测到本机绝对路径：${relativePath}（行 ${internalPathLines.join("、")}）`;
    if (publishable) errors.push(message);
    else warnings.push(`${message}；该文件不在发布快照中。`);
  }

  for (const link of markdownAnalysis.wikilinks) {
    if (link.target) links.push({ from: relativePath, to: link.target });
  }

  if (markdownAnalysis.unescapedTableAliasPipes.length) {
    const lines = [...new Set(markdownAnalysis.unescapedTableAliasPipes
      .map((issue) => issue.line + metadata.bodyLineOffset))];
    errors.push(
      `表格内 Wiki 链接别名分隔符未转义：${relativePath}:${lines.join("、")}（${markdownAnalysis.unescapedTableAliasPipes.length} 处）`,
    );
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

const indexedFiles = tiers.main.files + tiers.source.files;
const publishedFiles = files.filter((relativePath) => {
  const tier = knowledgeTier(relativePath);
  if (tier !== "main" && tier !== "source") return false;
  return publicationStatusByFile.get(relativePath) === true
    && !internalPathFindings.some((finding) => (
      finding.file === relativePath && finding.publishable
    ));
}).length;
const report = {
  passed: errors.length === 0,
  root,
  markdownFiles: files.length,
  indexedFiles,
  publishedFiles,
  excludedFiles: tiers.inbox.files + tiers.template.files,
  internalPathFindings,
  tiers,
  errors,
  warnings,
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exit(1);

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
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const header = frontmatter?.[1] ?? "";
  const tagBlock = header.match(/^tags:\s*\n((?:\s+-\s*.+\n?)+)/m)?.[1] ?? "";
  const sourceBody = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  return {
    hasFrontmatter: Boolean(frontmatter),
    title: header.match(/^title:\s*(.+)$/m)?.[1]?.trim(),
    description: header.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
    status: header.match(/^status:\s*(.+)$/m)?.[1]?.trim(),
    draft: parseBoolean(header.match(/^draft:\s*(.+)$/m)?.[1]?.trim()),
    tags: [...tagBlock.matchAll(/^\s+-\s*(.+)$/gm)].map((match) => match[1].trim()),
    body: sourceBody.trim(),
    sourceBody,
    bodyLineOffset: frontmatter ? (frontmatter[0].match(/\n/g) ?? []).length : 0,
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
