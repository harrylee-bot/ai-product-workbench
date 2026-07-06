"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { Fragment, useMemo } from "react";
import type { Vote } from "@/lib/api/types";
import type { ChatMessage, RuntimeProcessEvent } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { CanvasDocumentCard } from "./canvas-document-card";
import { LoaderIcon, SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { PreviewAttachment } from "./preview-attachment";

export type ThinkingTrace = {
  events?: RuntimeProcessEvent[];
  isStreaming?: boolean;
};

const PurePreviewMessage = ({
  addToolApprovalResponse: _addToolApprovalResponse,
  chatId,
  message,
  vote,
  isLoading,
  thinkingTrace,
  setMessages: _setMessages,
  regenerate: _regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  onEdit,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  message: ChatMessage;
  vote: Vote | undefined;
  isLoading: boolean;
  thinkingTrace?: ThinkingTrace;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  onEdit?: (message: ChatMessage) => void;
}) => {
  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const hasAttachments = attachmentsFromMessage.length > 0;
  const hasVisibleContent = message.parts?.some(
    (part) =>
      (part.type === "text" && part.text?.trim().length > 0) ||
      isVisibleToolPart(part)
  );
  const isThinking = isAssistant && isLoading && !hasVisibleContent;

  const attachments = attachmentsFromMessage.length > 0 && (
    <div
      className="flex flex-row justify-end gap-2"
      data-testid={"message-attachments"}
    >
      {attachmentsFromMessage.map((attachment) => (
        <PreviewAttachment
          attachment={{
            name: attachment.filename ?? "file",
            contentType: attachment.mediaType,
            url: attachment.url,
          }}
          key={attachment.url}
        />
      ))}
    </div>
  );

  let hasVisibleToolBefore = false;
  const parts = message.parts?.map((part: any, index) => {
    const { type } = part;
    const key = `message-${message.id}-part-${index}`;

    if (type === "reasoning") {
      return null;
    }

    if (type === "text") {
      if (!part.text?.trim()) return null;
      const shouldDivideFromTool = hasVisibleToolBefore;
      return (
        <Fragment key={key}>
          {shouldDivideFromTool ? <Divider /> : null}
          <MessageContent
            className={cn("text-[13px] leading-[1.65]", {
              "w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/70 bg-card/80 px-3.5 py-2 shadow-[var(--shadow-card)] backdrop-blur-xl":
                message.role === "user",
            })}
            data-testid="message-content"
          >
            <MessageResponse>{sanitizeText(part.text)}</MessageResponse>
          </MessageContent>
        </Fragment>
      );
    }

    if (isToolPart(part)) {
      if (!isVisibleToolPart(part)) return null;
      hasVisibleToolBefore = true;
      return <MessageToolPart key={key} part={part} />;
    }

    return null;
  });

  const actions = !isReadonly && (
    <MessageActions
      chatId={chatId}
      isLoading={isLoading}
      key={`action-${message.id}`}
      message={message}
      onEdit={onEdit ? () => onEdit(message) : undefined}
      vote={vote}
    />
  );

  if (!hasAttachments && !hasVisibleContent && !isThinking) {
    return null;
  }

  const content = isThinking ? (
    <CompactGenerationStatus thinkingTrace={thinkingTrace} />
  ) : (
    <>
      {attachments}
      {parts}
      {actions}
    </>
  );

  return (
    <div
      className={cn(
        "group/message w-full",
        !isAssistant && "animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]"
      )}
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn(
          isUser ? "flex flex-col items-end gap-2" : "flex items-start gap-3"
        )}
      >
        {isAssistant && (
          <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
            <div className="flex size-7 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground ring-1 ring-border/70">
              <SparklesIcon size={13} />
            </div>
          </div>
        )}
        {isAssistant ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">{content}</div>
        ) : (
          content
        )}
      </div>
    </div>
  );
};

export const PreviewMessage = PurePreviewMessage;

export const ThinkingMessage = ({
  thinkingTrace,
}: {
  thinkingTrace?: ThinkingTrace;
}) => {
  return (
    <div
      className="group/message w-full"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
          <div className="flex size-7 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground ring-1 ring-border/70">
            <SparklesIcon size={13} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <CompactGenerationStatus thinkingTrace={thinkingTrace} />
        </div>
      </div>
    </div>
  );
};

