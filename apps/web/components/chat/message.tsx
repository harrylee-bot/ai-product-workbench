"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useArtifact } from "@/hooks/use-artifact";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { PreviewAttachment } from "./preview-attachment";

type RuntimeArtifactReference = NonNullable<RuntimeProcessEvent["artifact"]>;

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

  const messageArtifact = useMemo(
    () => findMessageArtifact(message.parts),
    [message.parts],
  );

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

  const showThinkingText =
    isAssistant &&
    Boolean(showRuntimeProcess) &&
    shouldShowRuntimeStatus(runtimeProcess, hasAnyContent);
  const thinkingText = showThinkingText ? (
    <ThinkingText
      artifactFallback={messageArtifact}
      runtimeProcess={runtimeProcess}
    />
  ) : null;

  const content = isThinking ? (
    thinkingText ?? (
      <ThinkingText
        artifactFallback={messageArtifact}
        runtimeProcess={runtimeProcess}
      />
    )
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
  artifactFallback,
  runtimeProcess,
}: {
  artifactFallback?: RuntimeArtifactReference | null;
  runtimeProcess?: RuntimeProcessSnapshot;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <RuntimeStatusLine
        hasAssistantContent={false}
        runtimeProcess={runtimeProcess}
      />
      <RuntimeEventList
        artifactFallback={artifactFallback}
        runtimeProcess={runtimeProcess}
      />
    </div>
  );
}

function RuntimeEventList({
  artifactFallback,
  runtimeProcess,
}: {
  artifactFallback?: RuntimeArtifactReference | null;
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
        <RuntimeEventRow
          artifactFallback={artifactFallback}
          event={event}
          key={event.id}
        />
      ))}
    </div>
  );
}

