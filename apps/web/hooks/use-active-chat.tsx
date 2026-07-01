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
import {
  initialRuntimeProcess,
  useDataStream,
} from "@/components/chat/data-stream-provider";
import { CHAT_HISTORY_KEY } from "@/components/chat/sidebar-history";
import { toast } from "@/components/chat/toast";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { useAutoResume } from "@/hooks/use-auto-resume";
import type { Vote } from "@/lib/api/types";
import {
  type ChatRuntimeStatus,
  type ChatMessagesResponse,
  getChatMessages,
  getChatRuntimeStatus,
  getChatStreamUrl,
  getVotesByChatId,
  stopChatRun,
} from "@/lib/api/nest-client";
import { ChatbotError } from "@/lib/errors";
import type {
  ChatMessage,
  RuntimeProcessEvent,
  RuntimeProcessSnapshot,
} from "@/lib/types";
import { fetchWithErrorHandlers, generateUUID } from "@/lib/utils";

// v1: 单一固定模型。原 @/lib/ai/models 已删除；模型选择由 data-access agent 统一收敛。
const DEFAULT_CHAT_MODEL = "gpt-5.5";
const STREAM_RECOVERY_ATTEMPTS = 18;
const STREAM_RECOVERY_INTERVAL_MS = 1000;

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
  runtimeStatus?: ChatRuntimeStatus;
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
            return `${part.type}:${part.text ?? ""}`;
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
  const { setDataStream, runtimeProcess, setRuntimeProcess } = useDataStream();
  const { mutate } = useSWRConfig();

  const chatIdFromUrl = extractChatId(pathname);
  const isNewChat = !chatIdFromUrl;
  const newChatIdRef = useRef(generateUUID());
  const prevPathnameRef = useRef(pathname);
  const currentChatIdRef = useRef<string | null>(null);
  const activeRunChatIdRef = useRef<string | null>(null);
  const recoveryTokenRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);

  if (isNewChat && prevPathnameRef.current !== pathname) {
    newChatIdRef.current = generateUUID();
  }
  prevPathnameRef.current = pathname;

  const chatId = chatIdFromUrl ?? newChatIdRef.current;
  currentChatIdRef.current = chatId;

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
    sendMessage: rawSendMessage,
    status,
    stop: rawStop,
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
      activeRunChatIdRef.current = null;
      mutate(CHAT_HISTORY_KEY);
      mutateRuntimeStatus();
      mutateChatMessages();
    },
    onError: async (error) => {
      activeRunChatIdRef.current = null;
      const message = error instanceof Error ? error.message : "";
      const isRecoverableStreamError =
        /Load failed|Failed to fetch|NetworkError|fetch|aborted|abort/i.test(message);

      if (isRecoverableStreamError) {
        const recovered = await recoverPersistedReply({
          baseMessages: messagesRef.current,
          mutate,
          mutateChatMessages,
          mutateRuntimeStatus,
          recoveryTokenRef,
          setMessages,
          setRuntimeProcess,
          targetChatId: chatId,
          currentChatIdRef,
        });

        if (recovered) {
          return;
        }
      } else {
        void Promise.all([
          mutate(CHAT_HISTORY_KEY),
          mutateRuntimeStatus(),
          mutateChatMessages(),
        ]);
      }

      const failedAt = new Date().toISOString();
      setRuntimeProcess((current) => {
        if (current.status !== "running") {
          return current;
        }
        const errorEvent: RuntimeProcessEvent = {
          id: `${current.runId ?? chatId}:client-error:${failedAt}`,
          runId: current.runId,
          kind: "error",
          label: message || "生成连接中断",
          status: "failed",
          createdAt: failedAt,
        };
        return {
          ...current,
          status: "failed",
          endedAt: failedAt,
          title: "生成失败",
          events: [...(current.events ?? []), errorEvent].slice(-80),
        };
      });

      if (error.message?.includes("AI Gateway requires a valid credit card")) {
        setShowCreditCardAlert(true);
      } else if (error instanceof ChatbotError) {
        toast({ type: "error", description: error.message });
      } else {
        toast({
          type: "error",
          description: isRecoverableStreamError
            ? "连接中断，正在尝试恢复回复"
            : message || "出错了，请稍后重试",
        });
      }
    },
  });

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const beginClientRun = useCallback(() => {
    const startedAt = new Date().toISOString();
    activeRunChatIdRef.current = chatId;
    setDataStream([]);
    setRuntimeProcess({
      ...initialRuntimeProcess,
      status: "running",
      startedAt,
      title: "思考中...",
      events: [
        {
          id: `client:${chatId}:awaiting:${startedAt}`,
          kind: "status",
          label: "正在发送请求",
          status: "running",
          createdAt: startedAt,
        },
      ],
    });
  }, [chatId, setDataStream, setRuntimeProcess]);

  const sendMessage = useCallback<UseChatHelpers<ChatMessage>["sendMessage"]>(
    async (...args) => {
      beginClientRun();
      return rawSendMessage(...args);
    },
    [beginClientRun, rawSendMessage]
  );

  const latestRunStatus = runtimeStatus?.latestRun?.status;
  const hasLocalRunForCurrentChat =
    activeRunChatIdRef.current === chatId && runtimeProcess.status === "running";
  const isStaleSubmittedAfterTerminalRun =
    !isServerRunRunning &&
    !hasLocalRunForCurrentChat &&
    (isTerminalRuntimeStatus(runtimeProcess.status) ||
      isTerminalRuntimeStatus(latestRunStatus)) &&
    (status === "submitted" || status === "streaming");
  const displayedStatus = isStaleSubmittedAfterTerminalRun
    ? "ready"
    : isServerRunRunning && status === "ready"
      ? "submitted"
      : status;

  const stopGeneration = useCallback(async () => {
    const targetChatId = chatId;
    const hasLocalRunForTarget =
      activeRunChatIdRef.current === targetChatId &&
      (runtimeProcess.status === "running" ||
        status === "submitted" ||
        status === "streaming");
    if (!isServerRunRunning && !hasLocalRunForTarget) {
      rawStop();
      return;
    }

    let stopError: unknown;
    try {
      const result = await stopChatRun(targetChatId);
      const stoppedAt = new Date().toISOString();
      if (currentChatIdRef.current === targetChatId) {
        setRuntimeProcess((current) => {
          const stopEvent: RuntimeProcessEvent = {
            id: `${result.runId ?? current.runId ?? targetChatId}:client-cancelled:${stoppedAt}`,
            runId: result.runId ?? current.runId,
            kind: "status",
            label: "用户已停止本次生成",
            status: "completed",
            createdAt: stoppedAt,
          };
          return {
            ...current,
            runId: current.runId ?? result.runId,
            status: "cancelled",
            endedAt: stoppedAt,
            title: "已停止",
            events: [...(current.events ?? []), stopEvent].slice(-80),
          };
        });
      }
    } catch (error: any) {
      stopError = error;
    } finally {
      activeRunChatIdRef.current = null;
      setDataStream([]);
      await rawStop();
      await Promise.all([
        mutateRuntimeStatus(),
        mutateChatMessages(),
        mutate(CHAT_HISTORY_KEY),
      ]);
    }

    if (stopError) {
      toast({
        type: "error",
        description:
          stopError instanceof Error
            ? stopError.message
            : "停止生成失败，请稍后重试",
      });
    }
  }, [
    chatId,
    isServerRunRunning,
    mutate,
    mutateChatMessages,
    mutateRuntimeStatus,
    rawStop,
    runtimeProcess.status,
    setDataStream,
    setRuntimeProcess,
    status,
  ]);

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
    const canApplyServerMessages =
      status === "ready" || String(status) === "error";

    if (
      !hasLoaded ||
      (canApplyServerMessages &&
        serverSignature !== localSignature &&
        shouldApplyServerMessages(messages, chatData.messages))
    ) {
      setMessages(chatData.messages);
      loadedChatIds.current.add(chatId);
    }
  }, [
    chatId,
    chatData?.messages,
    messages,
    setMessages,
    status,
  ]);

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
      activeRunChatIdRef.current = null;
      recoveryTokenRef.current += 1;
      setDataStream([]);
      setRuntimeProcess(initialRuntimeProcess);
      if (isNewChat) {
        setMessages([]);
      }
    }
  }, [chatId, isNewChat, setDataStream, setMessages, setRuntimeProcess]);

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
      runtimeStatus,
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
      runtimeProcess.status,
      runtimeStatus,
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

