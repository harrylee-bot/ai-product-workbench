"use client";

import {
  Circle,
  HelpCircle,
  PanelLeftOpen,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge, Button, EmptyState } from "@/components/ui";
import { toChineseText } from "@/components/workspace-preview/helpers";
import { ChatComposer } from "./workspace-chat/chat-composer";

export type Phase1Message = {
  id: string;
  projectId?: string;
  conversationId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  relatedRunId?: string;
  createdAt: string;
};

export type VibeRunStepStatus = "pending" | "running" | "done" | "failed" | "canceled";

export type VibeRunStepView = {
  step: string;
  title: string;
  executor: string;
  detail: string;
  status: VibeRunStepStatus;
  message?: string;
};

export type VibeRunTimelineItem = {
  id: string;
  text: string;
  status: "info" | "running" | "done" | "failed" | "warning";
  step?: string;
  createdAt?: string;
};

export type VibeRunDebugEvent = {
  id: string;
  title: string;
  body: string;
  raw?: string;
  status: "info" | "running" | "done" | "failed" | "warning";
  type: string;
  step?: string;
  createdAt?: string;
};

export type VibeToolCallView = {
  id: string;
  toolName: string;
  status: "running" | "done" | "failed";
  args?: unknown;
  result?: string;
};

type ActivityPillView = {
  id: string;
  label: string;
  status: VibeRunTimelineItem["status"];
};

export type VibeClarificationQuestion = {
  id: string;
  title: string;
  question?: string;
  reason: string;
  options: string[];
  recommendedOption?: string;
  recommendation?: string;
  required?: boolean;
  status?: "pending" | "answered" | "skipped";
};

export type VibeRunView = {
  runId?: string;
  status:
    | "idle"
    | "running"
    | "waiting_clarification"
    | "waiting_confirmation"
    | "waiting_prd_confirm"
    | "waiting_prototype_confirm"
    | "completed"
    | "canceled"
    | "failed";
  currentLabel?: string;
  summary?: string;
  steps: VibeRunStepView[];
  timeline?: VibeRunTimelineItem[];
  debugEvents?: VibeRunDebugEvent[];
  /** Phase 2 透明化：assistant 逐字流式文本 + 结构化工具调用 */
  streamingText?: string;
  toolCalls?: VibeToolCallView[];
  clarificationQuestions?: VibeClarificationQuestion[];
  knowledgeHitCount?: number;
  qaIssueCount?: number;
  qaGateStatus?: "open" | "warning" | "blocked";
  qaGateSummary?: string;
  exportFileName?: string;
  prototypeArtifactId?: string;
  /** 确认门 A：用户确认 PRD 后是否应继续生成原型（FR-1.3） */
  wantsPrototype?: boolean;
  errorMessage?: string;
};

export function ChatPanel({
  messages,
  runState,
  sidebarCollapsed,
  disabled,
  sending,
  stoppingRun,
  creatingConversation,
  onToggleSidebar,
  onCreateConversation,
  onStopRun,
  confirmingPrd,
  onConfirmPrd,
  confirmingPrototypeId,
  onConfirmPrototype,
  onSend,
}: {
  messages: Phase1Message[];
  runState?: VibeRunView | null;
  sidebarCollapsed?: boolean;
  disabled?: boolean;
  sending?: boolean;
  stoppingRun?: boolean;
  creatingConversation?: boolean;
  onToggleSidebar?: () => void;
  onCreateConversation?: () => void;
  onStopRun?: () => Promise<void> | void;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
  onSend: (content: string) => Promise<void> | void;
}) {
  // 同 run 的助手消息已落库时，流式占位气泡让位给历史消息气泡（无缝替换，无跳变）。
  const assistantMessageForRunExists = Boolean(
    runState?.runId && messages.some((m) => m.role === "assistant" && m.relatedRunId === runState.runId),
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel-bg)]">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-3">
        {sidebarCollapsed ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              onClick={onToggleSidebar}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-gray-700 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
              aria-label="打开侧边栏"
              title="打开侧边栏"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 text-sm text-gray-400">
              <Search className="h-4 w-4 shrink-0" />
              <span className="truncate">搜索对话...</span>
            </div>
            <button
              type="button"
              onClick={onCreateConversation}
              disabled={creatingConversation}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-gray-950 px-3 text-sm font-semibold text-white shadow-[var(--shadow-control)] transition hover:bg-gray-800 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-60"
              title={creatingConversation ? "正在创建对话" : "新对话"}
            >
              <Plus className="h-4 w-4" />
              <span>新对话</span>
            </button>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-950">对话</div>
            <div className="truncate text-xs text-gray-500">对话、执行过程与结论</div>
          </div>
        )}
        <Badge tone={chatHeaderStatusTone(sending, runState)} className="bg-white">
          {sending ? (
            <span className="inline-flex items-center gap-1">
              <Circle className="h-3.5 w-3.5 fill-amber-100 text-amber-600" />
              {onStopRun ? "正在执行，可停止" : "正在发送"}
            </span>
          ) : runState?.status === "canceled" ? "已停止" : "可输入"}
        </Badge>
      </div>
      <div className="workbench-scrollbar relative min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length || runState ? (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            <AgentActivityFeed
              runState={runState}
              assistantMessageForRunExists={assistantMessageForRunExists}
              confirmingPrd={confirmingPrd}
              onConfirmPrd={onConfirmPrd}
              confirmingPrototypeId={confirmingPrototypeId}
              onConfirmPrototype={onConfirmPrototype}
            />
          </div>
        ) : (
          <EmptyState
            title="从一句目标开始"
            description="系统会整理需求、生成产品状态、PRD、原型和 QA 路径。"
            icon={<Sparkles className="h-5 w-5" />}
          />
        )}
      </div>
      <ChatComposer disabled={disabled} sending={sending} stopping={stoppingRun} onStop={onStopRun} onSend={onSend} />
    </section>
  );
}

