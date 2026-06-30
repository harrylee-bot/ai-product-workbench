import type { RequirementDocument, RequirementDocSection } from "../ai-vibe.types";

/**
 * 把单个 PRD 段落渲染为 markdown（不含顶层 # title）。
 * 用于画布逐段追加：data-textDelta 按段发，语义为追加。
 */
export function sectionToMarkdown(section: RequirementDocSection): string {
  const title = section.title?.trim();
  const content = normalizeCanvasMarkdown(section.content ?? "").trim();
  const lines: string[] = [];
  if (title) {
    lines.push("", `## ${title}`, "");
  }
  if (content) {
    lines.push(content);
  }
  const blockText = section.blocks
    ?.map((block) => normalizeCanvasMarkdown(block.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  if (blockText && blockText !== content) {
    lines.push("", blockText);
  }
  return normalizeCanvasMarkdown(lines.join("\n")).replace(/^\n+/, "");
}

/**
 * 把整篇 RequirementDocument 渲染为 markdown（移植自 copilot-prd-runtime.service.ts）。
 * "# title" + 每段 "## sectionTitle" + content + blocks，按 order 排序。
 */
export function documentToMarkdown(document: RequirementDocument): string {
  const lines = [`# ${document.title || "产品需求文档（PRD）"}`];
  const sections = [...(document.sections ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const section of sections) {
    const title = section.title?.trim();
    const content = normalizeCanvasMarkdown(section.content ?? "").trim();
    if (!title && !content) continue;
    lines.push("", `## ${title || "未命名章节"}`, "");
    if (content) lines.push(content);
    const blockText = section.blocks
      ?.map((block) => normalizeCanvasMarkdown(block.content ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    if (blockText && blockText !== content) {
      lines.push("", blockText);
    }
  }
  return normalizeCanvasMarkdown(lines.join("\n")).trim();
}

export function normalizeCanvasMarkdown(value: string): string {
  if (!value) return "";
  return markdownTablesToLists(unescapeLiteralNewlines(value))
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function unescapeLiteralNewlines(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function markdownTablesToLists(value: string): string {
  const lines = value.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; ) {
    const header = parseMarkdownTableRow(lines[index]);
    const separator = parseMarkdownTableRow(lines[index + 1]);
    if (header && separator && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = parseMarkdownTableRow(lines[index]);
        if (!row) break;
        rows.push(row);
        index += 1;
      }
      output.push(...rows.map((row) => tableRowToListItem(header, row)));
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }
  return output.join("\n");
}

function parseMarkdownTableRow(line?: string): string[] | null {
  const trimmed = line?.trim();
  if (!trimmed || !trimmed.includes("|")) return null;
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function tableRowToListItem(headers: string[], row: string[]) {
  const segments = row
    .map((cell, index) => {
      const header = headers[index]?.trim();
      return header ? `${header}：${cell}` : cell;
    })
    .filter(Boolean);
  return `- ${segments.join("；")}`;
}