function isTerminalRuntimeStatus(
  status?: "idle" | "running" | "succeeded" | "failed" | "cancelled"
) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function hasRecoveredAssistantMessage(
  localMessages: ChatMessage[],
  recoveredMessages: ChatMessage[],
) {
  const latestRecoveredMessage = recoveredMessages.at(-1);
  if (latestRecoveredMessage?.role !== "assistant") {
    return false;
  }
  return shouldApplyServerMessages(localMessages, recoveredMessages);
}

function findLastMessageIndex(
  messages: ChatMessage[],
  predicate: (message: ChatMessage) => boolean,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) {
      return index;
    }
  }
  return -1;
}

function shouldApplyServerMessages(
  localMessages: ChatMessage[],
  serverMessages: ChatMessage[],
) {
  if (serverMessages.length === 0) {
    return localMessages.length === 0;
  }
  if (localMessages.length === 0) {
    return true;
  }
  if (messagesSignature(localMessages) === messagesSignature(serverMessages)) {
    return false;
  }

  const latestLocalUserIndex = findLastMessageIndex(
    localMessages,
    (message) => message.role === "user",
  );
  if (latestLocalUserIndex === -1) {
    return serverMessages.length >= localMessages.length;
  }

  if (serverMessages.length <= latestLocalUserIndex) {
    return false;
  }

  const latestLocalUserText = textFromMessageParts(
    localMessages[latestLocalUserIndex],
  );
  const matchingServerUserIndex = findLastMessageIndex(
    serverMessages,
    (message) =>
      message.role === "user" &&
      textFromMessageParts(message) === latestLocalUserText,
  );
  if (matchingServerUserIndex === -1) {
    return false;
  }

  return serverMessages.some(
    (message, index) =>
      index > matchingServerUserIndex &&
      message.role === "assistant" &&
      hasAssistantVisibleContent(message),
  );
}

