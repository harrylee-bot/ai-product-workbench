import type { UseChatHelpers } from "@ai-sdk/react";
import { ArrowDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useArtifactSelector } from "@/hooks/use-artifact";
import { useMessages } from "@/hooks/use-messages";
import type { ChatRuntimeStatus } from "@/lib/api/nest-client";
import type { Vote } from "@/lib/api/types";
import type {
  ChatMessage,
  RuntimeProcessEvent,
  RuntimeProcessSnapshot,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ArtifactKind, UIArtifact } from "./artifact";
import { CanvasDocumentCard } from "./canvas-document-card";
import { useDataStream } from "./data-stream-provider";
import { Greeting } from "./greeting";
import { SparklesIcon } from "./icons";
import { PreviewMessage, ThinkingMessage, type ThinkingTrace } from "./message";

type MessagesProps = {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  status: UseChatHelpers<ChatMessage>["status"];
  votes: Vote[] | undefined;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  isArtifactVisible: boolean;
  isLoading?: boolean;
  selectedModelId: string;
  runStatus?: ChatRuntimeStatus;
  onEditMessage?: (message: ChatMessage) => void;
};

function PureMessages({
  addToolApprovalResponse,
  chatId,
  status,
  votes,
  messages,
  setMessages,
  regenerate,
  isReadonly,
  isArtifactVisible,
  isLoading,
  selectedModelId: _selectedModelId,
  runStatus,
  onEditMessage,
}: MessagesProps) {
  const { runtimeProcess: liveRun } = useDataStream();
  const liveArtifact = useArtifactSelector((artifact) => artifact);
  const {
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    isAtBottom,
    scrollToBottom,
    hasSentMessage,
    reset,
  } = useMessages({
    status,
  });

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      reset();
    }
  }, [chatId, reset]);

  const liveTrace = useMemo(() => traceFromSnapshot(liveRun), [liveRun]);
  const savedTrace = useMemo(() => traceFromRunStatus(runStatus), [runStatus]);
  const canUseSavedTrace =
    status === "ready" || runStatus?.latestRun?.status === "running";
  const activeTrace = liveTrace ?? (canUseSavedTrace ? savedTrace : undefined);
  const latestAssistantIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") return index;
    }
    return -1;
  }, [messages]);
  const voteByMessageId = useMemo(
    () => new Map((votes ?? []).map((vote) => [vote.messageId, vote])),
    [votes]
  );
  const isAwaitingAssistant =
    status === "submitted" && messages.at(-1)?.role !== "assistant";
  const liveCanvasDocument = useMemo(
    () => getLiveCanvasDocument(liveArtifact, messages, status),
    [liveArtifact, messages, status]
  );

  return (
    <div className="relative flex-1 bg-transparent">
      {messages.length === 0 && !isLoading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <Greeting />
        </div>
      )}
      <div
        className={cn(
          "absolute inset-0 touch-pan-y overflow-y-auto",
          messages.length > 0 ? "bg-transparent" : "bg-transparent"
        )}
        ref={messagesContainerRef}
        style={isArtifactVisible ? { scrollbarWidth: "none" } : undefined}
      >
        <div className="mx-auto flex min-h-full min-w-0 max-w-4xl flex-col gap-5 px-2 py-6 md:gap-7 md:px-4">
          {messages.map((message, index) => (
            <PreviewMessage
              addToolApprovalResponse={addToolApprovalResponse}
              chatId={chatId}
              isLoading={
                status === "streaming" && messages.length - 1 === index
              }
              isReadonly={isReadonly}
              key={message.id}
              message={message}
              onEdit={onEditMessage}
              regenerate={regenerate}
              requiresScrollPadding={
                hasSentMessage && index === messages.length - 1
              }
              setMessages={setMessages}
              thinkingTrace={
                !isAwaitingAssistant &&
                index === latestAssistantIndex &&
                message.role === "assistant"
                  ? activeTrace
                  : undefined
              }
              vote={voteByMessageId.get(message.id)}
            />
          ))}

          {isAwaitingAssistant && (
            <ThinkingMessage thinkingTrace={activeTrace} />
          )}

          {liveCanvasDocument ? (
            <LiveCanvasDocumentMessage document={liveCanvasDocument} />
          ) : null}

          <div
            className="min-h-[24px] min-w-[24px] shrink-0"
            ref={messagesEndRef}
          />
        </div>
      </div>

      <button
        aria-label="滚动到底部"
        className={`absolute bottom-4 left-1/2 z-10 flex h-7 -translate-x-1/2 items-center rounded-full border border-border/70 bg-card/90 px-3.5 text-[10px] shadow-[var(--shadow-float)] backdrop-blur-xl transition-all duration-200 ${
          isAtBottom
            ? "pointer-events-none scale-90 opacity-0"
            : "pointer-events-auto scale-100 opacity-100"
        }`}
        onClick={() => scrollToBottom("smooth")}
        type="button"
      >
        <ArrowDownIcon className="size-3 text-muted-foreground" />
      </button>
    </div>
  );
}

