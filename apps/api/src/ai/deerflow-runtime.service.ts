import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import type { RuntimeAttachmentFile } from "../files/file.types";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";

export type DeerFlowToolCall = {
  id: string;
  name: string;
  args?: unknown;
};

export type DeerFlowRuntimeEvent = {
  event: string;
  data: unknown;
  content?: string;
  toolName?: string;
  /** Phase 2 透明化：结构化工具调用（全部，不只首个）、工具返回、消息角色、增量文本、节点。 */
  toolCalls?: DeerFlowToolCall[];
  toolCallId?: string;
  toolResult?: string;
  messageRole?: "assistant" | "tool" | "system" | "human" | "unknown";
  chunk?: string;
  nodeId?: string;
  nodeName?: string;
};

export type DeerFlowFinalAction = {
  type: "answer" | "review_prd" | "review_prototype" | "ask_clarification" | "download_export";
  message: string;
  intent?: string;
  requirementMode?: "historical_extension" | "new_capability" | "brand_new_system" | "one_sentence_completion";
  knowledgeRefsUsed?: string[];
  artifacts?: DeerFlowArtifactReference[];
  raw?: unknown;
  /** 是否成功解析出 final action JSON 块。false 表示 DeerFlow 未产出可识别动作（静默降级为 answer）。 */
  parsed: boolean;
};

export type DeerFlowArtifactReference = {
  kind?: string;
  title?: string;
  path?: string;
  artifactUrl?: string;
  contentType?: string;
  metadata?: unknown;
};

export type DeerFlowResolvedArtifact = DeerFlowArtifactReference & {
  path: string;
  artifactUrl: string;
  status: "fetched" | "skipped" | "failed";
  size?: number;
  text?: string;
  errorMessage?: string;
};

export type DeerFlowUploadedFile = {
  fileId: string;
  fileName: string;
  fileType: string;
  size: number;
  deerFlowFile: {
    filename?: string;
    size?: string;
    path?: string;
    virtualPath?: string;
    artifactUrl?: string;
    markdownFile?: string;
    markdownPath?: string;
    markdownVirtualPath?: string;
    markdownArtifactUrl?: string;
  };
};

export type DeerFlowTurnResult = {
  threadId: string;
  assistantText: string;
  finalAction: DeerFlowFinalAction;
  uploads: DeerFlowUploadedFile[];
  artifacts: DeerFlowResolvedArtifact[];
  rawEvents: DeerFlowRuntimeEvent[];
  finalState?: unknown;
};

type DeerFlowRunInput = {
  projectId: string;
  conversationId: string;
  userId: string;
  message: string;
  runId: string;
  attachments?: unknown[];
  attachmentFiles?: RuntimeAttachmentFile[];
  deerFlowUploads?: DeerFlowUploadedFile[];
  selectedRegion?: unknown;
  previewMode?: string;
  resumeReason?: string;
  productDesignState?: unknown;
  /** knowledge-core-2：生成路径注入的知识库召回（标题/摘要/内容/类型），让 DeerFlow 按知识基线产出 */
  knowledgeContext?: DeerFlowKnowledgeReference[];
  signal?: AbortSignal;
  onEvent?: (event: DeerFlowRuntimeEvent) => Promise<void> | void;
};

/** 注入 DeerFlow 上下文的知识引用（与 knowledge.types 的 KnowledgeReference 对齐的最小子集）。 */
export type DeerFlowKnowledgeReference = {
  id: string;
  title: string;
  snippet?: string;
  content: string;
  type?: string;
  score?: number;
  semanticScore?: number;
  reason?: string;
  relatedPath?: string;
};

type ThreadCreateResponse = {
  thread_id?: string;
  threadId?: string;
};

type UploadFilesResponse = {
  success?: boolean;
  files?: unknown[];
  message?: string;
};

@Injectable()
export class DeerFlowRuntimeService {
  constructor(private readonly prisma: PrismaService) {}

  isEnabled() {
    return readBooleanEnv("DEERFLOW_ENABLED", false);
  }