async function recoverPersistedReply(input: {
  baseMessages: ChatMessage[];
  currentChatIdRef: React.RefObject<string | null>;
  mutate: (key: string) => Promise<unknown> | unknown;
  mutateChatMessages: () => Promise<ChatMessagesResponse | undefined>;
  mutateRuntimeStatus: () => Promise<ChatRuntimeStatus | undefined>;
  recoveryTokenRef: React.RefObject<number>;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  setRuntimeProcess: Dispatch<SetStateAction<RuntimeProcessSnapshot>>;
  targetChatId: string;
}) {
  const token = input.recoveryTokenRef.current + 1;
  input.recoveryTokenRef.current = token;

  for (let attempt = 0; attempt < STREAM_RECOVERY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(STREAM_RECOVERY_INTERVAL_MS);
    }

    const [nextRuntimeStatus, nextChatData] = await Promise.all([
      input.mutateRuntimeStatus(),
      input.mutateChatMessages(),
      input.mutate(CHAT_HISTORY_KEY),
    ]).catch(() => [undefined, undefined, undefined] as const);

    if (
      input.recoveryTokenRef.current !== token ||
      input.currentChatIdRef.current !== input.targetChatId
    ) {
      return true;
    }

    const recoveredMessages = nextChatData?.messages ?? [];

    const snapshot = snapshotFromRuntimeStatus(nextRuntimeStatus);
    if (snapshot) {
      input.setRuntimeProcess(snapshot);
    }

    if (hasRecoveredAssistantMessage(input.baseMessages, recoveredMessages)) {
      input.setMessages(recoveredMessages);
      return true;
    }

    const latestRunStatus = nextRuntimeStatus?.latestRun?.status;
    if (latestRunStatus === "cancelled") {
      if (shouldApplyServerMessages(input.baseMessages, recoveredMessages)) {
        input.setMessages(recoveredMessages);
      }
      return true;
    }
    if (latestRunStatus === "failed") {
      if (shouldApplyServerMessages(input.baseMessages, recoveredMessages)) {
        input.setMessages(recoveredMessages);
      }
      return false;
    }
  }

  return false;
}

function hasAssistantVisibleContent(message: ChatMessage) {
  return message.parts.some((part: any) => {
    if (part.type === "text") {
      return Boolean(part.text?.trim());
    }
    if (part.type === "reasoning") {
      return Boolean(part.text?.trim());
    }
    if (String(part.type ?? "").startsWith("tool-")) {
      return part.state === "output-available" || part.output !== undefined;
    }
    return false;
  });
}

function textFromMessageParts(message: ChatMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function snapshotFromRuntimeStatus(
  runtimeStatus?: ChatRuntimeStatus,
): RuntimeProcessSnapshot | undefined {
  const latestRun = runtimeStatus?.latestRun;
  if (!latestRun) return undefined;

  return {
    runId: latestRun.id,
    status: latestRun.status,
    startedAt: latestRun.startedAt,
    endedAt: latestRun.endedAt,
    title:
      latestRun.status === "succeeded"
        ? "已完成"
        : latestRun.status === "failed"
          ? "生成失败"
          : latestRun.status === "cancelled"
            ? "已停止"
            : "思考中...",
    events: latestRun.events ?? [],
  };
}