export const Messages = PureMessages;

function LiveCanvasDocumentMessage({
  document,
}: {
  document: {
    documentId: string;
    kind: ArtifactKind;
    title: string;
    status: "streaming" | "idle";
  };
}) {
  return (
    <div
      className="group/message w-full"
      data-role="assistant"
      data-testid="live-canvas-document-message"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
          <div className="flex size-7 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground ring-1 ring-border/70">
            <SparklesIcon size={13} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <CanvasDocumentCard {...document} />
        </div>
      </div>
    </div>
  );
}

function traceFromSnapshot(
  snapshot: RuntimeProcessSnapshot,
): ThinkingTrace | undefined {
  return buildTrace(snapshot.status, snapshot.events);
}

function traceFromRunStatus(
  runStatus?: ChatRuntimeStatus,
): ThinkingTrace | undefined {
  const latestRun = runStatus?.latestRun;
  if (!latestRun) return undefined;
  return buildTrace(latestRun.status, latestRun.events);
}

function buildTrace(
  status: RuntimeProcessSnapshot["status"],
  events?: RuntimeProcessEvent[],
): ThinkingTrace | undefined {
  const visibleEvents = (events ?? []).filter(isVisibleRuntimeEvent);
  if (visibleEvents.length === 0) return undefined;
  return {
    events: visibleEvents,
    isStreaming: status === "running",
  };
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

function getLiveCanvasDocument(
  artifact: UIArtifact,
  messages: ChatMessage[],
  status: UseChatHelpers<ChatMessage>["status"],
) {
  const isGenerating = status === "submitted" || status === "streaming";
  if (!isGenerating && artifact.status !== "streaming") {
    return null;
  }

  const kind = normalizeCanvasKind(artifact.kind);
  if (!kind) {
    return null;
  }

  const hasDocumentIdentity =
    artifact.documentId !== "init" || artifact.title.trim() || artifact.content.trim();
  if (!hasDocumentIdentity) {
    return null;
  }

  if (
    artifact.documentId !== "init" &&
    messages.some((message) => messageHasCanvasDocument(message, artifact.documentId))
  ) {
    return null;
  }

  return {
    documentId: artifact.documentId,
    kind,
    title: artifact.title || (kind === "prototype" ? "原型" : "产品需求文档"),
    status: artifact.status,
  };
}

function messageHasCanvasDocument(message: ChatMessage, documentId: string) {
  return message.parts?.some((part: any) => {
    if (part?.type !== "tool-createDocument" || part?.output?.error) {
      return false;
    }
    return part?.output?.id === documentId || part?.input?.id === documentId;
  });
}

function normalizeCanvasKind(kind: ArtifactKind): ArtifactKind | null {
  if (kind === "text" || kind === "prototype") {
    return kind;
  }
  if (kind === "prd") {
    return "text";
  }
  return null;
}
