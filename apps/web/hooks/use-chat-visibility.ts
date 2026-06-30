"use client";

import { useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import { CHAT_HISTORY_KEY } from "@/components/chat/sidebar-history";
import type { Chat } from "@/lib/api/types";
import type { VisibilityType } from "@/components/chat/visibility-selector";

export function useChatVisibility({
  chatId,
  initialVisibilityType,
}: {
  chatId: string;
  initialVisibilityType: VisibilityType;
}) {
  const { mutate, cache } = useSWRConfig();
  const history = cache.get(CHAT_HISTORY_KEY)?.data as Chat[] | undefined;

  const { data: localVisibility, mutate: setLocalVisibility } = useSWR(
    `${chatId}-visibility`,
    null,
    {
      fallbackData: initialVisibilityType,
    }
  );

  const visibilityType = useMemo(() => {
    if (!history) {
      return localVisibility;
    }
    const chat = history.find((currentChat) => currentChat.id === chatId);
    if (!chat) {
      return "private";
    }
    return chat.visibility;
  }, [history, chatId, localVisibility]);

  // v1 不持久化 visibility（NestJS 桥未提供该端点）；仅维护本地状态并刷新历史列表缓存。
  const setVisibilityType = (updatedVisibilityType: VisibilityType) => {
    setLocalVisibility(updatedVisibilityType);
    mutate(CHAT_HISTORY_KEY);
  };

  return { visibilityType, setVisibilityType };
}
