#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeMarkdown, escapeTableWikilinkAliases } from "./markdown-wikilinks.mjs";

const root = path.resolve(process.env.KNOWLEDGE_VAULT_ROOT || "knowledge-vault");
const checkOnly = process.argv.includes("--check");
const files = await collectMarkdown(root);
const changedFiles = [];
let replacements = 0;
let changedLines = 0;

for (const relativePath of files) {
  const absolutePath = path.join(root, relativePath);
  const source = await readFile(absolutePath, "utf8");
  const fixed = escapeTableWikilinkAliases(source);
  if (!fixed.replacements) continue;

  const remaining = analyzeMarkdown(fixed.content).unescapedTableAliasPipes;
  if (remaining.length) {
    throw new Error(`修复后仍有未转义表格 Wiki 别名：${relativePath}`);
  }

  if (!checkOnly) await writeFile(absolutePath, fixed.content, "utf8");
  changedFiles.push(relativePath);
  replacements += fixed.replacements;
  changedLines += fixed.changedLines.length;
}

console.log(JSON.stringify({
  mode: checkOnly ? "check" : "write",
  root,
  changedFiles,
  changedFileCount: changedFiles.length,
  changedLines,
  replacements,
}, null, 2));

if (checkOnly && replacements) process.exit(1);

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
