"use client";

import { generateUUID } from "@/lib/utils";

export const NEW_CHAT_DRAFT_PARAM = "draftId";

export function createNewChatHref() {
  return `/?${NEW_CHAT_DRAFT_PARAM}=${generateUUID()}`;
}

export function createChatHref(chatId: string) {
  return `/chat/${encodeURIComponent(chatId)}`;
}
