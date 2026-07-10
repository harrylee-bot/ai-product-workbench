import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMarkdown, escapeTableWikilinkAliases } from "./markdown-wikilinks.mjs";

test("parses escaped aliases and anchors without treating code as links", () => {
  const source = [
    "[[目录/文档\\|别名]]",
    "[[目录/文档#标题\\|锚点别名]]",
    "[[目录/文档#^block-id|块别名]]",
    "[[#当前页标题\\|当前页]]",
    "`[[inline|code]]`",
    "```md",
    "[[fenced|code]]",
    "```",
  ].join("\n");

  const { wikilinks } = analyzeMarkdown(source);

  assert.deepEqual(wikilinks.map(({ target, anchor, alias }) => ({ target, anchor, alias })), [
    { target: "目录/文档", anchor: undefined, alias: "别名" },
    { target: "目录/文档", anchor: "标题", alias: "锚点别名" },
    { target: "目录/文档", anchor: "^block-id", alias: "块别名" },
    { target: "", anchor: "当前页标题", alias: "当前页" },
  ]);
});

test("flags and fixes only unescaped aliases in confirmed Markdown tables", () => {
  const source = [
    "| 链接 | 说明 |",
    "| --- | --- |",
    "| [[目录/文档#标题|别名]]、[[目录/二\\|已转义]] | `[[inline|code]]` |",
    "",
    "表格外 [[目录/三|保留原样]]",
    "| 看似表格 | [[目录/四|没有分隔行]] |",
    "",
    "```md",
    "| 链接 | 说明 |",
    "| --- | --- |",
    "| [[目录/五|围栏代码]] | 不修改 |",
    "```",
  ].join("\n");

  const before = analyzeMarkdown(source);
  assert.equal(before.unescapedTableAliasPipes.length, 1);
  assert.equal(before.unescapedTableAliasPipes[0].line, 3);

  const fixed = escapeTableWikilinkAliases(source);
  assert.equal(fixed.replacements, 1);
  assert.deepEqual(fixed.changedLines, [3]);
  assert.match(fixed.content, /\[\[目录\/文档#标题\\\|别名\]\]/);
  assert.match(fixed.content, /`\[\[inline\|code\]\]`/);
  assert.match(fixed.content, /表格外 \[\[目录\/三\|保留原样\]\]/);
  assert.match(fixed.content, /\[\[目录\/五\|围栏代码\]\]/);
  assert.equal(analyzeMarkdown(fixed.content).unescapedTableAliasPipes.length, 0);
  assert.equal(escapeTableWikilinkAliases(fixed.content).replacements, 0);
});

test("does not use inline-code pipes to confirm a table", () => {
  const source = [
    "`header | text`",
    "| --- | --- |",
    "| [[目录/文档|别名]] | 内容 |",
  ].join("\n");

  assert.equal(analyzeMarkdown(source).unescapedTableAliasPipes.length, 0);
});

test("excludes frontmatter and indented code while preserving source line endings", () => {
  const source = [
    "---\r\n",
    "example: |\n",
    "  | 链接 | 说明 |\r\n",
    "  | --- | --- |\n",
    "  | [[目录/前言|不修改]] | 内容 |\r\n",
    "---\n",
    "    | 链接 | 说明 |\r\n",
    "    | --- | --- |\n",
    "    | [[目录/代码|不修改]] | 内容 |\r\n",
    "| 链接 | 说明 |\n",
    "| --- | --- |\r\n",
    "| [[目录/正文|修改]] | 内容 |\n",
  ].join("");

  const fixed = escapeTableWikilinkAliases(source);
  assert.equal(fixed.replacements, 1);
  assert.equal(fixed.content, source.replace("[[目录/正文|修改]]", "[[目录/正文\\|修改]]"));
});
