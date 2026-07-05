"use client";

import { formatISO } from "date-fns";

import { getApiBase } from "@/lib/api/config";
import type {
  Chat,
  Document,
  Suggestion,
  Vote,
} from "@/lib/api/types";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import type { ChatMessage, RuntimeProcessEvent } from "@/lib/types";

// ===== 基础 fetch =====

export type ChatRuntimeModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

export type SystemHealth = {
  ok: boolean;
  service: string;
  phase: string;
  deerflow: {
    enabled: boolean;
    modelId: string;
    modelName: string;
    modelDisplayName: string;
    runtimeName: string;
    provider: string;
  };
  modules: string[];
};

export function getSystemHealth() {
  return nestFetch<SystemHealth>("/system/health");
}

export async function nestFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const body = await res.json();
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ===== 适配器：NestJS 消息 → ai-chatbot UIMessage =====

type NestMessageItem = {
  id: string;
  conversationId: string;
  userId?: string;
  role: "user" | "assistant" | "system";
  type: string;
  content: string;
  attachments?: unknown;
  metadata?: { parts?: unknown } & Record<string, unknown>;
  createdAt: string;
};

/**
 * NestJS Message 无 parts 列，parts 存在 metadata.parts。
 * 读时优先用 metadata.parts（编辑过的），否则从 content 构造 text part。
 */
function nestMessageToUiMessage(msg: NestMessageItem): ChatMessage {
  const storedParts = msg.metadata?.parts as ChatMessage["parts"] | undefined;
  const baseParts = storedParts ?? buildMessageParts(msg);
  const parts = appendPersistedThinkingPart(
    appendPersistedCanvasDocumentParts(baseParts, msg),
    msg,
  );
  return {
    id: msg.id,
    role: msg.role,
    parts,
    metadata: { createdAt: formatISO(new Date(msg.createdAt)) },
  } as ChatMessage;
}

function appendPersistedThinkingPart(
  parts: ChatMessage["parts"],
  msg: NestMessageItem,
): ChatMessage["parts"] {
  if (msg.role !== "assistant") return parts;
  if (hasReasoningPart(parts)) return parts;

  const thinkingText = buildPersistedThinkingText(msg.metadata);
  if (!thinkingText) return parts;

  const nextParts = [...parts] as unknown[];
  const textIndex = nextParts.findIndex(
    (part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text",
  );
  const reasoningPart = { type: "reasoning", text: thinkingText };

  if (textIndex === -1) {
    nextParts.unshift(reasoningPart);
  } else {
    nextParts.splice(textIndex, 0, reasoningPart);
  }

  return nextParts as ChatMessage["parts"];
}

function hasReasoningPart(parts: ChatMessage["parts"]): boolean {
  return parts.some(
    (part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown; text?: unknown }).type === "reasoning" &&
      typeof (part as { text?: unknown }).text === "string" &&
      Boolean((part as { text?: string }).text?.trim()),
  );
}

function buildPersistedThinkingText(
  metadata: NestMessageItem["metadata"],
): string | undefined {
  const reasoningText = stringFromMetadata(metadata?.reasoningText);
  if (reasoningText) return reasoningText;

  const runtimeEvents = runtimeEventsFromMetadata(metadata?.runtimeEvents);
  const text = runtimeEvents
    .filter(isVisibleRuntimeEvent)
    .map(formatRuntimeEventForThinking)
    .filter(Boolean)
    .join("\n");

  return text || undefined;
}

function runtimeEventsFromMetadata(value: unknown): RuntimeProcessEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRuntimeProcessEvent);
}

function isRuntimeProcessEvent(value: unknown): value is RuntimeProcessEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string"
  );
}

function formatRuntimeEventForThinking(event: RuntimeProcessEvent): string {
  const detail = event.detail?.trim();
  return detail ? `- ${event.label}\n  ${detail}` : `- ${event.label}`;
}

