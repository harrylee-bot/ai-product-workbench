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

export type RuntimeProcessEvent = {
  id: string;
  runId?: string;
  kind: "status" | "knowledge" | "tool" | "artifact" | "document" | "error";
  label: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
};

export type RuntimeProcessSnapshot = {
  runId?: string;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt?: string;
  endedAt?: string | null;
  title?: string;
  events?: RuntimeProcessEvent[];
};

/** 桥接上下文：跟踪当前文本 part 与 final action 过滤状态，避免重复发控制 part。 */
export type BridgeContext = {
  assistantDeltaFilter: AssistantDeltaFilterState;
  hasEmittedText: boolean;
  textBuffer: string;
  textStarted: boolean;
  reasoningBuffer: string;
  reasoningStarted: boolean;
  emittedToolCallIds: Set<string>;
  toolCallNames: Map<string, string>;
};

export function createBridgeContext(): BridgeContext {
  return {
    assistantDeltaFilter: createAssistantDeltaFilterState(),
    hasEmittedText: false,
    textBuffer: "",
    textStarted: false,
    reasoningBuffer: "",
    reasoningStarted: false,
    emittedToolCallIds: new Set(),
    toolCallNames: new Map(),
  };
}

export function emitRuntimeStart(
  writer: UIMessageStreamWriter,
  snapshot: RuntimeProcessSnapshot,
): void {
  writer.write({
    type: "data-runtime-start",
    data: snapshot,
    transient: true,
  });
}

export function emitRuntimeEvent(
  writer: UIMessageStreamWriter,
  event: RuntimeProcessEvent,
): void {
  writer.write({
    type: "data-runtime-event",
    data: event,
    transient: true,
  });
}

export function emitRuntimeFinish(
  writer: UIMessageStreamWriter,
  snapshot: RuntimeProcessSnapshot,
): void {
  writer.write({
    type: "data-runtime-finish",
    data: snapshot,
    transient: true,
  });
}

/** 通知前端刷新侧边栏会话标题（标题由后端在首条消息时确定）。 */
export function emitChatTitle(writer: UIMessageStreamWriter, title: string): void {
  if (!title) return;
  writer.write({ type: "data-chat-title", data: title, transient: true });
}

export function runtimeEventsFromDeerFlow(
  event: DeerFlowRuntimeEvent,
  ctx: BridgeContext,
  runId: string,
): RuntimeProcessEvent[] {
  const now = new Date().toISOString();
  const events: RuntimeProcessEvent[] = [];

  if (event.event === "gateway-upload") {
    events.push({
      id: `${runId}:gateway-upload`,
      runId,
      kind: "artifact",
      label: "已同步附件到 DeerFlow",
      detail: event.content,
      status: "completed",
      createdAt: now,
    });
  }

  if (event.event === "gateway-artifacts") {
    events.push({
      id: `${runId}:gateway-artifacts`,
      runId,
      kind: "artifact",
      label: "已同步 DeerFlow 产物",
      detail: event.content,
      status: "completed",
      createdAt: now,
    });
  }

  for (const call of event.toolCalls ?? []) {
    if (!call.id || !call.name) continue;
    ctx.toolCallNames.set(call.id, call.name);
    events.push({
      id: `${runId}:tool:${call.id}:input`,
      runId,
      kind: "tool",
      label: `调用 ${formatToolName(call.name)}`,
      detail: summarizeUnknown(call.args),
      status: "running",
      createdAt: now,
    });
  }

  if (event.messageRole === "tool" && event.toolCallId) {
    const toolName = ctx.toolCallNames.get(event.toolCallId) ?? "工具";
    events.push({
      id: `${runId}:tool:${event.toolCallId}:output`,
      runId,
      kind: "tool",
      label: `${formatToolName(toolName)} 已完成`,
      detail: summarizeUnknown(event.toolResult ?? event.content),
      status: "completed",
      createdAt: now,
    });
  }

  return events;
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
    emitTextDelta(safeAssistantDelta(event.chunk, ctx.assistantDeltaFilter), writer, ctx);
  }

  // 1b) 模型推理思维链（独立 part，不混入正文）
  if (typeof event.reasoning === "string" && event.reasoning) {
    emitReasoningDelta(event.reasoning, writer, ctx);
  }

  // 2) 工具调用输入
  if (event.toolCalls?.length) {
    for (const call of event.toolCalls) {
      const toolCallId = call.id;
      const toolName = call.name;
      if (!toolCallId || !toolName) continue;
      ctx.emittedToolCallIds.add(toolCallId);
      ctx.toolCallNames.set(toolCallId, toolName);
      writer.write({ type: "tool-input-start", toolCallId, toolName });
      writer.write({ type: "tool-input-available", toolCallId, toolName, input: call.args ?? {} });
    }
  }

  // 3) 工具输出（tool 角色）
  if (event.messageRole === "tool" && event.toolCallId) {
    if (!ctx.emittedToolCallIds.has(event.toolCallId)) {
      return;
    }
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
  emitTextDelta(flushAssistantDelta(ctx.assistantDeltaFilter), writer, ctx);
  if (ctx.textStarted) {
    writer.write({ type: "text-end", id: "text-1" });
    ctx.textStarted = false;
  }
}