function RuntimeEventRow({
  artifactFallback,
  event,
}: {
  artifactFallback?: RuntimeArtifactReference | null;
  event: RuntimeProcessEvent;
}) {
  const { setArtifact } = useArtifact();
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const artifact = resolveRuntimeEventArtifact(event, artifactFallback);
  const detail = formatRuntimeEventDetail(event);
  const isActionable = Boolean(artifact || detail);
  const openArtifact = (target: HTMLElement) => {
    if (!artifact) return;
    const boundingBox = target.getBoundingClientRect();
    setArtifact((currentArtifact) => ({
      ...currentArtifact,
      documentId: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      content:
        currentArtifact.documentId === artifact.id
          ? currentArtifact.content
          : "",
      status: "idle",
      isVisible: true,
      boundingBox: {
        left: boundingBox.x,
        top: boundingBox.y,
        width: boundingBox.width,
        height: boundingBox.height,
      },
    }));
  };

  const row = (
    <div className="flex min-w-0 items-start gap-2 text-[12px] leading-[1.6] text-muted-foreground/75">
      <RuntimeEventIcon event={event} />
      <span className="mt-px shrink-0 text-muted-foreground/50">
        {runtimeEventKindLabel(event.kind)}
      </span>
      <span className="min-w-0 flex-1 break-words">{event.label}</span>
      {isActionable ? (
        <ChevronRightIcon className="mt-1 size-3 shrink-0 text-muted-foreground/45" />
      ) : null}
    </div>
  );

  if (artifact) {
    return (
      <button
        className="min-w-0 rounded-md text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={(clickEvent) => openArtifact(clickEvent.currentTarget)}
        type="button"
      >
        {row}
      </button>
    );
  }

  return (
    <Dialog onOpenChange={setIsDetailOpen} open={isDetailOpen}>
      <button
        className={cn(
          "min-w-0 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          detail && "hover:bg-muted/35",
        )}
        disabled={!detail}
        onClick={() => detail && setIsDetailOpen(true)}
        type="button"
      >
        {row}
      </button>
      {detail ? (
        <DialogContent className="max-h-[80vh] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border/60 px-5 py-4">
            <DialogTitle className="pr-8 text-sm leading-6">
              {event.label}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {runtimeEventKindLabel(event.kind)} · {runtimeEventStatusText(event.status)}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[56vh] overflow-auto whitespace-pre-wrap px-5 py-4 text-[12px] leading-relaxed text-muted-foreground">
            {detail}
          </pre>
        </DialogContent>
      ) : null}
    </Dialog>
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

function findMessageArtifact(
  parts: ChatMessage["parts"],
): RuntimeArtifactReference | null {
  for (let index = (parts?.length ?? 0) - 1; index >= 0; index -= 1) {
    const part = parts?.[index] as
      | {
          type?: string;
          state?: string;
          output?: Partial<RuntimeArtifactReference>;
        }
      | undefined;

    if (
      part?.type !== "tool-createDocument" ||
      part.state !== "output-available" ||
      !part.output?.id ||
      !part.output.kind
    ) {
      continue;
    }

    return {
      id: part.output.id,
      title: part.output.title || defaultArtifactTitle(part.output.kind),
      kind: part.output.kind,
    };
  }

  return null;
}

function resolveRuntimeEventArtifact(
  event: RuntimeProcessEvent,
  fallback?: RuntimeArtifactReference | null,
) {
  if (event.artifact && canOpenCanvasArtifact(event.artifact)) {
    return event.artifact;
  }

  if (fallback && canOpenCanvasArtifact(fallback) && eventMentionsArtifact(event, fallback)) {
    return fallback;
  }

  return null;
}

function canOpenCanvasArtifact(artifact: RuntimeArtifactReference) {
  return artifact.kind === "prototype" || artifact.kind === "text";
}

function eventMentionsArtifact(
  event: RuntimeProcessEvent,
  artifact: RuntimeArtifactReference,
) {
  const haystack = `${event.id} ${event.label} ${event.detail ?? ""}`.toLowerCase();
  if (artifact.kind === "prototype") {
    return haystack.includes("prototype") || haystack.includes("原型");
  }
  return haystack.includes("prd") || haystack.includes("文档");
}

function defaultArtifactTitle(kind: RuntimeArtifactReference["kind"]) {
  if (kind === "prototype") return "原型";
  if (kind === "text") return "产品需求文档（PRD）";
  return "产物";
}

function runtimeEventStatusText(status: RuntimeProcessEvent["status"]) {
  if (status === "running") return "进行中";
  if (status === "failed") return "失败";
  return "完成";
}

function formatRuntimeEventDetail(event: RuntimeProcessEvent) {
  const lines = [
    `事件：${event.label}`,
    `类型：${runtimeEventKindLabel(event.kind)}`,
    `状态：${runtimeEventStatusText(event.status)}`,
    `时间：${formatRuntimeDate(event.createdAt)}`,
  ];

  if (event.runId) {
    lines.push(`运行 ID：${event.runId}`);
  }

  lines.push(`事件 ID：${event.id}`);

  if (event.detail) {
    lines.push("", "详情", event.detail);
  }

  if (event.artifact) {
    lines.push("", "产物", stringifyRuntimeValue(event.artifact));
  }

  return lines.join("\n");
}

function formatRuntimeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function stringifyRuntimeValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  const elapsedText = startedAt ? formatElapsed(elapsedMs) : undefined;
  const terminalLabel = statusText(runtimeProcess?.status);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
      {isRunning ? (
        <Shimmer className="font-medium text-muted-foreground" duration={1}>
          {elapsedText ? `思考中 · 已处理 ${elapsedText}` : "思考中..."}
        </Shimmer>
      ) : elapsedText ? (
        <span className="font-medium tabular-nums text-muted-foreground">
          {runtimeProcess?.status === "succeeded"
            ? `已处理 ${elapsedText}`
            : `${terminalLabel} · 已处理 ${elapsedText}`}
        </span>
      ) : (
        <span className="font-medium text-muted-foreground">
          {terminalLabel}
        </span>
      )}
      <ChevronDownIcon className="size-3.5 text-muted-foreground/55" />
    </div>
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