  async runTurn(input: DeerFlowRunInput): Promise<DeerFlowTurnResult> {
    const threadId = await this.ensureThread(input);
    const uploads = await this.uploadAttachments(threadId, input.attachmentFiles ?? [], input.signal);
    const runInput = { ...input, deerFlowUploads: uploads };
    const rawEvents: DeerFlowRuntimeEvent[] = [];
    let assistantText = "";
    let finalState: unknown;

    if (uploads.length) {
      await input.onEvent?.({
        event: "gateway-upload",
        data: { uploads },
        content: `已同步 ${uploads.length} 个附件到 DeerFlow。`,
      });
    }

    await this.streamRun(threadId, runInput, async (event) => {
      rawEvents.push(event);
      if (isAssistantTextEvent(event) && event.content) {
        assistantText += event.content;
      }
      if (event.event === "values") {
        finalState = event.data;
      }
      await input.onEvent?.(event);
    });

    if (!finalState) {
      finalState = await this.getThreadState(threadId, input.signal).catch(() => undefined);
    }

    const visibleAssistantText = assistantText.trim() || extractAssistantTextFromFinalState(finalState);
    const finalAction = extractFinalAction(visibleAssistantText, finalState);
    const artifacts = await this.resolveArtifacts(threadId, finalAction.artifacts ?? [], input.signal);
    if (artifacts.length) {
      await input.onEvent?.({
        event: "gateway-artifacts",
        data: { artifacts },
        content: `已同步 ${artifacts.filter((artifact) => artifact.status === "fetched").length} 个 DeerFlow 产物。`,
      });
    }

    return {
      threadId,
      assistantText: finalAction.message || visibleAssistantText,
      finalAction,
      uploads,
      artifacts,
      rawEvents,
      finalState,
    };
  }

