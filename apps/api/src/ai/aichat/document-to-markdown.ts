import type { RequirementDocument, RequirementDocSection } from "../ai-vibe.types";

/**
 * 把单个 PRD 段落渲染为 markdown（不含顶层 # title）。
 * 用于画布逐段追加：data-textDelta 按段发，语义为追加。
 */
export function sectionToMarkdown(section: RequirementDocSection): string {
  const title = section.title?.trim();
  const content = section.content?.trim();
  const lines: string[] = [];
  if (title) {
    lines.push("", `## ${title}`, "");
  }
  if (content) {
    lines.push(content);
  }
  const blockText = section.blocks
    ?.map((block) => block.content?.trim())
    .filter(Boolean)
    .join("\n\n");
  if (blockText && blockText !== content) {
    lines.push("", blockText);
  }
  return lines.join("\n").replace(/^\n+/, "");
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
    const content = section.content?.trim();
    if (!title && !content) continue;
    lines.push("", `## ${title || "未命名章节"}`, "");
    if (content) lines.push(content);
    const blockText = section.blocks
      ?.map((block) => block.content?.trim())
      .filter(Boolean)
      .join("\n\n");
    if (blockText && blockText !== content) {
      lines.push("", blockText);
    }
  }
  return lines.join("\n").trim();
}
