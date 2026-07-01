/**
 * 助手增量文本过滤（移植自 copilot-prd-runtime.service.ts）。
 *
 * DeerFlow 的 assistant chunk 里有时会夹带 JSON 片段、final action 块、整篇 PRD 正文。
 * 这些不应作为聊天正文逐字流给前端（PRD 走 artifact 画布，final action 走落库）。
 * 本模块把这些「看起来不像正常闲聊」的增量过滤掉。
 */

/**
 * 判断内容是否已经像一篇完整 PRD：
 * - 标题数 >=2（多章节结构），或
 * - 同时含 PRD 全称关键词且标题数 >=1（避免一句提到 PRD 就被误吞）
 */
export function looksLikeFullPrd(content: string): boolean {
  const headingCount = (content.match(/^#{1,3}\s+/gm) ?? []).length;
  if (headingCount >= 3) return true;
  const mentionsPrd =
    content.includes("需求文档（PRD）") ||
    content.includes("产品需求文档") ||
    content.includes("需求说明书");
  return mentionsPrd && headingCount >= 1;
}
const FINAL_ACTION_FENCE = "```ai_product_workbench_final_action";

export type AssistantDeltaFilterState = {
  pending: string;
  inFinalActionBlock: boolean;
};

export function createAssistantDeltaFilterState(): AssistantDeltaFilterState {
  return { pending: "", inFinalActionBlock: false };
}

/**
 * 过滤 assistant 增量文本：
 * - 空字符串 → ""
 * - final action 标记 → ""
 * - 像完整 PRD → ""
 * - 以 `{`/`[` 开头且整体为可解析 JSON → ""（疑似结构化片段/工具协议）
 * 其余返回原始 delta（保留原始未 trim 文本以保持空白）。
 * 注意：仅以 `{`/`[` 开头但不可解析为 JSON 的正文（如「{ 这是一段话 }」）不再被丢弃。
 */
export function safeAssistantDelta(delta: string, state?: AssistantDeltaFilterState): string {
  if (state) return safeAssistantDeltaStreaming(delta, state, false);
  return safePlainAssistantDelta(delta);
}

export function flushAssistantDelta(state: AssistantDeltaFilterState): string {
  return safeAssistantDeltaStreaming("", state, true);
}

function safePlainAssistantDelta(delta: string): string {
  const trimmed = delta.trim();
  if (!trimmed) return "";
  if (trimmed.includes("ai_product_workbench_final_action")) {
    return "";
  }
  if (looksLikeFullPrd(trimmed)) return "";
  if (looksLikeStructuredJsonFragment(trimmed)) return "";
  return delta;
}

/** 以 `{`/`[` 开头且整体能 JSON.parse 成功，才视为结构化片段丢弃；否则保留为正文。 */
function looksLikeStructuredJsonFragment(text: string): boolean {
  const first = text[0];
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function safeAssistantDeltaStreaming(delta: string, state: AssistantDeltaFilterState, flush: boolean): string {
  state.pending += delta;
  let visible = "";

  while (state.pending) {
    if (state.inFinalActionBlock) {
      const endIndex = state.pending.indexOf("```");
      if (endIndex === -1) {
        state.pending = keepPotentialFenceSuffix(state.pending);
        break;
      }
      state.pending = state.pending.slice(endIndex + 3);
      state.inFinalActionBlock = false;
      continue;
    }

    const startIndex = state.pending.indexOf(FINAL_ACTION_FENCE);
    if (startIndex !== -1) {
      visible += safePlainAssistantDelta(state.pending.slice(0, startIndex));
      state.pending = state.pending.slice(startIndex + FINAL_ACTION_FENCE.length);
      state.inFinalActionBlock = true;
      continue;
    }

    if (!flush) {
      const holdLength = longestSuffixMatchingFencePrefix(state.pending);
      if (holdLength > 0) {
        visible += safePlainAssistantDelta(state.pending.slice(0, -holdLength));
        state.pending = state.pending.slice(-holdLength);
        break;
      }
    }

    visible += safePlainAssistantDelta(state.pending);
    state.pending = "";
  }

  if (flush) {
    state.pending = "";
    state.inFinalActionBlock = false;
  }

  return visible;
}

function keepPotentialFenceSuffix(value: string) {
  if (value.endsWith("``")) return "``";
  if (value.endsWith("`")) return "`";
  return "";
}

function longestSuffixMatchingFencePrefix(value: string) {
  const maxLength = Math.min(value.length, FINAL_ACTION_FENCE.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (FINAL_ACTION_FENCE.startsWith(value.slice(-length))) {
      return length;
    }
  }
  return 0;
}