  private async ensureThread(input: DeerFlowRunInput) {
    const existing = await this.prisma.deerFlowThreadBinding.findUnique({
      where: { conversationId: input.conversationId },
    });
    if (existing) return existing.deerFlowThreadId;

    const thread = await this.createThread({
      aiProductWorkbenchProjectId: input.projectId,
      aiProductWorkbenchConversationId: input.conversationId,
      aiProductWorkbenchUserId: input.userId,
      source: "ai-product-workbench",
    }, input.signal);

    try {
      const created = await this.prisma.deerFlowThreadBinding.create({
        data: {
          projectId: input.projectId,
          conversationId: input.conversationId,
          userId: input.userId,
          deerFlowThreadId: thread.threadId,
          metadata: toInputJson(thread.metadata),
        },
      });
      return created.deerFlowThreadId;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const createdByAnotherTurn = await this.prisma.deerFlowThreadBinding.findUnique({
          where: { conversationId: input.conversationId },
        });
        if (createdByAnotherTurn) return createdByAnotherTurn.deerFlowThreadId;
      }
      throw error;
    }
  }

  private async createThread(metadata: Record<string, unknown>, signal?: AbortSignal) {
    const response = await this.requestJson<ThreadCreateResponse>(threadCreatePath(), {
      method: "POST",
      body: JSON.stringify({ metadata }),
    }, signal);
    const threadId = response.thread_id ?? response.threadId;
    if (!threadId) {
      throw new Error("DeerFlow thread 创建成功但未返回 thread_id");
    }
    return { threadId, metadata };
  }

  private async streamRun(
    threadId: string,
    input: DeerFlowRunInput,
    onEvent: (event: DeerFlowRuntimeEvent) => Promise<void> | void,
  ) {
    const response = await fetchWithTimeout(langGraphUrl(runStreamPath(threadId)), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(buildRunRequest(input)),
    }, input.signal);
    if (!response.ok) {
      throw new Error(`DeerFlow run stream 请求失败：${response.status} ${await safeResponseText(response)}`);
    }
    if (!response.body) {
      throw new Error("DeerFlow run stream 未返回响应体");
    }

    await readSse(response.body, async (event) => {
      if (input.signal?.aborted) return;
      await onEvent(normalizeDeerFlowEvent(event.event, event.data));
    });
  }

  private async uploadAttachments(threadId: string, attachments: RuntimeAttachmentFile[], signal?: AbortSignal) {
    if (!attachments.length) return [];
    if (!readBooleanEnv("DEERFLOW_UPLOADS_ENABLED", true)) return [];

    const formData = new FormData();
    for (const attachment of attachments) {
      const buffer = await readFile(attachment.storagePath);
      formData.append(
        "files",
        new Blob([new Uint8Array(buffer)], { type: attachment.mimeType || "application/octet-stream" }),
        attachment.fileName,
      );
    }

    const response = await fetchWithTimeout(gatewayUrl(uploadPath(threadId)), {
      method: "POST",
      body: formData,
    }, signal);
    if (!response.ok) {
      throw new Error(`DeerFlow upload 请求失败：${response.status} ${await safeResponseText(response)}`);
    }

    const payload = await response.json() as UploadFilesResponse;
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!payload.success && !files.length) {
      throw new Error(`DeerFlow upload 未返回文件信息：${payload.message ?? "unknown error"}`);
    }
    if (files.length < attachments.length) {
      throw new Error(`DeerFlow upload 返回文件数量不完整：${files.length}/${attachments.length}`);
    }

    return attachments.map((attachment, index) => ({
      fileId: attachment.fileId,
      fileName: attachment.fileName,
      fileType: attachment.fileType,
      size: attachment.size,
      deerFlowFile: normalizeUploadedFile(files[index]),
    }));
  }

  private async resolveArtifacts(threadId: string, artifacts: DeerFlowArtifactReference[], signal?: AbortSignal) {
    const limit = readNumberEnv("DEERFLOW_ARTIFACT_MAX_INLINE_BYTES", 2_000_000);
    const resolved: DeerFlowResolvedArtifact[] = [];
    for (const artifact of artifacts) {
      const artifactPath = normalizeArtifactPath(artifact.path ?? artifact.artifactUrl);
      if (!artifactPath) continue;
      const artifactUrl = artifactUrlFor(threadId, artifactPath);
      try {
        const response = await fetchWithTimeout(gatewayUrl(artifactPathFor(threadId, artifactPath)), {
          method: "GET",
        }, signal);
        if (!response.ok) {
          resolved.push({
            ...artifact,
            path: artifactPath,
            artifactUrl,
            status: "failed",
            errorMessage: `${response.status} ${await safeResponseText(response)}`,
          });
          continue;
        }
        const contentType = response.headers.get("content-type") ?? artifact.contentType;
        const contentLength = readContentLength(response);
        if (!isInlineTextArtifact(artifactPath, contentType) || (contentLength !== undefined && contentLength > limit)) {
          await response.body?.cancel().catch(() => undefined);
          resolved.push({
            ...artifact,
            path: artifactPath,
            artifactUrl,
            contentType,
            status: "skipped",
            size: contentLength,
          });
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        resolved.push({
          ...artifact,
          path: artifactPath,
          artifactUrl,
          contentType,
          status: buffer.byteLength <= limit ? "fetched" : "skipped",
          size: buffer.byteLength,
          text: buffer.byteLength <= limit ? buffer.toString("utf8") : undefined,
        });
      } catch (error) {
        resolved.push({
          ...artifact,
          path: artifactPath,
          artifactUrl,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "artifact fetch failed",
        });
      }
    }
    return resolved;
  }

  private async getThreadState(threadId: string, signal?: AbortSignal) {
    return this.requestJson(threadStatePath(threadId), { method: "GET" }, signal);
  }

  private async requestJson<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const response = await fetchWithTimeout(langGraphUrl(path), {
      ...init,
      headers: {
        ...jsonHeaders(),
        ...(init.headers ?? {}),
      },
    }, signal);
    if (!response.ok) {
      throw new Error(`DeerFlow 请求失败：${response.status} ${await safeResponseText(response)}`);
    }
    return await response.json() as T;
  }
}