function MessageBubble({ message }: { message: Phase1Message }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto w-full max-w-[min(76%,_680px)] text-right">
        <div className="mb-1 text-[11px] font-semibold tracking-wide text-gray-400">你 · {formatMessageTime(message.createdAt)}</div>
        <div className="inline-block max-w-full rounded-[10px] bg-gray-950 px-3 py-2 text-left text-sm leading-6 text-white shadow-sm">
          <span className="whitespace-pre-wrap break-words">{toChineseText(message.content)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mr-auto w-full max-w-[min(92%,_760px)]">
      <AssistantText content={message.content} tone={message.role === "system" ? "muted" : "normal"} />
    </div>
  );
}

/**
 * 纯对话 transcript：助手正文流式输出 → 关键调用胶囊 → 澄清/确认。
 * 默认只展示公开进度摘要，不展示隐藏推理链、工具入参/返回或原始 payload。
 */
function AgentActivityFeed({
  runState,
  assistantMessageForRunExists,
  confirmingPrd,
  onConfirmPrd,
  confirmingPrototypeId,
  onConfirmPrototype,
}: {
  runState?: VibeRunView | null;
  assistantMessageForRunExists: boolean;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
}) {
  if (!runState) return null;

  const showStreamingText = Boolean(runState.streamingText) && !assistantMessageForRunExists;
  const toolCalls = runState.toolCalls ?? [];
  const activityPills = buildActivityPills(runState, toolCalls);
  const hasActivityPills = Boolean(activityPills.length);
  const hasClarification = runState.status === "waiting_clarification";
  const hasConfirmation =
    runState.status === "waiting_prd_confirm" ||
    runState.status === "waiting_prototype_confirm" ||
    runState.status === "waiting_confirmation";

  // run 已完成且无流式占位、无调用状态、无澄清/确认时不渲染任何东西（结论由历史助手消息承载）。
  if (!showStreamingText && !hasActivityPills && !hasClarification && !hasConfirmation) {
    return null;
  }

  return (
    <div className="mr-auto flex w-full max-w-[min(92%,_760px)] flex-col gap-3">
      {showStreamingText ? (
        <div className="text-[15px] leading-7 text-gray-900">
          <AssistantText content={runState.streamingText ?? ""} />
          <span className="ml-0.5 inline-block h-3.5 w-1.5 motion-safe:animate-pulse bg-gray-400 align-middle" aria-hidden="true" />
        </div>
      ) : null}

      {hasActivityPills ? <ActivityPillStrip pills={activityPills} /> : null}

      {hasClarification ? (
        <ClarificationConversation runState={runState} />
      ) : null}

      {hasConfirmation ? (
        <ConfirmationConversation
          runState={runState}
          confirmingPrd={confirmingPrd}
          onConfirmPrd={onConfirmPrd}
          confirmingPrototypeId={confirmingPrototypeId}
          onConfirmPrototype={onConfirmPrototype}
        />
      ) : null}
    </div>
  );
}