/**
 * 收尾：若已 reasoning-start 则发 reasoning-end。必须在 text 收尾前后均可调用一次。
 */
export function finishReasoning(writer: UIMessageStreamWriter, ctx: BridgeContext): void {
  if (ctx.reasoningStarted) {
    writer.write({ type: "reasoning-end", id: "reasoning-1" });
    ctx.reasoningStarted = false;
  }
}

function emitReasoningDelta(delta: string, writer: UIMessageStreamWriter, ctx: BridgeContext): void {
  if (!delta) return;
  if (!ctx.reasoningStarted) {
    writer.write({ type: "reasoning-start", id: "reasoning-1" });
    ctx.reasoningStarted = true;
  }
  writer.write({ type: "reasoning-delta", id: "reasoning-1", delta });
  ctx.reasoningBuffer += delta;
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
 * 合成原型 prototype 画布 artifact。
 *
 * 顺序承重：data-kind{prototype} → data-id → data-title → data-clear → data-codeDelta(一次完整快照,替换语义) → data-finish。
 * 全部 transient:true。
 */
export function emitPrototypeArtifact(
  prototypeArtifact: PrototypeArtifact,
  writer: UIMessageStreamWriter,
): void {
  const title = prototypeArtifact.title || "原型";
  const html = prototypeArtifact.htmlContent ?? prototypeArtifact.html ?? "";

  writer.write({ type: "data-kind", data: "prototype", transient: true });
  writer.write({ type: "data-id", data: prototypeArtifact.id, transient: true });
  writer.write({ type: "data-title", data: title, transient: true });
  writer.write({ type: "data-clear", data: null, transient: true });
  // codeDelta 为替换语义：每次发完整快照。这里只发一次完整 HTML。
  writer.write({ type: "data-codeDelta", data: html, transient: true });
  writer.write({ type: "data-finish", data: null, transient: true });
}

/**
 * 合成原型 prototype 的 createDocument 工具结果，让前端在流式期即出现可点内联卡片，
 * 与 PRD 流程对齐（reload 时 nest-client.ts 用同 toolCallId 重建，幂等）。
 */
export function emitPrototypeDocumentPreview(
  prototypeArtifact: PrototypeArtifact,
  writer: UIMessageStreamWriter,
): void {
  const title = prototypeArtifact.title || "原型";
  const toolCallId = `prototype-artifact-${prototypeArtifact.id}`;

  writer.write({ type: "tool-input-start", toolCallId, toolName: "createDocument" });
  writer.write({
    type: "tool-input-available",
    toolCallId,
    toolName: "createDocument",
    input: { title, kind: "prototype" },
  });
  writer.write({
    type: "tool-output-available",
    toolCallId,
    output: { id: prototypeArtifact.id, title, kind: "prototype" },
  });
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
  ctx.textBuffer += delta;
  ctx.hasEmittedText = true;
}

export function createRuntimeEvent(input: {
  runId: string;
  id: string;
  kind: RuntimeProcessEvent["kind"];
  label: string;
  detail?: string;
  status?: RuntimeProcessEvent["status"];
}): RuntimeProcessEvent {
  return {
    id: `${input.runId}:${input.id}`,
    runId: input.runId,
    kind: input.kind,
    label: input.label,
    detail: input.detail,
    status: input.status ?? "completed",
    createdAt: new Date().toISOString(),
  };
}

function formatToolName(name: string) {
  return name
    .replace(/^mcp__/, "")
    .replace(/__/g, " / ")
    .replace(/_/g, " ")
    .trim();
}

function summarizeUnknown(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** 重新导出供 service 直接取用。 */
export { documentToMarkdown };