function buildRunRequest(input: DeerFlowRunInput) {
  return {
    assistant_id: process.env.DEERFLOW_ASSISTANT_ID ?? "lead_agent",
    input: {
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input),
        },
      ],
    },
    stream_mode: readStreamMode(),
    config: {
      configurable: {
        is_plan_mode: readBooleanEnv("DEERFLOW_PLAN_MODE", true),
        thinking_enabled: readBooleanEnv("DEERFLOW_THINKING_ENABLED", true),
        subagent_enabled: readBooleanEnv("DEERFLOW_SUBAGENT_ENABLED", true),
        max_concurrent_subagents: readNumberEnv("DEERFLOW_MAX_CONCURRENT_SUBAGENTS", 3),
        model_name: process.env.DEERFLOW_MODEL_NAME || undefined,
        agent_name: process.env.DEERFLOW_AGENT_NAME || undefined,
      },
    },
  };
}

function buildUserPrompt(input: DeerFlowRunInput) {
  const context = {
    runtimeContract: "ai-product-workbench.deerflow-runtime.v1",
    runId: input.runId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    previewMode: input.previewMode,
    selectedRegion: input.selectedRegion,
    attachments: input.attachments ?? [],
    deerFlowUploads: input.deerFlowUploads ?? [],
    resumeReason: input.resumeReason,
    productDesignState: input.productDesignState,
    knowledgeContext: input.knowledgeContext ?? [],
    finalActionContract: {
      instruction: "At the end, include one fenced block named ai_product_workbench_final_action with JSON.",
      schema: {
        type: "answer | review_prd | review_prototype | ask_clarification | download_export",
        message: "user-facing Chinese summary",
        intent: "optional intent label",
        requirementMode: "optional: historical_extension | new_capability | brand_new_system | one_sentence_completion",
        knowledgeRefsUsed: "optional array of knowledge paths or titles used for reasoning",
        assumptions: "optional inferred product facts, especially for one-sentence requirements",
        consistencyStrategy: "optional PRD/prototype consistency strategy",
        artifacts: [
          {
            kind: "optional artifact kind, for example prototype_html or prd_markdown",
            title: "optional user-facing artifact title",
            path: "optional virtual artifact path, for example mnt/user-data/outputs/index.html",
            artifactUrl: "optional Gateway artifact URL",
            contentType: "optional MIME type",
          },
        ],
      },
      constraints: [
        "Do not mutate the product database directly.",
        "Classify product turns as historical_extension, new_capability, brand_new_system, or one_sentence_completion before drafting.",
        "historical_extension means adding to or changing an existing product/page: preserve the existing PRD/prototype information architecture, layout, field grouping, state flow, interaction style, tab-bar style, and component conventions unless the user explicitly asks for redesign.",
        "new_capability means a new capability inside an existing product: reuse product_architecture and the platform page framework, then design a clearer local information architecture for the new capability.",
        "brand_new_system means a completely new system/page: if a tab bar is present in the target product, follow the retrieved ui_style_guide tab style while allowing the rest of the page style to be redesigned; if no tab bar is present, you may redesign the page style from scratch.",
        "Use product_architecture/page_inventory/ui_style_guide/prototype_asset_ref knowledge items when available to decide reuse vs redesign; cite them in knowledgeRefsUsed.",
        "For one_sentence_completion, infer ordinary missing details from product architecture, business-domain knowledge, and historical cases; ask clarification only for blocking or high-risk facts.",
        "If coding or prototype execution is needed, use DeerFlow coding/prototype execution capability inside the graph.",
        "Use deerFlowUploads virtualPath or markdownVirtualPath when reading uploaded files.",
        "When you generate files, include their output artifact paths in finalActionContract.artifacts.",
        "Return final action instead of asking NestJS to decide the workflow.",
      ],
    },
  };

  return [
    input.message,
    "",
    "Context from AI Product Workbench:",
    "```json",
    JSON.stringify(context),
    "```",
  ].join("\n");
}

