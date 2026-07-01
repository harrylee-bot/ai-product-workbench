"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  Loader2Icon,
  SquareTerminalIcon,
  XCircleIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { Vote } from "@/lib/api/types";
import type {
  ChatMessage,
  RuntimeProcessEvent,
  RuntimeProcessSnapshot,
} from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { PreviewAttachment } from "./preview-attachment";
import { Weather } from "./weather";

const PurePreviewMessage = ({
  addToolApprovalResponse,
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

  useDataStream();

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

  const { firstReasoningIndex, mergedReasoningText, reasoningIsStreaming } = useMemo(() => {
    let firstIndex = -1;
    let text = "";
    let isStreaming = false;
    message.parts?.forEach((part: any, index: number) => {
      if (part.type !== "reasoning") return;
      if (!part.text || !part.text.trim()) return;
      if (firstIndex === -1) firstIndex = index;
      text = text ? `${text}\n\n${part.text}` : part.text;
      if ("state" in part && part.state === "streaming") isStreaming = true;
    });
    return { firstReasoningIndex: firstIndex, mergedReasoningText: text, reasoningIsStreaming: isStreaming };
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

    if (type === "tool-getWeather") {
      const { toolCallId, state } = part;
      const approvalId = (part as { approval?: { id: string } }).approval?.id;
      const isDenied =
        state === "output-denied" ||
        (state === "approval-responded" &&
          (part as { approval?: { approved?: boolean } }).approval?.approved ===
            false);
      const widthClass = "w-[min(100%,450px)]";

      if (state === "output-available") {
        return (
          <div className={widthClass} key={toolCallId}>
            <Weather weatherAtLocation={part.output} />
          </div>
        );
      }

      if (isDenied) {
        return (
          <div className={widthClass} key={toolCallId}>
            <Tool className="w-full" defaultOpen={true}>
              <ToolHeader state="output-denied" type="tool-getWeather" />
              <ToolContent>
                <div className="px-4 py-3 text-muted-foreground text-sm">
                  已拒绝天气查询。
                </div>
              </ToolContent>
            </Tool>
          </div>
        );
      }

      if (state === "approval-responded") {
        return (
          <div className={widthClass} key={toolCallId}>
            <Tool className="w-full" defaultOpen={true}>
              <ToolHeader state={state} type="tool-getWeather" />
              <ToolContent>
                <ToolInput input={part.input} />
              </ToolContent>
            </Tool>
          </div>
        );
      }

      return (
        <div className={widthClass} key={toolCallId}>
          <Tool className="w-full" defaultOpen={true}>
            <ToolHeader state={state} type="tool-getWeather" />
            <ToolContent>
              {(state === "input-available" ||
                state === "approval-requested") && (
                <ToolInput input={part.input} />
              )}
              {state === "approval-requested" && approvalId && (
                <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                  <button
                    className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      addToolApprovalResponse({
                        id: approvalId,
                        approved: false,
                        reason: "用户拒绝天气查询",
                      });
                    }}
                    type="button"
                  >
                    拒绝
                  </button>
                  <button
                    className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                    onClick={() => {
                      addToolApprovalResponse({
                        id: approvalId,
                        approved: true,
                      });
                    }}
                    type="button"
                  >
                    允许
                  </button>
                </div>
              )}
            </ToolContent>
          </Tool>
        </div>
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

      if (state !== "output-available" || !part.output) {
        return <CompactToolPart key={toolCallId} part={part} />;
      }

      return (
        <DocumentPreview
          isReadonly={isReadonly}
          key={toolCallId}
          result={part.output}
        />
      );
    }

    if (type === "tool-updateDocument") {
      const { state, toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            更新文档失败：{String(part.output.error)}
          </div>
        );
      }

      if (state !== "output-available" || !part.output) {
        return <CompactToolPart key={toolCallId} part={part} />;
      }

      return (
        <div className="relative" key={toolCallId}>
          <DocumentPreview
            args={{ ...part.output, isUpdate: true }}
            isReadonly={isReadonly}
            result={part.output}
          />
        </div>
      );
    }

    if (type === "tool-requestSuggestions") {
      const { toolCallId, state } = part;

      return (
        <Tool
          className="w-[min(100%,450px)]"
          defaultOpen={true}
          key={toolCallId}
        >
          <ToolHeader state={state} type="tool-requestSuggestions" />
          <ToolContent>
            {state === "input-available" && <ToolInput input={part.input} />}
            {state === "output-available" && (
              <ToolOutput
                errorText={undefined}
                output={
                  "error" in part.output ? (
                    <div className="rounded border p-2 text-red-500">
                      错误：{String(part.output.error)}
                    </div>
                  ) : (
                    <DocumentToolResult
                      isReadonly={isReadonly}
                      result={part.output}
                      type="request-suggestions"
                    />
                  )
                }
              />
            )}
          </ToolContent>
        </Tool>
      );
    }

    if (type.startsWith("tool-")) {
      return <ToolLineText key={part.toolCallId ?? key} part={part} />;
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

  const showThinkingText =
    isAssistant &&
    Boolean(showRuntimeProcess) &&
    shouldShowRuntimeStatus(runtimeProcess, hasAnyContent);
  const thinkingText = showThinkingText ? (
    <ThinkingText runtimeProcess={runtimeProcess} />
  ) : null;

  const content = isThinking ? (
    thinkingText ?? <ThinkingText runtimeProcess={runtimeProcess} />
  ) : (
    <>
      {thinkingText}
      {thinkingText && hasAnyContent ? <Divider /> : null}
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
  if (!shouldShowRuntimeStatus(runtimeProcess, false)) {
    return null;
  }

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

        <ThinkingText runtimeProcess={runtimeProcess} />
      </div>
    </div>
  );
};

function ThinkingText({
  runtimeProcess,
}: {
  runtimeProcess?: RuntimeProcessSnapshot;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <RuntimeStatusLine
        hasAssistantContent={false}
        runtimeProcess={runtimeProcess}
      />
      <RuntimeEventList runtimeProcess={runtimeProcess} />
    </div>
  );
}

function RuntimeEventList({
  runtimeProcess,
}: {
  runtimeProcess?: RuntimeProcessSnapshot;
}) {
  const visibleEvents = (runtimeProcess?.events ?? []).filter(isVisibleRuntimeEvent);
  if (visibleEvents.length === 0) {
    return null;
  }

  const maxVisibleEvents = 16;
  const hiddenCount = Math.max(0, visibleEvents.length - maxVisibleEvents);
  const eventsToRender = visibleEvents.slice(-maxVisibleEvents);

  return (
    <div className="flex min-w-0 max-w-[min(100%,680px)] flex-col gap-1">
      {hiddenCount > 0 ? (
        <div className="pl-5 text-[11px] leading-[1.6] text-muted-foreground/55">
          还有 {hiddenCount} 条过程记录
        </div>
      ) : null}
      {eventsToRender.map((event) => (
        <RuntimeEventRow event={event} key={event.id} />
      ))}
    </div>
  );
}

function RuntimeEventRow({ event }: { event: RuntimeProcessEvent }) {
  const row = (
    <div className="flex min-w-0 items-start gap-2 text-[12px] leading-[1.6] text-muted-foreground/75">
      <RuntimeEventIcon event={event} />
      <span className="mt-px shrink-0 text-muted-foreground/50">
        {runtimeEventKindLabel(event.kind)}
      </span>
      <span className="min-w-0 flex-1 break-words">{event.label}</span>
      {event.detail ? (
        <ChevronRightIcon className="mt-1 size-3 shrink-0 transition-transform group-open:rotate-90" />
      ) : null}
    </div>
  );

  if (!event.detail) {
    return row;
  }

  return (
    <details className="group min-w-0">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        {row}
      </summary>
      <pre className="ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/25 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground/70">
        {event.detail}
      </pre>
    </details>
  );
}

function RuntimeEventIcon({ event }: { event: RuntimeProcessEvent }) {
  if (event.status === "running") {
    return (
      <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground/65" />
    );
  }
  if (event.status === "failed" || event.kind === "error") {
    return (
      <XCircleIcon className="mt-0.5 size-3.5 shrink-0 text-red-500/80" />
    );
  }
  return (
    <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/65" />
  );
}

function runtimeEventKindLabel(kind: RuntimeProcessEvent["kind"]) {
  switch (kind) {
    case "knowledge":
      return "知识";
    case "tool":
      return "工具";
    case "artifact":
      return "产物";
    case "document":
      return "文档";
    case "error":
      return "错误";
    default:
      return "步骤";
  }
}

/**
 * 工具调用压缩成一行文字：`· name · 进行中/完成/失败`，不用卡片。
 */
function ToolLineText({ part }: { part: any }) {
  const state = String(part.state ?? "");
  const isRunning =
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested" ||
    state === "approval-responded";
  const isFailed = state === "output-error" || state === "output-denied";
  const toolName = formatToolName(
    part.toolName ?? String(part.type ?? "").replace(/^tool-/, ""),
  );
  const statusLabel = isFailed
    ? "失败"
    : state === "output-available"
      ? "完成"
      : isRunning
        ? "进行中"
        : "";
  return (
    <div className="text-[12px] leading-[1.6] text-muted-foreground/70">
      · {toolName}
      {statusLabel ? <> · {statusLabel}</> : null}
    </div>
  );
}

function Divider() {
  return <div className="my-1 h-px w-full bg-border/40" aria-hidden />;
}

function RuntimeStatusLine({
  hasAssistantContent,
  runtimeProcess,
}: {
  hasAssistantContent: boolean;
  runtimeProcess?: RuntimeProcessSnapshot;
}) {
  const activityStartedAt = firstVisibleRuntimeEvent(runtimeProcess)?.createdAt;
  const observedStartedAt = useObservedStart(
    Boolean(
      runtimeProcess?.status === "running" &&
        (hasAssistantContent || activityStartedAt)
    )
  );
  const startedAt =
    activityStartedAt ??
    observedStartedAt ??
    (runtimeProcess?.status === "running" ? undefined : runtimeProcess?.startedAt);
  const endedAt = runtimeProcess?.endedAt ?? null;
  const isRunning = runtimeProcess?.status === "running";
  const elapsedMs = useElapsedMs(startedAt, endedAt, isRunning);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-[1.65]">
      {isRunning ? (
        <Shimmer className="font-medium text-muted-foreground" duration={1}>
          思考中...
        </Shimmer>
      ) : (
        <span className="font-medium text-muted-foreground">
          {statusText(runtimeProcess?.status)}
        </span>
      )}
      {startedAt ? (
        <span className="text-[12px] tabular-nums text-muted-foreground">
          已处理 {formatElapsed(elapsedMs)}
        </span>
      ) : null}
    </div>
  );
}

function CompactToolPart({ part }: { part: any }) {
  const state = String(part.state ?? "");
  const isRunning =
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested" ||
    state === "approval-responded";
  const isFailed = state === "output-error" || state === "output-denied";
  const toolName = formatToolName(
    part.toolName ?? String(part.type ?? "").replace(/^tool-/, "")
  );
  const title = isFailed
    ? `${toolName} 运行失败`
    : state === "output-available"
      ? `${toolName} 已完成`
      : isRunning
        ? `正在运行 ${toolName}`
        : toolName;
  const detail = formatToolPayload(part);
  const row = (
    <div className="flex min-w-0 items-center gap-2 text-[13px] leading-[1.65] text-muted-foreground">
      {isFailed ? (
        <XCircleIcon className="size-3.5 shrink-0 text-red-500" />
      ) : isRunning ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <CheckCircle2Icon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <SquareTerminalIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
      <span className="truncate">{title}</span>
      {detail ? (
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
      ) : null}
    </div>
  );

  if (!detail) {
    return <div key={part.toolCallId ?? `${part.type}-${state}`}>{row}</div>;
  }

  return (
    <details
      className="group max-w-[min(100%,680px)] text-[13px]"
      key={part.toolCallId ?? `${part.type}-${state}`}
    >
      <summary className="flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
        {row}
      </summary>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted/35 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
        {detail}
      </pre>
    </details>
  );
}

function useElapsedMs(
  startedAt?: string,
  endedAt?: string | null,
  isRunning = false,
) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning || !startedAt) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning, startedAt]);

  if (!startedAt) {
    return 0;
  }

  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function statusText(status?: RuntimeProcessSnapshot["status"]) {
  if (status === "failed") return "生成失败";
  if (status === "cancelled") return "已停止";
  if (status === "succeeded") return "已完成";
  return "思考中...";
}