function isVisibleRuntimeEvent(event: RuntimeProcessEvent) {
  if (!event.label?.trim() || event.id.startsWith("client:")) return false;
  return ![
    "request-received",
    "knowledge-start",
    "knowledge-complete",
    "deerflow-start",
  ].some((suffix) => event.id.endsWith(`:${suffix}`));
}

function buildMessageParts(msg: NestMessageItem): ChatMessage["parts"] {
  const parts: unknown[] = msg.content ? [{ type: "text", text: msg.content }] : [];
  parts.push(...buildCanvasDocumentToolParts(msg));
  return parts as ChatMessage["parts"];
}

function appendPersistedCanvasDocumentParts(
  parts: ChatMessage["parts"],
  msg: NestMessageItem,
): ChatMessage["parts"] {
  if (msg.role !== "assistant") return parts;
  const nextParts = [...parts] as unknown[];
  for (const toolPart of buildCanvasDocumentToolParts(msg)) {
    const toolId = (toolPart as { output?: { id?: string } }).output?.id;
    const alreadyExists = nextParts.some((part) => {
      if (!part || typeof part !== "object") return false;
      const record = part as { type?: unknown; output?: { id?: string } };
      return record.type === "tool-createDocument" && record.output?.id === toolId;
    });
    if (!alreadyExists) nextParts.push(toolPart);
  }
  return nextParts as ChatMessage["parts"];
}

function buildCanvasDocumentToolParts(msg: NestMessageItem) {
  const parts: unknown[] = [];
  const prdDocumentId = stringFromMetadata(msg.metadata?.prdDocumentId);

  if (msg.role === "assistant" && prdDocumentId) {
    const title =
      stringFromMetadata(msg.metadata?.prdDocumentTitle) || "产品需求文档（PRD）";

    parts.push({
      type: "tool-createDocument",
      toolCallId: `prd-document-${prdDocumentId}`,
      state: "output-available",
      input: { title, kind: "text" },
      output: { id: prdDocumentId, title, kind: "text" },
    });
  }

  const prototypeArtifactId = stringFromMetadata(
    msg.metadata?.prototypeArtifactId,
  );
  if (msg.role === "assistant" && prototypeArtifactId) {
    const title = stringFromMetadata(msg.metadata?.prototypeArtifactTitle) || "原型";

    parts.push({
      type: "tool-createDocument",
      toolCallId: `prototype-artifact-${prototypeArtifactId}`,
      state: "output-available",
      input: { title, kind: "prototype" },
      output: { id: prototypeArtifactId, title, kind: "prototype" },
    });
  }

  return parts;
}

function stringFromMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function convertToUIMessages(messages: NestMessageItem[]): ChatMessage[] {
  return messages.map(nestMessageToUiMessage);
}

// ===== Chats（会话历史） =====

