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
  artifact?: {
    id: string;
    title: string;
    kind: "text" | "code" | "image" | "sheet" | "prototype";
  };
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

export type PersistedToolPart = {
  type: "dynamic-tool";
  toolCallId: string;
  toolName: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

/** 桥接上下文：跟踪当前文本 part 与 final action 过滤状态，避免重复发控制 part。 */
export type BridgeContext = {
  assistantDeltaFilter: AssistantDeltaFilterState;
  hasEmittedText: boolean;
  textBuffer: string;
  textStarted: boolean;
  textPartIndex: number;
  reasoningBuffer: string;
  reasoningStarted: boolean;
  emittedToolCallIds: Set<string>;
  toolCallNames: Map<string, string>;
  toolPartOrder: string[];
  toolParts: Map<string, PersistedToolPart>;
};

export function createBridgeContext(): BridgeContext {
  return {
    assistantDeltaFilter: createAssistantDeltaFilterState(),
    hasEmittedText: false,
    textBuffer: "",
    textStarted: false,
    textPartIndex: 1,
    reasoningBuffer: "",
    reasoningStarted: false,
    emittedToolCallIds: new Set(),
    toolCallNames: new Map(),
    toolPartOrder: [],
    toolParts: new Map(),
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
      label: "已同步附件",
      detail: "已准备好用户上传的资料。",
      status: "completed",
      createdAt: now,
    });
  }

  if (event.event === "gateway-artifacts") {
    events.push({
      id: `${runId}:gateway-artifacts`,
      runId,
      kind: "artifact",
      label: "已整理生成产物",
      detail: "已接收并整理本轮生成结果。",
      status: "completed",
      createdAt: now,
    });
  }

  for (const call of event.toolCalls ?? []) {
    if (!call.id || !call.name) continue;
    const action = toolActionCopy(call.name);
    ctx.toolCallNames.set(call.id, call.name);
    events.push({
      id: `${runId}:tool:${call.id}:input`,
      runId,
      kind: "tool",
      label: action.running,
      detail: summarizeToolEvent(call.name, call.args, "input"),
      status: "running",
      createdAt: now,
    });
  }

  if (event.messageRole === "tool" && event.toolCallId) {
    const toolName = ctx.toolCallNames.get(event.toolCallId) ?? "工具";
    const action = toolActionCopy(toolName);
    events.push({
      id: `${runId}:tool:${event.toolCallId}:output`,
      runId,
      kind: "tool",
      label: action.completed,
      detail: summarizeToolEvent(
        toolName,
        event.toolResult ?? event.content,
        "output",
      ),
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
      emitToolInputAvailable(
        { input: call.args ?? {}, toolCallId, toolName },
        writer,
        ctx,
      );
    }
  }

  // 3) 工具输出（tool 角色）
  if (event.messageRole === "tool" && event.toolCallId) {
    if (!ctx.emittedToolCallIds.has(event.toolCallId)) {
      return;
    }
    emitToolOutputAvailable(
      {
        toolCallId: event.toolCallId,
        output: event.toolResult ?? event.content ?? "",
      },
      writer,
      ctx,
    );
  }
}

export function emitToolInputAvailable(
  input: { toolCallId: string; toolName: string; input: unknown },
  writer: UIMessageStreamWriter,
  ctx: BridgeContext,
): void {
  ctx.emittedToolCallIds.add(input.toolCallId);
  ctx.toolCallNames.set(input.toolCallId, input.toolName);
  upsertToolPart(ctx, input.toolCallId, input.toolName, {
    input: input.input,
    state: "input-available",
  });
  writer.write({
    type: "tool-input-start",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  });
  writer.write({
    type: "tool-input-available",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    input: input.input,
  });
}

export function emitToolOutputAvailable(
  input: { toolCallId: string; output: unknown },
  writer: UIMessageStreamWriter,
  ctx: BridgeContext,
): void {
  const toolName = ctx.toolCallNames.get(input.toolCallId) ?? "tool";
  upsertToolPart(ctx, input.toolCallId, toolName, {
    output: input.output,
    state: "output-available",
  });
  writer.write({
    type: "tool-output-available",
    toolCallId: input.toolCallId,
    output: input.output,
  });
}