function ActivityPillStrip({ pills }: { pills: ActivityPillView[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-0.5" aria-label="关键调用信息">
      {pills.map((pill) => (
        <span
          key={pill.id}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-gray-100 px-2.5 py-1 text-[11px] font-medium leading-none text-gray-600"
          title={pill.label}
        >
          <span className={activityDotClassName(pill.status)} aria-hidden="true" />
          <span className="truncate">{pill.label}</span>
        </span>
      ))}
    </div>
  );
}

function AssistantText({
  content,
  tone = "normal",
}: {
  content: string;
  tone?: "normal" | "muted";
}) {
  const segments = parseFencedCodeBlocks(toChineseText(content));
  const textColor = tone === "muted" ? "text-gray-500" : "text-gray-900";

  return (
    <div className={`space-y-3 break-words text-[15px] leading-7 ${textColor}`}>
      {segments.length ? (
        segments.map((segment, index) =>
          segment.type === "code" ? (
            <CodeBlock key={`${segment.type}-${index}`} language={segment.language} code={segment.content} />
          ) : (
            <TextBlock key={`${segment.type}-${index}`} text={segment.content} />
          ),
        )
      ) : (
        <span />
      )}
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={`${paragraph.slice(0, 24)}-${index}`} className="whitespace-pre-wrap">
          <InlineCodeText text={paragraph} />
        </p>
      ))}
    </>
  );
}

function InlineCodeText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
          return (
            <code
              key={`${part}-${index}`}
              className="mx-0.5 inline-flex max-w-full items-center rounded-md bg-gray-100 px-1.5 py-0.5 align-baseline font-mono text-[0.92em] leading-none text-gray-800"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={`${part.slice(0, 18)}-${index}`}>{part}</span>;
      })}
    </>
  );
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-[10px] bg-gray-100 text-gray-900">
      {language ? <div className="px-3 pt-2 font-mono text-xs text-gray-500">{language}</div> : null}
      <pre className="workbench-scrollbar overflow-x-auto whitespace-pre-wrap px-3 py-3 font-mono text-[13px] leading-6">
        {code.trimEnd()}
      </pre>
    </div>
  );
}