type NestConversation = {
  id: string;
  conversationId: string;
  ownerId: string;
  title: string;
  summary?: string | null;
  messageCount: number;
  lastMessageAt?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function conversationToChat(c: NestConversation): Chat {
  return {
    id: c.id,
    createdAt: c.createdAt,
    title: c.title,
    userId: c.ownerId,
    visibility: "private" as VisibilityType,
  };
}

export async function getChats(): Promise<Chat[]> {
  const data = await nestFetch<{ items: NestConversation[] }>("/conversations");
  return data.items.map(conversationToChat);
}

export async function deleteChat(id: string): Promise<void> {
  await nestFetch(`/conversations/${id}`, { method: "DELETE" });
}

export async function deleteAllChats(): Promise<{ success: boolean; deletedCount: number }> {
  return nestFetch("/conversations", { method: "DELETE" });
}

// ===== Messages =====

export type ChatMessagesResponse = {
  messages: ChatMessage[];
  visibility: VisibilityType;
  isReadonly: boolean;
};

export async function getChatMessages(
  chatId: string,
): Promise<ChatMessagesResponse> {
  const data = await nestFetch<{ items: NestMessageItem[] }>(
    `/conversations/${chatId}/messages`,
  );
  return {
    messages: convertToUIMessages(data.items),
    visibility: "private",
    isReadonly: false,
  };
}

export async function updateMessageParts(
  messageId: string,
  parts: ChatMessage["parts"],
  options?: { truncateAfter?: boolean },
): Promise<void> {
  await nestFetch(`/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      parts,
      truncateAfter: options?.truncateAfter ?? false,
    }),
  });
}

// ===== Documents（PRD 文档，映射为 ai-chatbot Document） =====

type NestRequirementDocument = {
  id: string;
  conversationId: string;
  title: string;
  status: string;
  sections: Array<{
    id: string;
    title: string;
    level?: number;
    order: number;
    content: string;
    blocks?: Array<{
      type?: string;
      content?: string;
      title?: string;
      assetPath?: string;
      diagramSyntax?: string;
    }>;
  }>;
  updatedAt: string;
};

type NestRequirementDocumentVersion = {
  id: string;
  documentId: string;
  conversationId: string;
  version: number;
  snapshot: unknown;
  reason?: string;
  createdBy: string;
  createdAt: string;
};

type NestPrototypeArtifactResponse = {
  artifact: {
    id: string;
    title: string;
    htmlContent?: string | null;
    html?: string | null;
    createdAt?: string;
    updatedAt: string;
  };
};

function documentToMarkdown(doc: NestRequirementDocument): string {
  const lines: string[] = [`# ${doc.title || "产品需求文档（PRD）"}`];
  const sections = [...(doc.sections ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  for (const s of sections) {
    const title = s.title?.trim();
    const content = normalizeCanvasMarkdown(s.content ?? "").trim();
    if (!title && !content) continue;
    lines.push("", `${headingPrefix(s.level)} ${title || "未命名章节"}`, "");
    if (content) lines.push(content);
    const blockText = s.blocks
      ?.map((b) => normalizeCanvasMarkdown(blockToMarkdown(b)).trim())
      .filter(Boolean)
      .join("\n\n");
    if (blockText && blockText !== content) lines.push("", blockText);
  }
  return normalizeCanvasMarkdown(lines.join("\n")).trim();
}

function headingPrefix(level: number | undefined) {
  const normalized = Math.min(Math.max(Number(level) || 1, 1), 3);
  return "#".repeat(normalized + 1);
}

function blockToMarkdown(block: NonNullable<NestRequirementDocument["sections"][number]["blocks"]>[number]) {
  const title = block.title?.trim();
  const content = block.content?.trim() ?? "";
  if (block.type === "diagram") {
    return [
      title ? `**${title}**` : "",
      `\`\`\`${block.diagramSyntax ?? "mermaid"}`,
      content,
      "```",
    ].filter(Boolean).join("\n");
  }
  if ((block.type === "image" || block.type === "prototype_snapshot") && block.assetPath) {
    return [
      `![${title || content || "原型截图"}](${block.assetPath})`,
      content,
    ].filter(Boolean).join("\n\n");
  }
  if (block.type === "asset_reference") {
    return [
      title ? `**${title}**` : "**素材引用**",
      content,
      block.assetPath ? `素材路径：${block.assetPath}` : "",
    ].filter(Boolean).join("\n");
  }
  return [title ? `**${title}**` : "", content].filter(Boolean).join("\n");
}

function normalizeCanvasMarkdown(value: string): string {
  if (!value) return "";
  return unescapeLiteralNewlines(value)
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

function nestDocToDocument(
  doc: NestRequirementDocument,
  kind: ArtifactKind = "text",
  createdAt = doc.updatedAt,
): Document {
  return {
    id: doc.id,
    createdAt,
    title: doc.title,
    content: documentToMarkdown(doc),
    kind,
    userId: "",
  };
}

function isNestRequirementDocument(value: unknown): value is NestRequirementDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<NestRequirementDocument>;
  return (
    typeof record.id === "string" &&
    typeof record.conversationId === "string" &&
    typeof record.title === "string" &&
    Array.isArray(record.sections)
  );
}

function versionToDocument(
  version: NestRequirementDocumentVersion,
  kind: ArtifactKind,
): Document | undefined {
  if (!isNestRequirementDocument(version.snapshot)) {
    return undefined;
  }

  return nestDocToDocument(version.snapshot, kind, version.createdAt);
}

export async function getDocumentsById(
  id: string,
  kind: ArtifactKind = "text",
): Promise<Document[]> {
  if (kind === "prototype") {
    const data = await nestFetch<NestPrototypeArtifactResponse>(
      `/prototype-artifacts/${id}`,
    );
    const artifact = data.artifact;
    const title = artifact.title || "原型";
    const content = `preview:${getApiBase()}/prototype-artifacts/${id}/preview`;
    return [
      {
        id: artifact.id,
        createdAt:
          artifact.updatedAt ?? artifact.createdAt ?? new Date().toISOString(),
        title,
        content,
        kind: "prototype",
        userId: "",
      },
    ];
  }

  const data = await nestFetch<{ document: NestRequirementDocument }>(
    `/prd-documents/${id}`,
  );
  const currentDocument = nestDocToDocument(data.document, kind);

  try {
    const versions = await getDocumentVersions(id);
    const versionDocuments = versions.items
      .sort((a, b) => a.version - b.version)
      .map((version) => versionToDocument(version, kind))
      .filter((document): document is Document => Boolean(document));

    if (versionDocuments.length === 0) {
      return [currentDocument];
    }

    const latestVersion = versionDocuments.at(-1);
    if (
      latestVersion?.content !== currentDocument.content ||
      latestVersion?.title !== currentDocument.title
    ) {
      return [...versionDocuments, currentDocument];
    }

    return versionDocuments;
  } catch {
    return [currentDocument];
  }
}


async function getDocumentVersions(
  id: string,
): Promise<{ items: NestRequirementDocumentVersion[] }> {
  return nestFetch(`/prd-documents/${id}/versions`);
}

export async function saveDocumentContent(
  id: string,
  content: string,
  kind: ArtifactKind = "text",
): Promise<Document | undefined> {
  if (kind !== "text") {
    return undefined;
  }

  const data = await nestFetch<{ document: NestRequirementDocument }>(
    `/prd-documents/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ content }),
    },
  );
  return nestDocToDocument(data.document, kind);
}

// ===== Votes =====

export async function getVotesByChatId(chatId: string): Promise<Vote[]> {
  // NestJS vote 端点按 messageId；v1 返回空，投票功能由 message-actions 触发。
  // 完整实现需遍历会话消息。先返回空数组占位，避免阻断渲染。
  void chatId;
  return [];
}

export async function voteMessage(
  chatId: string,
  messageId: string,
  type: "up" | "down",
): Promise<void> {
  void chatId;
  await nestFetch(`/messages/${messageId}/vote`, {
    method: "POST",
    body: JSON.stringify({ type }),
  });
}

// ===== Suggestions =====

export async function getSuggestionsByDocumentId(
  documentId: string,
): Promise<Suggestion[]> {
  void documentId;
  return [];
}

// ===== Runtime status =====

export type ChatRuntimeStatus = {
  latestRun: {
    id: string;
    status: "running" | "succeeded" | "failed" | "cancelled";
    inputSummary: string;
    outputSummary?: string | null;
    errorMessage?: string | null;
    startedAt: string;
    endedAt?: string | null;
    events?: RuntimeProcessEvent[];
  } | null;
};

export async function getChatRuntimeStatus(
  chatId: string,
): Promise<ChatRuntimeStatus> {
  return nestFetch(`/conversations/${chatId}/runtime-status`);
}

export type StopChatRunResponse = {
  ok: boolean;
  runId?: string;
  canceled?: boolean;
  skipped?: boolean;
  stale?: boolean;
};

export async function stopChatRun(
  chatId: string,
): Promise<StopChatRunResponse> {
  return nestFetch(`/chat/${chatId}/stop`, { method: "POST" });
}

// ===== Chat stream（AI-SDK 桥） =====

export function getChatStreamUrl(): string {
  return `${getApiBase()}/chat/stream`;
}
