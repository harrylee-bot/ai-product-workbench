"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { Fragment, useMemo } from "react";
import type { Vote } from "@/lib/api/types";
import type { ChatMessage, RuntimeProcessSnapshot } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { PreviewAttachment } from "./preview-attachment";
import {
  RuntimeProcessChain,
  shouldShowRuntimeProcess,
} from "./runtime-process";

const PurePreviewMessage = ({
  addToolApprovalResponse: _addToolApprovalResponse,
  chatId,
  message,
  vote,
  isLoading,
  setMessages: _setMessages,
  regenerate: _regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  onEdit,
  runtimeProcess,
  showRuntimeProcess,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  message: ChatMessage;
  vote: Vote | undefined;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  onEdit?: (message: ChatMessage) => void;
  runtimeProcess?: RuntimeProcessSnapshot;
  showRuntimeProcess?: boolean;
}) => {
  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const hasAnyContent = message.parts?.some(
    (part) =>
      (part.type === "text" && part.text?.trim().length > 0) ||
      (part.type === "reasoning" &&
        "text" in part &&
        part.text?.trim().length > 0) ||
      part.type.startsWith("tool-")
  );
  const isThinking = isAssistant && isLoading && !hasAnyContent;

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

  const { firstReasoningIndex, mergedReasoningText } = useMemo(() => {
    let firstIndex = -1;
    let text = "";
    message.parts?.forEach((part: any, index: number) => {
      if (part.type !== "reasoning") return;
      if (!part.text || !part.text.trim()) return;
      if (firstIndex === -1) firstIndex = index;
      text = text ? `${text}\n\n${part.text}` : part.text;
    });
    return { firstReasoningIndex: firstIndex, mergedReasoningText: text };
  }, [message.parts]);

  const parts = message.parts?.map((part: any, index) => {
    const { type } = part;
    const key = `message-${message.id}-part-${index}`;

    if (type === "reasoning") {
      if (index === firstReasoningIndex && mergedReasoningText) {
        return (
          <div
            className="text-[13px] leading-[1.65] text-muted-foreground/85 italic"
            data-testid="message-reasoning"
            key={key}
          >
            {mergedReasoningText}
          </div>
        );
      }
      return null;
    }

    // 在首个 text（正文答案）前插分隔线，把上面的想法/工具与下面的答案分开。
    if (type === "text") {
      const hasProcessBefore = message.parts
        ?.slice(0, index)
        .some(
          (p: any) =>
            p.type === "reasoning" || String(p.type ?? "").startsWith("tool-"),
        );
      return (
        <Fragment key={key}>
          {hasProcessBefore ? <Divider /> : null}
          <MessageContent
            className={cn("text-[13px] leading-[1.65]", {
              "w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 shadow-[var(--shadow-card)]":
                message.role === "user",
            })}
            data-testid="message-content"
          >
            <MessageResponse>{sanitizeText(part.text)}</MessageResponse>
          </MessageContent>
        </Fragment>
      );
    }

    if (type === "tool-createDocument") {
      const { state, toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            创建文档失败：{String(part.output.error)}
          </div>
        );
      }

      void state;
      return null;
    }

    if (type.startsWith("tool-")) {
      return null;
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

  const runtimeProcessNode =
    isAssistant &&
    Boolean(showRuntimeProcess) &&
    shouldShowRuntimeProcess(runtimeProcess, hasAnyContent) ? (
      <RuntimeProcessChain runtimeProcess={runtimeProcess} />
    ) : null;

  const content = isThinking ? (
    runtimeProcessNode ?? <ThinkingText />
  ) : (
    <>
      {runtimeProcessNode}
      {runtimeProcessNode && hasAnyContent ? <Divider /> : null}
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
            <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
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
  runtimeProcess,
}: {
  runtimeProcess?: RuntimeProcessSnapshot;
}) => {
  return (
    <div
      className="group/message w-full"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
          <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
            <SparklesIcon size={13} />
          </div>
        </div>

        {shouldShowRuntimeProcess(runtimeProcess, false) ? (
          <RuntimeProcessChain runtimeProcess={runtimeProcess} />
        ) : (
          <ThinkingText />
        )}
      </div>
    </div>
  );
};

function ThinkingText() {
  return (
    <div className="flex h-[calc(13px*1.65)] items-center text-[13px] leading-[1.65]">
      <Shimmer className="font-medium text-muted-foreground" duration={1}>
        思考中...
      </Shimmer>
    </div>
  );
}

function Divider() {
  return <div className="my-1 h-px w-full bg-border/40" aria-hidden />;
}