function normalizeDeerFlowEvent(event: string, data: unknown): DeerFlowRuntimeEvent {
  const payload = primaryPayload(data);
  const record = asRecord(payload);
  const content = shouldExposeEventContent(event, record) ? toContentText(payload) : undefined;
  const toolCalls = extractToolCalls(record) ?? extractToolCalls(asRecord(data));
  const messageRole = detectMessageRole(record);
  const isToolMessage = messageRole === "tool";
  const toolCallId = isToolMessage ? toOptionalString(record?.tool_call_id) ?? toOptionalString(record?.toolCallId) : undefined;
  const toolResult = isToolMessage ? toContentText(payload) : undefined;
  const nodeId = toOptionalString(asRecord(data)?.node) ?? toOptionalString(asRecord(data)?.node_id);
  return {
    event,
    data,
    content,
    toolName: extractToolName(record) ?? extractToolName(asRecord(data)),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    toolCallId,
    toolResult,
    messageRole,
    // assistant 增量文本：用于前端逐字流式渲染（Phase 2）。
    chunk: messageRole === "assistant" ? content : undefined,
    nodeId,
    nodeName: nodeId ?? undefined,
  };
}

function detectMessageRole(record: Record<string, unknown> | null): DeerFlowRuntimeEvent["messageRole"] {
  if (!record) return "unknown";
  const role = toOptionalString(record.role)?.toLowerCase();
  const type = toOptionalString(record.type)?.toLowerCase();
  if (role === "assistant" || role === "ai" || type === "ai" || type === "assistant" || type === "aimessage" || type === "aimessagechunk") {
    return "assistant";
  }
  if (role === "tool" || type === "tool" || type === "toolmessage") return "tool";
  if (role === "system" || type === "system" || type === "systemmessage") return "system";
  if (role === "human" || role === "user" || type === "human" || type === "humanmessage") return "human";
  return "unknown";
}

function extractToolCalls(record: Record<string, unknown> | null): DeerFlowToolCall[] {
  if (!record) return [];
  const raw = record.tool_calls ?? asRecord(record.additional_kwargs)?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: DeerFlowToolCall[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const fn = asRecord(entry?.function);
    const id = toOptionalString(entry?.id) ?? toOptionalString(fn?.id) ?? `tool_call_${Math.random().toString(36).slice(2)}`;
    const name = toOptionalString(fn?.name) ?? toOptionalString(entry?.name);
    if (!name) continue;
    const argsRaw = fn?.arguments ?? entry?.args ?? entry?.input;
    let args: unknown = argsRaw;
    if (typeof argsRaw === "string") {
      try { args = JSON.parse(argsRaw); } catch { args = argsRaw; }
    }
    calls.push({ id, name, args });
  }
  return calls;
}

function isAssistantTextEvent(event: DeerFlowRuntimeEvent) {
  return (event.event === "messages" || event.event === "messages-tuple") && Boolean(event.content);
}

function shouldExposeEventContent(event: string, record: Record<string, unknown> | null) {
  if (event !== "messages" && event !== "messages-tuple") return false;
  if (!record) return false;
  if (isHiddenRuntimeMessage(record)) return false;
  if (isAssistantMessageRecord(record)) return true;
  return event === "messages-tuple" && !record.type && !record.role;
}

function isAssistantMessageRecord(record: Record<string, unknown> | null) {
  if (!record) return false;
  const role = toOptionalString(record.role)?.toLowerCase();
  if (role === "assistant" || role === "ai") return true;
  const type = toOptionalString(record.type)?.toLowerCase();
  return type === "ai" || type === "assistant" || type === "aimessage" || type === "aimessagechunk";
}

function isHiddenRuntimeMessage(record: Record<string, unknown>) {
  if (asRecord(record.additional_kwargs)?.hide_from_ui === true) return true;
  const role = toOptionalString(record.role)?.toLowerCase();
  const type = toOptionalString(record.type)?.toLowerCase();
  const name = toOptionalString(record.name)?.toLowerCase();
  const content = toContentText(record)?.trim().toLowerCase();
  return [role, type, name].some((value) =>
    Boolean(value && (
      value === "human" ||
      value === "humanmessage" ||
      value === "user" ||
      value === "system" ||
      value === "systemmessage" ||
      value === "memory" ||
      value.includes("memory")
    )),
  ) || Boolean(content && (content.startsWith("<memory") || content.includes("<memory>")));
}

function extractAssistantTextFromFinalState(finalState: unknown) {
  const messages = asRecord(finalState)?.messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = asRecord(messages[index]);
    if (!isAssistantMessageRecord(record)) continue;
    const content = toContentText(record);
    if (content) return content;
  }
  return "";
}

