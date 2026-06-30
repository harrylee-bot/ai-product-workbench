import type { RequirementDocument, PrototypeArtifact } from "../ai-vibe.types";
import type { DeerFlowRuntimeEvent } from "../deerflow-runtime.service";
import {
  createAssistantDeltaFilterState,
  flushAssistantDelta,
  safeAssistantDelta,
  type AssistantDeltaFilterState,
} from "./safe-assistant-delta";
import { documentToMarkdown, sectionToMarkdown } from "./document-to-markdown";

/**
 * AI SDK v6 UIMessageStream writer 的最小子集。
 *
 * 真实类型来自 createUIMessageStream({ execute: ({ writer }) => ... }) 注入的
 * UIMessageStreamWriter；这里只约束我们用到的 write(part) 方法，避免在 ai 包类型细节上耦合。
 * 集成 agent 会把 dependencies 里加上 ai@6.0.116；运行时 writer 即真实实例。
 */
export type UIMessageStreamWriter = {
  write: (part: Record<string, unknown>) => void;
};

/** 桥接上下文：跟踪当前文本 part 与 final action 过滤状态，避免重复发控制 part。 */
export type BridgeContext = {
  assistantDeltaFilter: AssistantDeltaFilterState;
  hasEmittedText: boolean;
  textBuffer: string;
  textStarted: boolean;
};

export function createBridgeContext(): BridgeContext {
  return {
    assistantDeltaFilter: createAssistantDeltaFilterState(),
    hasEmittedText: false,
    textBuffer: "",
    textStarted: false,
  };
}

/**
 * 把单个 DeerFlowRuntimeEvent 翻译成 AI SDK v6 UIMessageStream part 并写入 writer。
 *
 * 映射规则：
 * - assistant chunk → safeAssistantDelta 过滤后 → 首次 text-start，后续 text-delta（id="text-1"）
 * - toolCalls → tool-input-start + tool-input-available
 * - toolResult（tool 角色，带 toolCallId）→ tool-output-available
 *
 * 注意：v6 无 "tool-call" part，用 tool-input-start + tool-input-available。
 */
export function emitDeerFlowEvent(
  event: DeerFlowRuntimeEvent,
  writer: UIMessageStreamWriter,
  ctx: BridgeContext,
): void {
  // 1) 助手增量文本
  if (event.messageRole === "assistant" && typeof event.chunk === "string") {
    bufferTextDelta(safeAssistantDelta(event.chunk, ctx.assistantDeltaFilter), ctx);
  }

  // 2) 工具调用输入
  if (event.toolCalls?.length) {
    for (const call of event.toolCalls) {
      const toolCallId = call.id;
      const toolName = call.name;
      if (!toolCallId || !toolName) continue;
      writer.write({ type: "tool-input-start", toolCallId, toolName });
      writer.write({ type: "tool-input-available", toolCallId, toolName, input: call.args ?? {} });
    }
  }

  // 3) 工具输出（tool 角色）
  if (event.messageRole === "tool" && event.toolCallId) {
    writer.write({
      type: "tool-output-available",
      toolCallId: event.toolCallId,
      output: event.toolResult ?? event.content ?? "",
    });
  }
}

/**
 * 收尾：若已 text-start 则发 text-end。供 run 结束后统一调用。
 */
export function finishText(writer: UIMessageStreamWriter, ctx: BridgeContext): void {
  bufferTextDelta(flushAssistantDelta(ctx.assistantDeltaFilter), ctx);
  if (ctx.textStarted) {
    writer.write({ type: "text-end", id: "text-1" });
    ctx.textStarted = false;
  }
}

/**
 * 合成 PRD text 画布 artifact。
 *
 * 顺序承重：data-kind{text} → data-id → data-title → data-clear → 逐 section data-textDelta(追加) → data-finish。
 * 全部 transient:true（自定义 data-* part，不在最终消息历史里持久化）。
 */
export function emitPrdArtifact(prdDocument: RequirementDocument, writer: UIMessageStreamWriter): void {
  const title = prdDocument.title || "产品需求文档（PRD）";
  const sections = [...(prdDocument.sections ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  writer.write({ type: "data-kind", data: "text", transient: true });
  writer.write({ type: "data-id", data: prdDocument.id, transient: true });
  writer.write({ type: "data-title", data: title, transient: true });
  writer.write({ type: "data-clear", data: null, transient: true });

  // 顶层标题作为首个 textDelta（追加语义）
  writer.write({ type: "data-textDelta", data: `# ${title}\n`, transient: true });

  for (const section of sections) {
    const sectionMarkdown = sectionToMarkdown(section);
    if (!sectionMarkdown) continue;
    // 段落间空行 + 段落正文（追加）
    writer.write({ type: "data-textDelta", data: `\n${sectionMarkdown}\n`, transient: true });
  }

  writer.write({ type: "data-finish", data: null, transient: true });
}

/**
 * 合成 AI SDK 文档工具结果，让前端沿用官方 DocumentPreview 卡片作为画布重开入口。
 */
export function emitPrdDocumentPreview(
  prdDocument: RequirementDocument,
  writer: UIMessageStreamWriter,
): void {
  const title = prdDocument.title || "产品需求文档（PRD）";
  const toolCallId = `prd-document-${prdDocument.id}`;

  writer.write({ type: "tool-input-start", toolCallId, toolName: "createDocument" });
  writer.write({
    type: "tool-input-available",
    toolCallId,
    toolName: "createDocument",
    input: { title, kind: "text" },
  });
  writer.write({
    type: "tool-output-available",
    toolCallId,
    output: { id: prdDocument.id, title, kind: "text" },
  });
}

/**
 * 合成原型 code 画布 artifact。
 *
 * 顺序承重：data-kind{code} → data-id → data-title → data-clear → data-codeDelta(一次完整快照,替换语义) → data-finish。
 * 全部 transient:true。
 */
export function emitPrototypeArtifact(
  prototypeArtifact: PrototypeArtifact,
  writer: UIMessageStreamWriter,
): void {
  const title = prototypeArtifact.title || "原型";
  const html = prototypeArtifact.htmlContent ?? prototypeArtifact.html ?? "";

  writer.write({ type: "data-kind", data: "code", transient: true });
  writer.write({ type: "data-id", data: prototypeArtifact.id, transient: true });
  writer.write({ type: "data-title", data: title, transient: true });
  writer.write({ type: "data-clear", data: null, transient: true });
  // codeDelta 为替换语义：每次发完整快照。这里只发一次完整 HTML。
  writer.write({ type: "data-codeDelta", data: html, transient: true });
  writer.write({ type: "data-finish", data: null, transient: true });
}

/** 工具：直接发一段已确定的文本（用于 finalAction.message 兜底显示）。 */
export function emitStaticText(text: string, writer: UIMessageStreamWriter, ctx: BridgeContext): void {
  if (!text) return;
  emitTextDelta(text, writer, ctx);
}

function emitTextDelta(delta: string, writer: UIMessageStreamWriter, ctx: BridgeContext): void {
  if (!delta) return;
  if (!ctx.textStarted) {
    writer.write({ type: "text-start", id: "text-1" });
    ctx.textStarted = true;
  }
  writer.write({ type: "text-delta", id: "text-1", delta });
  ctx.hasEmittedText = true;
}

function bufferTextDelta(delta: string, ctx: BridgeContext): void {
  if (!delta) return;
  ctx.textBuffer += delta;
}

/** 重新导出供 service 直接取用。 */
export { documentToMarkdown };