function parseFencedCodeBlocks(content: string): Array<{ type: "text" | "code"; content: string; language?: string }> {
  const segments: Array<{ type: "text" | "code"; content: string; language?: string }> = [];
  const fencePattern = /```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: content.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", language: match[1], content: match[2] ?? "" });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ type: "text", content: content.slice(lastIndex) });
  }

  return segments.filter((segment) => segment.content.trim().length > 0);
}

function buildActivityPills(
  runState: VibeRunView,
  toolCalls: VibeToolCallView[],
): ActivityPillView[] {
  const pills: ActivityPillView[] = [];
  const seen = new Set<string>();
  const addPill = (pill: ActivityPillView) => {
    const key = normalizeProcessKey(pill.label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    pills.push(pill);
  };

  const liveSteps = runState.steps.filter((step) =>
    step.status === "running" ||
    step.status === "failed" ||
    step.status === "canceled",
  );

  for (const step of liveSteps.slice(-3)) {
    addPill({
      id: `step:${step.step}:${step.status}`,
      label: `${step.title} · ${stepStatusLabel(step.status)}`,
      status: stepStatusToRailStatus(step.status),
    });
  }

  const latestTimelineItems = [...(runState.timeline ?? [])]
    .filter((item) => item.status !== "done" || runState.status === "running")
    .slice(-3);

  for (const item of latestTimelineItems) {
    const label = compactActivityText(item.text);
    if (!label) continue;
    addPill({
      id: `timeline:${item.id}`,
      label,
      status: item.status,
    });
  }

  for (const call of toolCalls.slice(-6)) {
    addPill({
      id: `tool:${call.id}:${call.status}`,
      label: `${compactToolName(call.toolName)} · ${toolStatusLabel(call.status)}`,
      status: call.status === "failed" ? "failed" : call.status === "running" ? "running" : "done",
    });
  }

  if (!pills.length && runState.currentLabel && runState.status === "running") {
    addPill({
      id: `${runState.runId ?? "run"}:current`,
      label: compactActivityText(runState.currentLabel),
      status: "running",
    });
  }

  return pills.slice(-8);
}

function activityDotClassName(status: VibeRunTimelineItem["status"]) {
  const color =
    status === "running"
      ? "bg-amber-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "warning"
          ? "bg-amber-500"
          : status === "done"
            ? "bg-emerald-500"
            : "bg-gray-400";
  return `h-1.5 w-1.5 shrink-0 rounded-full ${color} ${status === "running" ? "motion-safe:animate-pulse" : ""}`;
}

function stepStatusLabel(status: VibeRunStepStatus) {
  if (status === "running") return "执行中";
  if (status === "failed") return "失败";
  if (status === "canceled") return "已停止";
  return "已完成";
}

function toolStatusLabel(status: VibeToolCallView["status"]) {
  if (status === "running") return "调用中";
  if (status === "failed") return "失败";
  return "已完成";
}

function compactToolName(value: string) {
  return `调用 ${value.replace(/\s+/g, " ").trim() || "工具"}`;
}

function compactActivityText(value?: string) {
  const text = normalizeProcessDetail(value)
    ?.replace(/^节点目标：/, "")
    .replace(/^正在/, "")
    .replace(/。$/, "");
  if (!text) return "";
  return text.length > 34 ? `${text.slice(0, 34)}...` : text;
}

function stepStatusToRailStatus(status: VibeRunStepStatus): VibeRunTimelineItem["status"] {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "canceled") return "warning";
  return "done";
}

function normalizeProcessDetail(value?: string) {
  return value?.replace(/\s+/g, " ").trim();
}

function normalizeProcessKey(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 澄清对话：轻量内联提示 + 问题列表。 */
function ClarificationConversation({ runState }: { runState: VibeRunView }) {
  const questions = runState.clarificationQuestions ?? [];
  return (
    <div className="mr-auto w-full max-w-[min(92%,_760px)]">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-gray-400">
        <HelpCircle className="h-3.5 w-3.5" />
        <span>需要补充信息</span>
      </div>
      <div className="border-l border-amber-300 py-1 pl-4">
        <p className="break-words text-sm leading-6 text-amber-900">
          {runState.summary || "我需要先确认这些信息，再继续生成后续产物。请在下方输入框直接回复。"}
        </p>
        <div className="mt-2 space-y-2">
          {questions.length ? (
            questions.map((question, index) => <ClarificationQuestionRow key={question.id} question={question} index={index} />)
          ) : (
            <div className="text-xs leading-5 text-amber-800">请补充关键目标、用户范围、页面边界或约束条件。</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ClarificationQuestionRow({
  question,
  index,
}: {
  question: VibeClarificationQuestion;
  index: number;
}) {
  return (
    <div className="rounded-md px-2 py-1.5 transition hover:bg-amber-50/60">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[11px] font-semibold text-amber-800">
          {index + 1}
        </span>
        <div className="min-w-0">
          <div className="break-words text-sm font-semibold leading-5 text-gray-950">{question.question || question.title}</div>
          {question.reason ? <div className="mt-1 break-words text-xs leading-5 text-gray-500">{question.reason}</div> : null}
          {question.options.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {question.options.map((option) => (
                <span
                  key={option}
                  className={[
                    "max-w-full rounded-full border px-2 py-1 text-xs font-medium",
                    option === question.recommendedOption
                      ? "border-amber-300 bg-amber-50 text-amber-800"
                      : "border-gray-200 bg-gray-50 text-gray-600",
                  ].join(" ")}
                >
                  {option}
                </span>
              ))}
            </div>
          ) : null}
          {question.recommendation ? <div className="mt-2 break-words text-xs leading-5 text-amber-800">建议：{question.recommendation}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** 确认对话：轻量内联提示 + 内联按钮。 */
function ConfirmationConversation({
  runState,
  confirmingPrd,
  onConfirmPrd,
  confirmingPrototypeId,
  onConfirmPrototype,
}: {
  runState: VibeRunView;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
}) {
  if (runState.status === "waiting_prd_confirm") {
    return (
      <div className="mr-auto w-full max-w-[min(92%,_760px)]">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-gray-400">
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>需要确认后继续</span>
        </div>
        <div className="border-l border-blue-300 py-1 pl-4">
          <p className="break-words text-sm leading-6 text-blue-900">{runState.summary || "PRD 已生成。确认后我会继续推进后续原型生成。"}</p>
          {onConfirmPrd ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={confirmingPrd} onClick={() => onConfirmPrd(true)}>
                {confirmingPrd ? "确认中..." : "确认并生成原型"}
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={confirmingPrd} onClick={() => onConfirmPrd(false)}>
                仅确认 PRD
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (runState.status === "waiting_prototype_confirm") {
    const artifactId = runState.prototypeArtifactId;
    const confirming = Boolean(artifactId && confirmingPrototypeId === artifactId);
    return (
      <div className="mr-auto w-full max-w-[min(92%,_760px)]">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-gray-400">
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>需要确认/授权继续</span>
        </div>
        <div className="border-l border-blue-300 py-1 pl-4">
          <p className="break-words text-sm leading-6 text-blue-900">{runState.summary || "原型已生成。确认后会标记为可分享和可发布的稳定版本。"}</p>
          {artifactId && onConfirmPrototype ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={confirming} onClick={() => onConfirmPrototype(artifactId)}>
                {confirming ? "确认中..." : "确认原型"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mr-auto w-full max-w-[min(92%,_760px)]">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-gray-400">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>需要确认</span>
      </div>
      <div className="border-l border-blue-300 py-1 pl-4 text-sm leading-6 text-blue-900">
        {runState.summary || "请在下方回复确认信息，我会继续处理。"}
      </div>
    </div>
  );
}

function chatHeaderStatusTone(
  sending?: boolean,
  runState?: VibeRunView | null,
): "neutral" | "info" | "success" | "warning" | "danger" {
  if (sending) return "warning";
  if (runState?.status === "canceled") return "neutral";
  return "neutral";
}

function formatMessageTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
