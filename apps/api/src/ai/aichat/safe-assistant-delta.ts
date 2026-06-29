/**
 * 助手增量文本过滤（移植自 copilot-prd-runtime.service.ts）。
 *
 * DeerFlow 的 assistant chunk 里有时会夹带 JSON 片段、final action 块、整篇 PRD 正文。
 * 这些不应作为聊天正文逐字流给前端（PRD 走 artifact 画布，final action 走落库）。
 * 本模块把这些「看起来不像正常闲聊」的增量过滤掉。
 */

/**
 * 判断内容是否已经像一篇完整 PRD（标题数 >=3 或包含 PRD 全称关键词）。
 */
export function looksLikeFullPrd(content: string): boolean {
  const headingCount = (content.match(/^#{1,3}\s+/gm) ?? []).length;
  return headingCount >= 3 || content.includes("需求文档（PRD）") || content.includes("产品需求文档");
}

/**
 * 过滤 assistant 增量文本：
 * - 空字符串 → ""
 * - 以 `{` 或 `[` 开头（疑似 JSON 片段）→ ""
 * - 含 final action 标记 → ""
 * - 像完整 PRD → ""
 * - 过长（>220 字符，疑似整段正文回灌）→ ""
 * 其余返回原始 delta（保留原始未 trim 文本以保持空白）。
 */
export function safeAssistantDelta(delta: string): string {
  const trimmed = delta.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.includes("ai_product_workbench_final_action")) {
    return "";
  }
  if (looksLikeFullPrd(trimmed)) return "";
  if (trimmed.length > 220) return "";
  return delta;
}
