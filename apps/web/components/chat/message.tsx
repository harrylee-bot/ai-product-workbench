"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { Fragment, useMemo } from "react";
import type { Vote } from "@/lib/api/types";
import type { ChatMessage, RuntimeProcessEvent } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "../ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { SparklesIcon } from "./icons";
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

  const hasAnyContent = message.parts?.some(
    (part) =>
      (part.type === "text" && part.text?.trim().length > 0) ||
      (part.type === "reasoning" &&
        "text" in part &&
        part.text?.trim().length > 0) ||
      isToolPart(part)
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

  const mergedReasoningText = useMemo(() => {
    let text = "";
    message.parts?.forEach((part: any) => {
      if (part.type !== "reasoning") return;
      if (!part.text || !part.text.trim()) return;
      text = text ? `${text}\n\n${part.text}` : part.text;
    });
    return text;
  }, [message.parts]);

  const liveThinkingText = useMemo(
    () => formatRuntimeEvents(thinkingTrace?.events),
    [thinkingTrace?.events]
  );
  const thinkingText = mergedReasoningText || liveThinkingText;
  const hasThinking = isAssistant && thinkingText.trim().length > 0;
  const thinkingDialog = hasThinking ? (
    <ReasoningDialog
      isLoading={isLoading || Boolean(thinkingTrace?.isStreaming)}
      reasoning={thinkingText}
    />
  ) : null;

  let hasVisibleToolBefore = false;
  const parts = message.parts?.map((part: any, index) => {
    const { type } = part;
    const key = `message-${message.id}-part-${index}`;

    if (type === "reasoning") {
      return null;
    }

    if (type === "text") {
      const shouldDivideFromTool = hasVisibleToolBefore;
      return (
        <Fragment key={key}>
          {shouldDivideFromTool ? <Divider /> : null}
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

    if (isToolPart(part)) {
      if (!isCanvasDocumentTool(part)) hasVisibleToolBefore = true;
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

  if (isThinking && !thinkingDialog) {
    return null;
  }

  const content = isThinking ? (
    thinkingDialog
  ) : (
    <>
      {attachments}
      {thinkingDialog}
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
  thinkingTrace,
}: {
  thinkingTrace?: ThinkingTrace;
}) => {
  const events = (thinkingTrace?.events ?? []).filter(isVisibleRuntimeEvent);
  if (events.length === 0) return null;

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

        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          {events.map((event, i) => (
            <ThinkingStep
              key={event.id}
              event={event}
              isLast={i === events.length - 1}
              isStreaming={thinkingTrace?.isStreaming ?? false}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

function ThinkingStep({
  event,
  isLast,
  isStreaming,
}: {
  event: RuntimeProcessEvent;
  isLast: boolean;
  isStreaming: boolean;
}) {
  const icon = stepIcon(event.kind);
  const isRunning = isLast && isStreaming && event.status === "running";

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-sm shrink-0" aria-hidden>
          {icon}
        </span>
        <span
          className={cn(
            "text-sm text-muted-foreground leading-snug",
            isRunning && "animate-pulse"
          )}
        >
          {event.label}
        </span>
        {isRunning && (
          <span className="ml-1 text-xs text-muted-foreground/60">…</span>
        )}
      </div>
      {event.detail && (
        <div className="ml-6 text-xs text-muted-foreground/70 whitespace-pre-wrap leading-relaxed border-l border-border/40 pl-2">
          {event.detail}
        </div>
      )}
    </div>
  );
}

function stepIcon(kind?: RuntimeProcessEvent["kind"]) {
  switch (kind) {
    case "knowledge":
      return "📚";
    case "tool":
      return "🔧";
    case "artifact":
      return "📎";
    case "document":
      return "📄";
    case "error":
      return "⚠️";
    default:
      return "💭";
  }
}

function Divider() {
  return <div className="my-1 h-px w-full bg-border/40" aria-hidden />;
}

function ReasoningDialog({
  isLoading,
  reasoning,
}: {
  isLoading: boolean;
  reasoning: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          className="w-fit text-muted-foreground"
          data-testid="message-reasoning"
          size="xs"
          type="button"
          variant="ghost"
        >
          查看思考内容
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>思考内容</DialogTitle>
        </DialogHeader>
        <Reasoning defaultOpen={true} isStreaming={isLoading}>
          <ReasoningTrigger getThinkingMessage={() => <p>思考内容</p>} />
          <ReasoningContent className="!text-foreground [&_*]:!text-foreground">
            {reasoning}
          </ReasoningContent>
        </Reasoning>
      </DialogContent>
    </Dialog>
  );
}

function formatRuntimeEvents(events?: RuntimeProcessEvent[]): string {
  return (events ?? [])
    .filter(isVisibleRuntimeEvent)
    .map((event) => {
      const detail = event.detail?.trim();
      return detail ? `- ${event.label}\n  ${detail}` : `- ${event.label}`;
    })
    .join("\n");
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
    return null;
  }

  const state = normalizeToolState(part);
  const errorText =
    part.errorText ??
    (part.output && typeof part.output === "object" && "error" in part.output
      ? String(part.output.error)
      : undefined);
  const output =
    errorText && part.output && typeof part.output === "object" && "error" in part.output
      ? undefined
      : part.output;
  const shouldOpenByDefault =
    state === "approval-requested" || state === "output-error";

  return (
    <Tool className="max-w-[min(100%,560px)]" defaultOpen={shouldOpenByDefault}>
      <ToolHeader
        state={state as any}
        toolName={part.toolName}
        type={part.type as any}
      />
      <ToolContent>
        {part.input !== undefined ? <ToolInput input={part.input} /> : null}
        <ToolOutput errorText={errorText} output={output} />
      </ToolContent>
    </Tool>
  );
}

function isToolPart(part: any) {
  const type = String(part?.type ?? "");
  return type === "dynamic-tool" || type.startsWith("tool-");
}

function isCanvasDocumentTool(part: any) {
  const kind = part?.output?.kind ?? part?.input?.kind;
  return (
    part?.type === "tool-createDocument" &&
    !part?.output?.error &&
    (kind === "text" || kind === "prototype")
  );
}

function normalizeToolState(part: any) {
  const state = part?.state;
  if (
    state === "approval-requested" ||
    state === "approval-responded" ||
    state === "input-available" ||
    state === "input-streaming" ||
    state === "output-available" ||
    state === "output-denied" ||
    state === "output-error"
  ) {
    return state;
  }
  if (part?.errorText || part?.output?.error) return "output-error";
  if (part?.output !== undefined) return "output-available";
  if (part?.input !== undefined) return "input-available";
  return "input-streaming";
}