function shouldShowRuntimeStatus(
  runtimeProcess: RuntimeProcessSnapshot | undefined,
  hasAssistantContent: boolean,
) {
  if (!runtimeProcess || runtimeProcess.status === "idle") {
    return false;
  }
  if (runtimeProcess.status === "running") {
    return true;
  }
  if (
    runtimeProcess.status === "failed" ||
    runtimeProcess.status === "cancelled"
  ) {
    return true;
  }
  if (runtimeProcess.status === "succeeded") {
    return (
      !hasAssistantContent ||
      (runtimeProcess.events ?? []).some(isVisibleRuntimeEvent)
    );
  }
  return hasAssistantContent || Boolean(firstVisibleRuntimeEvent(runtimeProcess));
}

function firstVisibleRuntimeEvent(runtimeProcess?: RuntimeProcessSnapshot) {
  return runtimeProcess?.events?.find(isVisibleRuntimeEvent);
}

function isVisibleRuntimeEvent(event: RuntimeProcessEvent) {
  return (
    event.kind === "status" ||
    event.kind === "knowledge" ||
    event.kind === "tool" ||
    event.kind === "artifact" ||
    event.kind === "document" ||
    event.kind === "error"
  );
}

function useObservedStart(shouldStart: boolean) {
  const [startedAt, setStartedAt] = useState<string | undefined>();

  useEffect(() => {
    if (shouldStart && !startedAt) {
      setStartedAt(new Date().toISOString());
    }
    if (!shouldStart && startedAt) {
      setStartedAt(undefined);
    }
  }, [shouldStart, startedAt]);

  return startedAt;
}

function formatToolName(name: string) {
  const normalized = name
    .replace(/^mcp__/, "")
    .replace(/__/g, " / ")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .trim();
  return normalized || "工具";
}

function formatToolPayload(part: any) {
  const segments: string[] = [];
  if (part.input !== undefined) {
    segments.push(`输入\n${stringifyToolValue(part.input)}`);
  }
  if (part.output !== undefined) {
    segments.push(`输出\n${stringifyToolValue(part.output)}`);
  }
  if (part.errorText) {
    segments.push(`错误\n${String(part.errorText)}`);
  }
  return segments.join("\n\n").trim();
}

function stringifyToolValue(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