function extractToolName(record: Record<string, unknown> | null) {
  const toolCalls = record?.tool_calls ?? asRecord(record?.additional_kwargs)?.tool_calls;
  if (!Array.isArray(toolCalls)) return undefined;
  const first = asRecord(toolCalls[0]);
  const fn = asRecord(first?.function);
  return toOptionalString(fn?.name) ?? toOptionalString(first?.name);
}

function toContentText(data: unknown) {
  const record = asRecord(data);
  const content = record?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        const itemRecord = asRecord(item);
        return toOptionalString(itemRecord?.text) ?? toOptionalString(itemRecord?.content) ?? "";
      })
      .filter(Boolean)
      .join("");
  }
  return undefined;
}

function extractFinalAction(assistantText: string, finalState: unknown): DeerFlowFinalAction {
  const block = assistantText.match(/```ai_product_workbench_final_action\s*([\s\S]*?)```/i)?.[1];
  const parsed = block ? parseJsonObject(block) : null;
  const message = toOptionalString(parsed?.message) || stripFinalActionBlock(assistantText).trim() || "DeerFlow 本轮已完成。";
  const type = normalizeFinalActionType(parsed?.type);
  return {
    type,
    message,
    intent: toOptionalString(parsed?.intent),
    requirementMode: normalizeRequirementMode(parsed?.requirementMode),
    knowledgeRefsUsed: toStringList(parsed?.knowledgeRefsUsed),
    artifacts: extractArtifactReferences(parsed?.artifacts),
    raw: parsed ?? { finalState },
    // parsed 为 true 仅当成功解析出 JSON 块；否则为静默降级（pipe-6：不再无声失败）。
    parsed: Boolean(parsed),
  };
}

function extractArtifactReferences(value: unknown): DeerFlowArtifactReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const artifacts = value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const artifact: DeerFlowArtifactReference = {
        kind: toOptionalString(record.kind) ?? toOptionalString(record.type),
        title: toOptionalString(record.title) ?? toOptionalString(record.name),
        path: toOptionalString(record.path) ?? toOptionalString(record.virtual_path) ?? toOptionalString(record.virtualPath),
        artifactUrl:
          toOptionalString(record.artifactUrl) ??
          toOptionalString(record.artifact_url) ??
          toOptionalString(record.url),
        contentType: toOptionalString(record.contentType) ?? toOptionalString(record.content_type),
        metadata: record.metadata,
      };
      return artifact.path || artifact.artifactUrl ? artifact : null;
    })
    .filter((item): item is DeerFlowArtifactReference => Boolean(item));
  return artifacts.length ? artifacts : undefined;
}

function normalizeRequirementMode(value: unknown): DeerFlowFinalAction["requirementMode"] {
  if (
    value === "historical_extension" ||
    value === "new_capability" ||
    value === "brand_new_system" ||
    value === "one_sentence_completion"
  ) {
    return value;
  }
  return undefined;
}

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => toOptionalString(item)).filter((item): item is string => Boolean(item));
  return items.length ? items : undefined;
}

function normalizeFinalActionType(value: unknown): DeerFlowFinalAction["type"] {
  if (
    value === "review_prd" ||
    value === "review_prototype" ||
    value === "ask_clarification" ||
    value === "download_export"
  ) {
    return value;
  }
  return "answer";
}

function stripFinalActionBlock(value: string) {
  return value.replace(/```ai_product_workbench_final_action\s*[\s\S]*?```/gi, "").trim();
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value.trim());
    return asRecord(parsed);
  } catch {
    return null;
  }
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: { event: string; data: unknown }) => Promise<void> | void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = parseSseChunk(part);
      if (event) await onEvent(event);
    }
  }

  buffer += decoder.decode();
  const event = parseSseChunk(buffer);
  if (event) await onEvent(event);
}

function parseSseChunk(chunk: string) {
  if (!chunk.trim()) return null;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (!dataLines.length) return null;
  const rawData = dataLines.join("\n");
  return {
    event,
    data: parseSseData(rawData),
  };
}