export function getPersistedToolParts(ctx: BridgeContext): PersistedToolPart[] {
  return ctx.toolPartOrder
    .map((toolCallId) => ctx.toolParts.get(toolCallId))
    .filter((part): part is PersistedToolPart => Boolean(part))
    .map((part) => ({ ...part }));
}

/**
 * 收尾：若已 text-start 则发 text-end。供 run 结束后统一调用。
 */
export function finishText(writer: UIMessageStreamWriter, ctx: BridgeContext): void {
  emitTextDelta(flushAssistantDelta(ctx.assistantDeltaFilter), writer, ctx);
  if (ctx.textStarted) {
    writer.write({ type: "text-end", id: currentTextPartId(ctx) });
    ctx.textStarted = false;
    ctx.textPartIndex += 1;
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
    writer.write({ type: "text-start", id: currentTextPartId(ctx) });
    ctx.textStarted = true;
  }
  writer.write({ type: "text-delta", id: currentTextPartId(ctx), delta });
  ctx.textBuffer += delta;
  ctx.hasEmittedText = true;
}

function currentTextPartId(ctx: BridgeContext) {
  return `text-${ctx.textPartIndex}`;
}

function upsertToolPart(
  ctx: BridgeContext,
  toolCallId: string,
  toolName: string,
  patch: Partial<PersistedToolPart> & Pick<PersistedToolPart, "state">,
) {
  if (!ctx.toolParts.has(toolCallId)) {
    ctx.toolPartOrder.push(toolCallId);
  }
  const current = ctx.toolParts.get(toolCallId);
  ctx.toolParts.set(toolCallId, {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    ...current,
    ...patch,
  });
}

export function createRuntimeEvent(input: {
  runId: string;
  id: string;
  kind: RuntimeProcessEvent["kind"];
  label: string;
  detail?: string;
  artifact?: RuntimeProcessEvent["artifact"];
  status?: RuntimeProcessEvent["status"];
}): RuntimeProcessEvent {
  return {
    id: `${input.runId}:${input.id}`,
    runId: input.runId,
    kind: input.kind,
    label: input.label,
    detail: input.detail,
    artifact: input.artifact,
    status: input.status ?? "completed",
    createdAt: new Date().toISOString(),
  };
}

function toolActionCopy(name: string) {
  const normalized = normalizeToolName(name);
  if (normalized.includes("listknowledgebase")) {
    return {
      running: "正在查询项目知识库",
      completed: "已查询项目知识库",
    };
  }
  if (normalized.includes("readfile") || normalized.includes("read_file")) {
    return {
      running: "正在读取参考资料",
      completed: "已读取参考资料",
    };
  }
  if (
    normalized.includes("writefile") ||
    normalized.includes("editfile") ||
    normalized.includes("updatefile") ||
    normalized.includes("createfile")
  ) {
    return {
      running: "正在整理生成内容",
      completed: "已整理生成内容",
    };
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("find") ||
    normalized === "rg"
  ) {
    return {
      running: "正在检索相关信息",
      completed: "已检索相关信息",
    };
  }
  if (
    normalized.includes("listdir") ||
    normalized.includes("listdirectory") ||
    normalized === "ls"
  ) {
    return {
      running: "正在查看资料目录",
      completed: "已查看资料目录",
    };
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec") ||
    normalized.includes("bash")
  ) {
    return {
      running: "正在执行系统验证",
      completed: "已完成系统验证",
    };
  }
  if (
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("curl")
  ) {
    return {
      running: "正在获取外部信息",
      completed: "已获取外部信息",
    };
  }
  return {
    running: "正在处理当前步骤",
    completed: "已完成当前步骤",
  };
}

