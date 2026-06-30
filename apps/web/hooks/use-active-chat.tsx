"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { usePathname } from "next/navigation";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import { useDataStream } from "@/components/chat/data-stream-provider";
import { CHAT_HISTORY_KEY } from "@/components/chat/sidebar-history";
import { toast } from "@/components/chat/toast";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { useAutoResume } from "@/hooks/use-auto-resume";
import type { Vote } from "@/lib/api/types";
import {
  getChatMessages,
  getChatRuntimeStatus,
  getChatStreamUrl,
  getVotesByChatId,
  stopChatRun,
} from "@/lib/api/nest-client";
import { ChatbotError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { fetchWithErrorHandlers, generateUUID } from "@/lib/utils";

// v1: 单一固定模型。原 @/lib/ai/models 已删除；模型选择由 data-access agent 统一收敛。
const DEFAULT_CHAT_MODEL = "gpt-5.5";

type ActiveChatContextValue = {
  chatId: string;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  status: UseChatHelpers<ChatMessage>["status"];
  stop: UseChatHelpers<ChatMessage>["stop"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  visibilityType: VisibilityType;
  isReadonly: boolean;
  isLoading: boolean;
  votes: Vote[] | undefined;
  currentModelId: string;
  setCurrentModelId: (id: string) => void;
  showCreditCardAlert: boolean;
  setShowCreditCardAlert: Dispatch<SetStateAction<boolean>>;
};

const ActiveChatContext = createContext<ActiveChatContextValue | null>(null);

function extractChatId(pathname: string): string | null {
  const match = pathname.match(/\/chat\/([^/]+)/);
  return match ? match[1] : null;
}

function messagesSignature(messages: ChatMessage[]) {
  return messages
    .map((message) => {
      const partSignature = message.parts
        .map((part: any) => {
          if (part.type === "text") {
            return `${part.type}:${part.text?.length ?? 0}`;
          }
          return `${part.type}:${part.state ?? ""}`;
        })
        .join(",");
      return `${message.id}:${message.role}:${partSignature}`;
    })
    .join("|");
}

export function ActiveChatProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { setDataStream } = useDataStream();
  const { mutate } = useSWRConfig();

  const chatIdFromUrl = extractChatId(pathname);
  const isNewChat = !chatIdFromUrl;
  const newChatIdRef = useRef(generateUUID());
  const prevPathnameRef = useRef(pathname);

  if (isNewChat && prevPathnameRef.current !== pathname) {
    newChatIdRef.current = generateUUID();
  }
  prevPathnameRef.current = pathname;

  const chatId = chatIdFromUrl ?? newChatIdRef.current;

  const [currentModelId, setCurrentModelId] = useState(DEFAULT_CHAT_MODEL);
  const currentModelIdRef = useRef(currentModelId);
  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  const [input, setInput] = useState("");
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);

  const { data: runtimeStatus, mutate: mutateRuntimeStatus } = useSWR(
    isNewChat ? null : `chat-runtime-status-${chatId}`,
    () => getChatRuntimeStatus(chatId),
    {
      revalidateOnFocus: true,
      refreshInterval: (latest) =>
        latest?.latestRun?.status === "running" ? 2000 : 0,
    }
  );
  const isServerRunRunning = runtimeStatus?.latestRun?.status === "running";

  const {
    data: chatData,
    isLoading,
    mutate: mutateChatMessages,
  } = useSWR(
    isNewChat ? null : `chat-messages-${chatId}`,
    () => getChatMessages(chatId),
    {
      revalidateOnFocus: false,
      refreshInterval: isServerRunRunning ? 2000 : 0,
    }
  );

  const initialMessages: ChatMessage[] = isNewChat
    ? []
    : (chatData?.messages ?? []);
  const visibility: VisibilityType = isNewChat
    ? "private"
    : (chatData?.visibility ?? "private");

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    resumeStream,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    id: chatId,
    messages: initialMessages,
    generateId: generateUUID,
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      return (
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false
      );
    },
    transport: new DefaultChatTransport({
      api: getChatStreamUrl(),
      credentials: "include",
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest(request) {
        const lastMessage = request.messages.at(-1);
        const isToolApprovalContinuation =
          lastMessage?.role !== "user" ||
          request.messages.some((msg) =>
            msg.parts?.some((part) => {
              const state = (part as { state?: string }).state;
              return (
                state === "approval-responded" || state === "output-denied"
              );
            })
          );

        return {
          body: {
            id: request.id,
            ...(isToolApprovalContinuation
              ? { messages: request.messages }
              : { message: lastMessage }),
            selectedChatModel: currentModelIdRef.current,
            selectedVisibilityType: visibility,
            ...request.body,
          },
        };
      },
    }),
    onData: (dataPart) => {
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
    },
    onFinish: () => {
      mutate(CHAT_HISTORY_KEY);
      mutateRuntimeStatus();
      mutateChatMessages();
    },
    onError: (error) => {
      if (error.message?.includes("AI Gateway requires a valid credit card")) {
        setShowCreditCardAlert(true);
      } else if (error instanceof ChatbotError) {
        toast({ type: "error", description: error.message });
      } else {
        toast({
          type: "error",
          description: error.message || "出错了，请稍后重试",
        });
      }
    },
  });

  const displayedStatus =
    isServerRunRunning && status === "ready" ? "submitted" : status;

  const stopGeneration = useCallback(async () => {
    await stop();
    try {
      await stopChatRun(chatId);
      mutateRuntimeStatus();
      mutateChatMessages();
      mutate(CHAT_HISTORY_KEY);
    } catch (error: any) {
      toast({
        type: "error",
        description: error?.message || "停止生成失败，请稍后重试",
      });
    }
  }, [chatId, mutate, mutateChatMessages, mutateRuntimeStatus, stop]);

  const loadedChatIds = useRef(new Set<string>());

  if (isNewChat && !loadedChatIds.current.has(newChatIdRef.current)) {
    loadedChatIds.current.add(newChatIdRef.current);
  }

  useEffect(() => {
    if (!chatData?.messages) {
      return;
    }

    const hasLoaded = loadedChatIds.current.has(chatId);
    const serverSignature = messagesSignature(chatData.messages);
    const localSignature = messagesSignature(messages);

    if (!hasLoaded || (status === "ready" && serverSignature !== localSignature)) {
      setMessages(chatData.messages);
      loadedChatIds.current.add(chatId);
    }
  }, [chatId, chatData?.messages, messages, setMessages, status]);

  const hadServerRunRunningRef = useRef(false);
  useEffect(() => {
    if (isServerRunRunning) {
      hadServerRunRunningRef.current = true;
      return;
    }

    if (hadServerRunRunningRef.current) {
      hadServerRunRunningRef.current = false;
      mutateChatMessages();
      mutate(CHAT_HISTORY_KEY);
    }
  }, [isServerRunRunning, mutate, mutateChatMessages]);

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      if (isNewChat) {
        setMessages([]);
      }
    }
  }, [chatId, isNewChat, setMessages]);

  useEffect(() => {
    if (chatData && !isNewChat) {
      const cookieModel = document.cookie
        .split("; ")
        .find((row) => row.startsWith("chat-model="))
        ?.split("=")[1];
      if (cookieModel) {
        setCurrentModelId(decodeURIComponent(cookieModel));
      }
    }
  }, [chatData, isNewChat]);

  const hasAppendedQueryRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("query");
    if (query && !hasAppendedQueryRef.current) {
      hasAppendedQueryRef.current = true;
      window.history.replaceState({}, "", `/chat/${chatId}`);
      sendMessage({
        role: "user" as const,
        parts: [{ type: "text", text: query }],
      });
    }
  }, [sendMessage, chatId]);

  // HTTP stream itself is not resumable yet. After refresh, keep the server run alive
  // and recover the final persisted message by polling runtime status/messages.
  useAutoResume({
    autoResume: false,
    initialMessages,
    resumeStream,
    setMessages,
  });

  const isReadonly = isNewChat ? false : (chatData?.isReadonly ?? false);

  const { data: votes } = useSWR<Vote[]>(
    !isReadonly && messages.length >= 2
      ? `chat-votes-${chatId}`
      : null,
    () => getVotesByChatId(chatId),
    { revalidateOnFocus: false }
  );

  const value = useMemo<ActiveChatContextValue>(
    () => ({
      chatId,
      messages,
      setMessages,
      sendMessage,
      status: displayedStatus,
      stop: stopGeneration,
      regenerate,
      addToolApprovalResponse,
      input,
      setInput,
      visibilityType: visibility,
      isReadonly,
      isLoading: !isNewChat && isLoading,
      votes,
      currentModelId,
      setCurrentModelId,
      showCreditCardAlert,
      setShowCreditCardAlert,
    }),
    [
      chatId,
      messages,
      setMessages,
      sendMessage,
      stopGeneration,
      regenerate,
      addToolApprovalResponse,
      input,
      visibility,
      isReadonly,
      isNewChat,
      isLoading,
      votes,
      currentModelId,
      showCreditCardAlert,
      displayedStatus,
    ]
  );

  return (
    <ActiveChatContext.Provider value={value}>
      {children}
    </ActiveChatContext.Provider>
  );
}

export function useActiveChat() {
  const context = useContext(ActiveChatContext);
  if (!context) {
    throw new Error("useActiveChat must be used within ActiveChatProvider");
  }
  return context;
}