function parseSseData(value: string) {
  if (!value || value === "[DONE]") return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeUploadedFile(value: unknown): DeerFlowUploadedFile["deerFlowFile"] {
  const record = asRecord(value);
  if (!record) return {};
  return {
    filename: toOptionalString(record.filename),
    size: toOptionalString(record.size),
    path: toOptionalString(record.path),
    virtualPath: toOptionalString(record.virtual_path) ?? toOptionalString(record.virtualPath),
    artifactUrl: toOptionalString(record.artifact_url) ?? toOptionalString(record.artifactUrl),
    markdownFile: toOptionalString(record.markdown_file) ?? toOptionalString(record.markdownFile),
    markdownPath: toOptionalString(record.markdown_path) ?? toOptionalString(record.markdownPath),
    markdownVirtualPath:
      toOptionalString(record.markdown_virtual_path) ??
      toOptionalString(record.markdownVirtualPath),
    markdownArtifactUrl:
      toOptionalString(record.markdown_artifact_url) ??
      toOptionalString(record.markdownArtifactUrl),
  };
}

function normalizeArtifactPath(value: string | undefined) {
  if (!value) return undefined;
  const withoutQuery = value.split("?")[0];
  const marker = "/artifacts/";
  const markerIndex = withoutQuery.indexOf(marker);
  const rawPath = markerIndex >= 0 ? withoutQuery.slice(markerIndex + marker.length) : withoutQuery;
  return rawPath.replace(/^\/+/, "");
}

function primaryPayload(data: unknown) {
  if (Array.isArray(data)) return data[0] ?? data;
  return data;
}

function readStreamMode() {
  const modes = (process.env.DEERFLOW_STREAM_MODE ?? "messages,values")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (modes.length <= 1) return modes[0] ?? "messages";
  return modes;
}

function langGraphUrl(path: string) {
  return joinUrl(process.env.DEERFLOW_LANGGRAPH_URL ?? "http://localhost:2024", path);
}

function gatewayUrl(path: string) {
  return joinUrl(process.env.DEERFLOW_GATEWAY_URL ?? "http://localhost:8001", path);
}

function threadCreatePath() {
  return process.env.DEERFLOW_THREAD_CREATE_PATH ?? "/threads";
}

function threadStatePath(threadId: string) {
  const template = process.env.DEERFLOW_THREAD_STATE_PATH ?? "/threads/{threadId}/state";
  return template.replace("{threadId}", encodeURIComponent(threadId));
}

function runStreamPath(threadId: string) {
  const template = process.env.DEERFLOW_RUN_STREAM_PATH ?? "/threads/{threadId}/runs/stream";
  return template.replace("{threadId}", encodeURIComponent(threadId));
}

function uploadPath(threadId: string) {
  const template = process.env.DEERFLOW_UPLOAD_PATH ?? "/api/threads/{threadId}/uploads";
  return template.replace("{threadId}", encodeURIComponent(threadId));
}

function artifactPathFor(threadId: string, artifactPath: string) {
  const template = process.env.DEERFLOW_ARTIFACT_PATH ?? "/api/threads/{threadId}/artifacts/{path}";
  return template
    .replace("{threadId}", encodeURIComponent(threadId))
    .replace("{path}", encodeArtifactPath(artifactPath));
}

function artifactUrlFor(threadId: string, artifactPath: string) {
  return gatewayUrl(artifactPathFor(threadId, artifactPath));
}

function encodeArtifactPath(artifactPath: string) {
  return artifactPath
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isInlineTextArtifact(artifactPath: string, contentType: string | undefined) {
  if (contentType?.startsWith("text/")) return true;
  if (contentType?.includes("json") || contentType?.includes("xml")) return true;
  return /\.(html?|md|txt|json|csv|css|js|ts|tsx|jsx|xml|svg)$/i.test(artifactPath);
}

function readContentLength(response: Response) {
  const value = response.headers.get("content-length");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function jsonHeaders() {
  return { "content-type": "application/json", accept: "application/json, text/event-stream" };
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal) {
  const timeoutMs = readNumberEnv("DEERFLOW_TIMEOUT_MS", 600_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

async function safeResponseText(response: Response) {
  const text = await response.text().catch(() => "");
  return text.trim().slice(0, 800);
}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function readNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
