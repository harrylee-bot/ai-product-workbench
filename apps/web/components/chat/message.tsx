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
} from "../ai-elements/tool";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { CanvasDocumentCard } from "./canvas-document-card";
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
  const label = formatUserRuntimeLabel(event.label);
  const detail = formatUserRuntimeDetail(event.detail);

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
          {label}
        </span>
        {isRunning && (
          <span className="ml-1 text-xs text-muted-foreground/60">…</span>
        )}
      </div>
      {detail && (
        <div className="ml-6 text-xs text-muted-foreground/70 whitespace-pre-wrap leading-relaxed border-l border-border/40 pl-2">
          {detail}
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
      const label = formatUserRuntimeLabel(event.label);
      const detail = formatUserRuntimeDetail(event.detail);
      return detail ? `- ${label}\n  ${detail}` : `- ${label}`;
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
    const canvasDocument = getCanvasDocumentFromToolPart(part);
    if (!canvasDocument) return null;
    return <CanvasDocumentCard {...canvasDocument} />;
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
  const presentation = buildToolPresentation({
    errorText,
    input: part.input,
    output,
    state,
    toolName: getToolName(part),
  });
  const shouldOpenByDefault =
    state === "approval-requested" ||
    state === "input-available" ||
    state === "output-available" ||
    state === "output-error";

  return (
    <Tool className="max-w-[min(100%,560px)]" defaultOpen={shouldOpenByDefault}>
      <ToolHeader
        description={presentation.description}
        state={state as any}
        title={presentation.title}
        toolName={part.toolName}
        type={part.type as any}
      />
      <ToolContent>
        <div className="space-y-2 rounded-md bg-muted/35 px-3 py-2 text-sm leading-relaxed text-muted-foreground">
          <ToolSummaryLine label="为什么" text={presentation.reason} />
          <ToolSummaryLine label="执行" text={presentation.action} />
          <ToolSummaryLine
            label={presentation.errorSummary ? "状态" : "结果"}
            text={presentation.summary}
          />
          {presentation.errorSummary ? (
            <p className="text-destructive">{presentation.errorSummary}</p>
          ) : null}
        </div>
      </ToolContent>
    </Tool>
  );
}

function ToolSummaryLine({ label, text }: { label: string; text: string }) {
  return (
    <p>
      <span className="text-foreground/80">{label}：</span>
      {text}
    </p>
  );
}

function isToolPart(part: any) {
  const type = String(part?.type ?? "");
  return type === "dynamic-tool" || type.startsWith("tool-");
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

function getToolName(part: any) {
  if (typeof part?.toolName === "string" && part.toolName.trim()) {
    return part.toolName;
  }
  const type = String(part?.type ?? "");
  return type.startsWith("tool-") ? type.slice("tool-".length) : type;
}

function buildToolPresentation(input: {
  errorText?: string;
  input: unknown;
  output: unknown;
  state: string;
  toolName: string;
}) {
  const action = toolActionCopy(input.toolName);
  const statusSummary = statusSummaryForTool(action, input.state);
  const reason = summarizeToolReason(input.toolName, input.input);
  const actionSummary = summarizeToolAction(input.toolName, input.input);
  const outputSummary = summarizeToolOutput(input.toolName, input.output);
  const errorSummary = input.errorText
    ? "这一步没有完成，系统已保留失败状态，后续可重新尝试。"
    : undefined;

  return {
    title: action.title,
    description:
      input.state === "output-available"
        ? reason
        : actionSummary ?? reason ?? statusSummary,
    reason,
    action: actionSummary ?? statusSummary,
    summary: input.errorText
      ? statusSummary
      : outputSummary ?? statusSummary,
    errorSummary,
  };
}

function toolActionCopy(name: string) {
  const normalized = normalizeToolName(name);
  if (normalized.includes("listknowledgebase")) {
    return {
      title: "查询项目知识库",
      running: "正在查询项目知识库",
      completed: "已查询项目知识库",
      failed: "知识库查询失败",
    };
  }
  if (normalized.includes("readfile") || normalized.includes("read_file")) {
    return {
      title: "读取参考资料",
      running: "正在读取参考资料",
      completed: "已读取参考资料",
      failed: "资料读取失败",
    };
  }
  if (
    normalized.includes("writefile") ||
    normalized.includes("editfile") ||
    normalized.includes("updatefile") ||
    normalized.includes("createfile")
  ) {
    return {
      title: "整理生成内容",
      running: "正在整理生成内容",
      completed: "已整理生成内容",
      failed: "内容整理失败",
    };
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("find") ||
    normalized === "rg"
  ) {
    return {
      title: "检索相关信息",
      running: "正在检索相关信息",
      completed: "已检索相关信息",
      failed: "信息检索失败",
    };
  }
  if (
    normalized.includes("listdir") ||
    normalized.includes("listdirectory") ||
    normalized === "ls"
  ) {
    return {
      title: "查看资料目录",
      running: "正在查看资料目录",
      completed: "已查看资料目录",
      failed: "资料目录读取失败",
    };
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec") ||
    normalized.includes("bash")
  ) {
    return {
      title: "执行系统验证",
      running: "正在执行系统验证",
      completed: "已完成系统验证",
      failed: "系统验证失败",
    };
  }
  if (
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("curl")
  ) {
    return {
      title: "获取外部信息",
      running: "正在获取外部信息",
      completed: "已获取外部信息",
      failed: "外部信息获取失败",
    };
  }
  return {
    title: "处理任务步骤",
    running: "正在处理任务步骤",
    completed: "已完成任务步骤",
    failed: "任务步骤失败",
  };
}

function normalizeToolName(name: string) {
  return name
    .replace(/^mcp__/i, "")
    .replace(/__/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase();
}

function statusSummaryForTool(
  action: ReturnType<typeof toolActionCopy>,
  state: string,
) {
  if (state === "output-error") return action.failed;
  if (state === "output-available") return action.completed;
  if (state === "approval-requested") return "等待用户确认后继续。";
  if (state === "output-denied") return "用户已拒绝执行这一步。";
  return action.running;
}

function summarizeToolReason(toolName: string, input: unknown) {
  const action = toolActionCopy(toolName);
  const normalized = normalizeToolName(toolName);
  const query = extractReadableQuery(input);

  if (normalized.includes("listknowledgebase")) {
    return query
      ? `为了让回答贴合已有沉淀，我围绕「${query}」查询项目知识库，确认是否有可复用的业务规则、历史方案或 PRD 模板。`
      : "为了让回答贴合已有沉淀，我先查询项目知识库，确认是否有可复用的业务规则、历史方案或 PRD 模板。";
  }
  if (normalized.includes("readfile") || normalized.includes("read_file")) {
    return "为了避免凭空生成，我先读取与本轮需求相关的参考资料，确认已有业务背景、约束和文档结构。";
  }
  if (
    normalized.includes("writefile") ||
    normalized.includes("editfile") ||
    normalized.includes("updatefile")
  ) {
    return "为了把分析结果变成用户可直接使用的内容，我正在整理生成文档或更新产物。";
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("find")
  ) {
    return query
      ? `为了确认「${query}」相关上下文，我先检索已有资料，避免遗漏历史约束。`
      : "为了确认本轮需求相关上下文，我先检索已有资料，避免遗漏历史约束。";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec") ||
    normalized.includes("bash")
  ) {
    return "为了确认改动真实可用，我执行必要的本地验证和健康检查。";
  }
  if (
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("curl")
  ) {
    return "为了确认服务状态和外部依赖可用，我获取接口或页面的最新响应。";
  }
  return action.running;
}

function summarizeToolAction(toolName: string, input: unknown) {
  const action = toolActionCopy(toolName);
  const normalized = normalizeToolName(toolName);
  const query = extractReadableQuery(input);

  if (normalized.includes("listknowledgebase")) {
    return query
      ? `按「${query}」检索项目知识库，并筛选能支撑当前需求的条目。`
      : "检索项目知识库，并筛选能支撑当前需求的条目。";
  }
  if (normalized.includes("readfile") || normalized.includes("read_file")) {
    return "读取必要的参考资料，只提取与需求理解相关的信息。";
  }
  if (
    normalized.includes("writefile") ||
    normalized.includes("editfile") ||
    normalized.includes("updatefile")
  ) {
    return "把已确认的分析结果整理成用户可查看的产物。";
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("find")
  ) {
    return query
      ? `检索「${query}」相关资料，并提取可复用上下文。`
      : "检索相关资料，并提取可复用上下文。";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec") ||
    normalized.includes("bash")
  ) {
    return "运行必要检查，确认页面、接口或构建结果正常。";
  }
  if (
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("curl")
  ) {
    return "读取接口或页面响应，确认当前系统状态。";
  }
  return action.running;
}

function summarizeToolOutput(toolName: string, output: unknown) {
  if (output === undefined || output === null || output === "") return undefined;
  const normalized = normalizeToolName(toolName);
  const record = output && typeof output === "object" && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : null;

  if (normalized.includes("listknowledgebase")) {
    const selectedCount = numberFromUnknown(record?.selectedCount);
    const matchedCount = numberFromUnknown(record?.matchedCount);
    if (selectedCount !== undefined && matchedCount !== undefined) {
      return `已找到 ${selectedCount} 条可用资料，总命中 ${matchedCount} 条。`;
    }
    if (selectedCount !== undefined) {
      return `已找到 ${selectedCount} 条可用资料。`;
    }
    return "已完成知识库查询。";
  }
  if (normalized.includes("readfile") || normalized.includes("read_file")) {
    return "已读取相关资料，并用于后续分析。";
  }
  if (
    normalized.includes("writefile") ||
    normalized.includes("editfile") ||
    normalized.includes("updatefile")
  ) {
    return "已完成内容整理。";
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("find")
  ) {
    return "已完成相关信息检索。";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec") ||
    normalized.includes("bash")
  ) {
    return "已完成必要的系统验证。";
  }
  return "已完成这一步处理。";
}

function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractReadableQuery(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidate =
    stringFromUnknown(record.query) ??
    stringFromUnknown(record.keyword) ??
    stringFromUnknown(record.search) ??
    stringFromUnknown(record.message) ??
    stringFromUnknown(record.prompt);
  if (!candidate) return undefined;
  const cleaned = sanitizeRuntimeText(candidate)
    .replace(/["'`{}[\]<>]/g, "")
    .trim();
  if (!cleaned || looksTechnicalRuntimeText(cleaned)) return undefined;
  return cleaned.length > 28 ? `${cleaned.slice(0, 28)}…` : cleaned;
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatUserRuntimeLabel(label: string) {
  const action = toolActionFromText(label);
  if (!action) return sanitizeRuntimeText(label);
  if (/失败|错误|error|failed/i.test(label)) return action.failed;
  if (/已完成|完成|completed|output/i.test(label)) return action.completed;
  return action.running;
}

function formatUserRuntimeDetail(detail?: string) {
  if (!detail?.trim()) return undefined;
  const text = detail.trim();
  if (looksTechnicalRuntimeText(text)) {
    return "已处理必要的信息，技术细节已隐藏。";
  }
  return sanitizeRuntimeText(text).slice(0, 140);
}

function toolActionFromText(text: string) {
  const normalized = normalizeToolName(text);
  const candidates = [
    "listKnowledgeBase",
    "read_file",
    "readFile",
    "write_file",
    "edit_file",
    "update_file",
    "search",
    "grep",
    "find",
    "list_dir",
    "exec_command",
    "shell",
    "bash",
    "curl",
  ];
  return candidates
    .map((candidate) => toolActionCopy(candidate))
    .find((_action, index) => {
      const candidate = normalizeToolName(candidates[index]);
      return normalized.includes(candidate);
    });
}

function looksTechnicalRuntimeText(text: string) {
  return (
    /^[{[]/.test(text) ||
    /[`{}$]|--|&&|\|\||\/[\w.-]+|\\n|\.tsx?|\.jsx?|\.json|npm |git |ssh |docker |curl |read[_ ]?file|write[_ ]?file/i.test(text)
  );
}

function sanitizeRuntimeText(text: string) {
  return text
    .replace(/read[_ ]?file/gi, "读取参考资料")
    .replace(/write[_ ]?file/gi, "整理生成内容")
    .replace(/listKnowledgeBase/gi, "查询项目知识库")
    .replace(/\s+/g, " ")
    .trim();
}
