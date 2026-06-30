"use client";

import { formatISO } from "date-fns";

import { getApiBase } from "@/lib/api/config";
import type {
  Chat,
  DBMessage,
  Document,
  Suggestion,
  Vote,
} from "@/lib/api/types";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import type { ChatMessage, RuntimeProcessEvent } from "@/lib/types";

// ===== 基础 fetch =====

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
  projectId: string;
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
export function nestMessageToUiMessage(msg: NestMessageItem): ChatMessage {
  const storedParts = msg.metadata?.parts as ChatMessage["parts"] | undefined;
  const parts = storedParts ?? buildMessageParts(msg);
  return {
    id: msg.id,
    role: msg.role,
    parts,
    metadata: { createdAt: formatISO(new Date(msg.createdAt)) },
  } as ChatMessage;
}

function buildMessageParts(msg: NestMessageItem): ChatMessage["parts"] {
  const parts: unknown[] = msg.content ? [{ type: "text", text: msg.content }] : [];
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
      input: { title, kind: "code" },
      output: { id: prototypeArtifactId, title, kind: "code" },
    });
  }

  return parts as ChatMessage["parts"];
}

function stringFromMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function convertToUIMessages(messages: NestMessageItem[]): ChatMessage[] {
  return messages.map(nestMessageToUiMessage);
}

// ===== Chats（会话历史） =====

type NestConversation = {
  id: string;
  projectId: string;
  ownerId: string;
  title: string;
  summary?: string | null;
  messageCount: number;
  lastMessageAt?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function conversationToChat(c: NestConversation): Chat {
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

export async function renameChat(id: string, title: string): Promise<void> {
  await nestFetch(`/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
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

/** 批量保存 ai-chatbot parts（编辑/落库 assistant 消息） */
export async function saveMessages(
  chatId: string,
  messages: { role: string; parts: unknown; attachments?: unknown }[],
): Promise<void> {
  await nestFetch(`/conversations/${chatId}/messages/bulk`, {
    method: "POST",
    body: JSON.stringify({ messages }),
  });
}

export async function updateMessageParts(
  messageId: string,
  parts: unknown,
): Promise<void> {
  await nestFetch(`/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ parts }),
  });
}

export async function deleteMessagesAfter(
  chatId: string,
  after: string,
): Promise<void> {
  await nestFetch(
    `/conversations/${chatId}/messages?after=${encodeURIComponent(after)}`,
    { method: "DELETE" },
  );
}

// ===== Documents（PRD 文档，映射为 ai-chatbot Document） =====

type NestRequirementDocument = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  sections: Array<{
    id: string;
    title: string;
    order: number;
    content: string;
    blocks?: Array<{ content?: string }>;
  }>;
  updatedAt: string;
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
    const content = s.content?.trim();
    if (!title && !content) continue;
    lines.push("", `## ${title || "未命名章节"}`, "");
    if (content) lines.push(content);
    const blockText = s.blocks
      ?.map((b) => b.content?.trim())
      .filter(Boolean)
      .join("\n\n");
    if (blockText && blockText !== content) lines.push("", blockText);
  }
  return lines.join("\n").trim();
}

function nestDocToDocument(
  doc: NestRequirementDocument,
  kind: ArtifactKind = "text",
): Document {
  return {
    id: doc.id,
    createdAt: doc.updatedAt,
    title: doc.title,
    content: documentToMarkdown(doc),
    kind,
    userId: "",
  };
}

export async function getDocumentsById(
  id: string,
  kind: ArtifactKind = "text",
): Promise<Document[]> {
  if (kind === "code") {
    const data = await nestFetch<NestPrototypeArtifactResponse>(
      `/prototype-artifacts/${id}`,
    );
    const artifact = data.artifact;
    return [
      {
        id: artifact.id,
        createdAt: artifact.updatedAt ?? artifact.createdAt ?? new Date().toISOString(),
        title: artifact.title || "原型",
        content: artifact.htmlContent ?? artifact.html ?? "",
        kind: "code",
        userId: "",
      },
    ];
  }

  const data = await nestFetch<{ document: NestRequirementDocument }>(
    `/prd-documents/${id}`,
  );
  // ai-chatbot 期望版本数组；NestJS 用 RequirementDocumentVersion。
  // v1：返回单元素数组（当前版本）。版本切换由 versions 端点支撑。
  return [nestDocToDocument(data.document, kind)];
}

export async function getDocumentVersions(
  id: string,
): Promise<{ items: Array<{ id: string; createdAt: string; snapshot: unknown }> }> {
  return nestFetch(`/prd-documents/${id}/versions`);
}

export async function saveDocumentContent(
  id: string,
  content: string,
): Promise<void> {
  // PRD 文档按 section 存储；v1 简化为不落库整文（PRD 由生成产生）。
  // 若需手动编辑保存，需要先解析 section，此处留空避免破坏数据。
  void id;
  void content;
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

// ===== Stream（断线重连） =====

export async function createStreamId(
  streamId: string,
  chatId: string,
): Promise<void> {
  await nestFetch(`/conversations/${chatId}/streams`, {
    method: "POST",
    body: JSON.stringify({ streamId }),
  });
}

export async function getStreamIdsByChatId(chatId: string): Promise<string[]> {
  const data = await nestFetch<{ items: Array<{ id: string }> }>(
    `/conversations/${chatId}/streams`,
  );
  return data.items.map((s) => s.id);
}

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

export async function stopChatRun(chatId: string): Promise<void> {
  await nestFetch(`/chat/${chatId}/stop`, { method: "POST" });
}

// ===== Chat stream（AI-SDK 桥） =====

export function getChatStreamUrl(): string {
  return `${getApiBase()}/chat/stream`;
}

export type { DBMessage };
