"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { updateMessageParts } from "@/lib/api/nest-client";
import type { ChatMessage } from "@/lib/types";

export async function submitEditedMessage({
  message,
  text,
  setMessages,
  regenerate,
}: {
  message: ChatMessage;
  text: string;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
}) {
  const nextParts: ChatMessage["parts"] = [{ type: "text" as const, text }];
  await updateMessageParts(message.id, nextParts, { truncateAfter: true });

  setMessages((messages) => {
    const index = messages.findIndex((m) => m.id === message.id);
    if (index === -1) {
      return messages;
    }

    return [
      ...messages.slice(0, index),
      { ...message, parts: nextParts },
    ];
  });

  regenerate();
}