function CompactGenerationStatus({
  thinkingTrace,
}: {
  thinkingTrace?: ThinkingTrace;
}) {
  const statusCopy = useMemo(
    () => compactStatusFromTrace(thinkingTrace),
    [thinkingTrace]
  );

  return (
    <div
      className={cn(
        "flex w-fit max-w-[min(100%,42ch)] items-center gap-2 rounded-full border border-border/60 bg-card/70 px-3 py-1.5 text-xs leading-snug text-muted-foreground shadow-[var(--shadow-card)] backdrop-blur-xl",
        statusCopy.tone === "error" && "border-destructive/30 text-destructive"
      )}
      data-testid="generation-status"
    >
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center",
          statusCopy.tone !== "error" && "animate-spin"
        )}
        aria-hidden
      >
        <LoaderIcon size={14} />
      </span>
      <span className="truncate">{statusCopy.label}</span>
    </div>
  );
}

function compactStatusFromTrace(thinkingTrace?: ThinkingTrace): {
  label: string;
  tone?: "default" | "error";
} {
  const events = (thinkingTrace?.events ?? []).filter(isVisibleRuntimeEvent);
  const latestFailure = [...events]
    .reverse()
    .find((event) => event.kind === "error" || event.status === "failed");
  if (latestFailure) {
    return { label: "生成遇到问题，正在尝试恢复", tone: "error" };
  }

  const latestArtifact = [...events]
    .reverse()
    .find((event) => event.artifact?.kind);
  if (latestArtifact?.artifact?.kind === "prototype") {
    return { label: "正在生成原型" };
  }
  if (latestArtifact?.artifact?.kind) {
    return { label: "正在生成需求文档" };
  }

  const latest = events.at(-1);
  if (!latest) return { label: "正在准备内容" };

  if (latest.kind === "knowledge") {
    return { label: "正在整理参考资料" };
  }
  if (latest.kind === "document") {
    return { label: "正在生成需求文档" };
  }
  if (latest.kind === "artifact") {
    return { label: "正在生成产物" };
  }
  return { label: "正在生成内容" };
}

function Divider() {
  return <div className="my-1 h-px w-full bg-border/40" aria-hidden />;
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

function MessageToolPart({ part }: { part: any }) {
  if (isCanvasDocumentTool(part)) {
    const canvasDocument = getCanvasDocumentFromToolPart(part);
    if (!canvasDocument) return null;
    return <CanvasDocumentCard {...canvasDocument} />;
  }

  const fallback = getVisibleToolFallback(part);
  if (!fallback) return null;
  return <ToolConversationText tone={fallback.tone} text={fallback.text} />;
}

function ToolConversationText({
  text,
  tone = "default",
}: {
  text: string;
  tone?: "default" | "destructive";
}) {
  return (
    <div
      className={cn(
        "max-w-[min(100%,48ch)] text-[13px] leading-[1.65]",
        tone === "destructive" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {text}
    </div>
  );
}

function isToolPart(part: any) {
  const type = String(part?.type ?? "");
  return type === "dynamic-tool" || type.startsWith("tool-");
}

function isVisibleToolPart(part: any) {
  return isCanvasDocumentTool(part) || getVisibleToolFallback(part) !== null;
}

function isCanvasDocumentTool(part: any) {
  return getCanvasDocumentFromToolPart(part) !== null;
}

function getCanvasDocumentFromToolPart(part: any) {
  if (part?.type !== "tool-createDocument" || part?.output?.error) {
    return null;
  }

  const kind = part?.output?.kind ?? part?.input?.kind;
  if (kind !== "text" && kind !== "prototype" && kind !== "prd") {
    return null;
  }

  const documentId = part?.output?.id ?? part?.input?.id;
  if (typeof documentId !== "string" || documentId.length === 0) {
    return null;
  }

  const fallbackTitle = kind === "prototype" ? "原型" : "产品需求文档";
  const title =
    typeof part?.output?.title === "string" && part.output.title.length > 0
      ? part.output.title
      : typeof part?.input?.title === "string" && part.input.title.length > 0
        ? part.input.title
        : fallbackTitle;

  return {
    documentId,
    kind: kind === "prd" ? "text" : kind,
    title,
    status: "idle" as const,
  };
}

function getVisibleToolFallback(part: any): {
  text: string;
  tone: "default" | "destructive";
} | null {
  const state = String(part?.state ?? "");
  const hasError =
    Boolean(part?.errorText) ||
    state === "output-error" ||
    (part?.output && typeof part.output === "object" && "error" in part.output);

  if (hasError) {
    return {
      text: "这一步没有完成，可以重试或继续补充要求。",
      tone: "destructive",
    };
  }

  if (state === "approval-requested") {
    return { text: "需要确认后继续。", tone: "default" };
  }

  if (state === "output-denied") {
    return { text: "已取消这一步。", tone: "default" };
  }

  return null;
}