function normalizeToolName(name: string) {
  return name
    .replace(/^mcp__/i, "")
    .replace(/__/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase();
}

function summarizeToolEvent(
  toolName: string,
  value: unknown,
  phase: "input" | "output",
) {
  const reason = summarizeToolReason(toolName, value);
  const action = summarizeToolAction(toolName, value);
  const result = phase === "output" ? summarizeToolResult(toolName, value) : undefined;
  return [reason, action, result].filter(Boolean).join("\n");
}

function summarizeToolReason(toolName: string, value: unknown) {
  const normalized = normalizeToolName(toolName);
  const query = extractReadableQuery(value);

  if (normalized.includes("listknowledgebase")) {
    return query
      ? `围绕「${query}」查询项目知识库，确认是否有可复用的业务规则、历史方案或 PRD 模板。`
      : "查询项目知识库，确认是否有可复用的业务规则、历史方案或 PRD 模板。";
  }
  if (normalized.includes("readfile") || normalized.includes("read_file")) {
    return "读取参考资料，确认已有业务背景、约束和文档结构，避免凭空生成。";
  }
  if (
    normalized.includes("writefile") ||
    normalized.includes("editfile") ||
    normalized.includes("updatefile")
  ) {
    return "把已确认的分析结果整理成用户可直接查看的内容。";
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("find")
  ) {
    return query
      ? `检索「${query}」相关资料，确认是否存在历史约束或可复用内容。`
      : "检索相关资料，确认是否存在历史约束或可复用内容。";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec") ||
    normalized.includes("bash")
  ) {
    return "执行必要检查，确认当前改动或服务状态真实可用。";
  }
  if (
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("curl")
  ) {
    return "获取接口或页面响应，确认当前服务状态和外部依赖。";
  }
  return "处理当前任务步骤，补齐生成结果所需的信息。";
}

function summarizeToolAction(toolName: string, value: unknown) {
  const normalized = normalizeToolName(toolName);
  const query = extractReadableQuery(value);
  if (normalized.includes("listknowledgebase")) {
    return query
      ? `按「${query}」检索项目知识库，并筛选能支撑当前需求的条目。`
      : "检索项目知识库，并筛选能支撑当前需求的条目。";
  }
  if (normalized.includes("readfile") || normalized.includes("read_file")) {
    return "读取必要资料，并提取与需求理解相关的信息。";
  }
  if (
    normalized.includes("writefile") ||
    normalized.includes("editfile") ||
    normalized.includes("updatefile")
  ) {
    return "整理输出内容，并更新对应产物。";
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("find")
  ) {
    return query
      ? `检索「${query}」相关资料，并提取可复用上下文。`
      : "检索相关资料，并提取可复用上下文。";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec") ||
    normalized.includes("bash")
  ) {
    return "运行必要检查，确认页面、接口或构建结果正常。";
  }
  if (
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("curl")
  ) {
    return "读取接口或页面响应，判断服务是否正常。";
  }
  return "处理当前步骤。";
}

function summarizeToolResult(toolName: string, value: unknown) {
  if (value === undefined || value === null || value === "") return "这一步已完成。";
  const normalized = normalizeToolName(toolName);
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  if (normalized.includes("listknowledgebase")) {
    const selectedCount = numberFromUnknown(record?.selectedCount);
    const matchedCount = numberFromUnknown(record?.matchedCount);
    if (selectedCount !== undefined) {
      return matchedCount !== undefined
        ? `找到 ${selectedCount} 条可用资料，总命中 ${matchedCount} 条。`
        : `找到 ${selectedCount} 条可用资料。`;
    }
    return "项目知识库查询已完成。";
  }
  if (normalized.includes("readfile") || normalized.includes("read_file")) {
    return "已读取相关资料，并用于后续分析。";
  }
  if (
    normalized.includes("writefile") ||
    normalized.includes("editfile") ||
    normalized.includes("updatefile")
  ) {
    return "内容整理已完成。";
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("find")
  ) {
    return "相关信息检索已完成。";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec") ||
    normalized.includes("bash")
  ) {
    return "系统验证已完成。";
  }
  return "这一步已完成。";
}

function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractReadableQuery(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidate =
    stringFromUnknown(record.query) ??
    stringFromUnknown(record.keyword) ??
    stringFromUnknown(record.search) ??
    stringFromUnknown(record.message) ??
    stringFromUnknown(record.prompt);
  if (!candidate) return undefined;
  const cleaned = candidate
    .replace(/read[_ ]?file/gi, "读取参考资料")
    .replace(/write[_ ]?file/gi, "整理生成内容")
    .replace(/listKnowledgeBase/gi, "查询项目知识库")
    .replace(/["'`{}[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || looksTechnicalText(cleaned)) return undefined;
  return cleaned.length > 28 ? `${cleaned.slice(0, 28)}…` : cleaned;
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function looksTechnicalText(text: string) {
  return /--|&&|\|\||\/[\w.-]+|\\n|\.tsx?|\.jsx?|\.json|npm |git |ssh |docker |curl /i.test(text);
}
