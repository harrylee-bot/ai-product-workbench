"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { deleteMessagesAfter } from "@/lib/api/nest-client";
import type { ChatMessage } from "@/lib/types";

export async function submitEditedMessage({
  message,
  text,
  chatId,
  setMessages,
  regenerate,
}: {
  message: ChatMessage;
  text: string;
  chatId: string;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
}) {
  const after = message.metadata?.createdAt;

  // 仅在已有时间戳时才向 NestJS 截断；新建会话尚未落库时跳过后端删除。
  if (after) {
    await deleteMessagesAfter(chatId, after);
  }

  setMessages((messages) => {
    const index = messages.findIndex((m) => m.id === message.id);
    if (index === -1) {
      return messages;
    }

    return [
      ...messages.slice(0, index),
      { ...message, parts: [{ type: "text" as const, text }] },
    ];
  });

  regenerate();
}
