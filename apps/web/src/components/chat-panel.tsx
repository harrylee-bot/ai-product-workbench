"use client";

import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock3,
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

type ProcessRailRowView = {
  id: string;
  title: string;
  detail?: string;
  status: VibeRunTimelineItem["status"];
  meta?: string;
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
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-gray-400">
        <Sparkles className="h-3.5 w-3.5" />
        <span>{message.role === "system" ? "系统" : "Workbench"}</span>
        <span>·</span>
        <span>{formatMessageTime(message.createdAt)}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-700">
        {toChineseText(message.content)}
      </div>
    </div>
  );
}

/**
 * 纯对话 transcript：流式回复文本 → 执行过程信号轨 → 澄清对话 → 确认对话。
 * 默认只展示公开进度摘要，不展示隐藏推理链或原始 payload。
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
  const processRows = buildProcessRailRows(runState);
  const hasProcessRail = Boolean(processRows.length || toolCalls.length);
  const hasClarification = runState.status === "waiting_clarification";
  const hasConfirmation =
    runState.status === "waiting_prd_confirm" ||
    runState.status === "waiting_prototype_confirm" ||
    runState.status === "waiting_confirmation";

  // run 已完成且无流式占位、无过程、无澄清/确认时不渲染任何东西（结论由历史助手消息承载）。
  if (!showStreamingText && !hasProcessRail && !hasClarification && !hasConfirmation) {
    return null;
  }

  return (
    <div className="mr-auto flex w-full max-w-[min(92%,_760px)] flex-col gap-3">
      {showStreamingText ? (
        <div>
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-gray-400">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Workbench</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1 text-amber-600">
              <Clock3 className="h-3 w-3" />
              正在回复
            </span>
          </div>
          <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-700">
            {runState.streamingText}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 motion-safe:animate-pulse bg-gray-400 align-middle" aria-hidden="true" />
          </div>
        </div>
      ) : null}

      {hasProcessRail ? <AgentProcessRail rows={processRows} toolCalls={toolCalls} /> : null}

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

function AgentProcessRail({
  rows,
  toolCalls,
}: {
  rows: ProcessRailRowView[];
  toolCalls: VibeToolCallView[];
}) {
  return (
    <div className="mt-0.5">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px]">
        <span className="font-semibold tracking-wide text-gray-700">执行过程</span>
        <span className="text-gray-400">公开进度摘要，不显示隐藏推理</span>
      </div>
      <div className="relative ml-1 border-l border-gray-200 pl-4">
        {rows.map((row) => (
          <ProcessRailRow key={row.id} row={row} />
        ))}
        {toolCalls.length ? (
          <div className="pt-1">
            <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-gray-400">工具 / 技能</div>
            {toolCalls.map((call) => (
              <ToolCallRow key={call.id} call={call} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProcessRailRow({ row }: { row: ProcessRailRowView }) {
  return (
    <div className="relative py-1.5">
      <ProcessStatusDot status={row.status} />
      <div className="min-w-0 rounded-md px-2 py-1 transition hover:bg-gray-50">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-gray-700">{row.title}</span>
          {row.meta ? <span className="text-[11px] text-gray-400">{row.meta}</span> : null}
        </div>
        {row.detail ? <div className="mt-0.5 break-words text-xs leading-5 text-gray-500">{row.detail}</div> : null}
      </div>
    </div>
  );
}

function ProcessStatusDot({ status }: { status: VibeRunTimelineItem["status"] }) {
  const className = [
    "absolute -left-[21px] top-2.5 inline-flex h-3 w-3 items-center justify-center rounded-full border bg-white ring-2 ring-[var(--color-panel-bg)]",
    status === "running"
      ? "border-amber-300 bg-amber-100 motion-safe:animate-pulse"
      : status === "done"
        ? "border-emerald-300 bg-emerald-100"
        : status === "failed"
          ? "border-red-300 bg-red-100"
          : status === "warning"
            ? "border-amber-300 bg-amber-50"
            : "border-gray-300 bg-white",
  ].join(" ");
  const innerClassName = [
    "h-1.5 w-1.5 rounded-full",
    status === "running"
      ? "bg-amber-600"
      : status === "done"
        ? "bg-emerald-600"
        : status === "failed"
          ? "bg-red-600"
          : status === "warning"
            ? "bg-amber-600"
            : "bg-gray-400",
  ].join(" ");

  return (
    <span className={className} aria-hidden="true">
      <span className={innerClassName} />
    </span>
  );
}

function buildProcessRailRows(runState: VibeRunView): ProcessRailRowView[] {
  const rows: ProcessRailRowView[] = [];
  const seen = new Set<string>();
  const activeStepNames = new Set<string>();

  for (const step of runState.steps.filter((item) => item.status !== "pending")) {
    activeStepNames.add(step.step);
    const detail = normalizeProcessDetail(step.message || step.detail);
    const key = `step:${step.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (detail) seen.add(normalizeProcessKey(detail));
    rows.push({
      id: key,
      title: step.title,
      detail,
      meta: step.executor,
      status: stepStatusToRailStatus(step.status),
    });
  }

  const timelineRows = [...(runState.timeline ?? [])]
    .reverse()
    .flatMap((item) => {
      const detail = normalizeProcessDetail(item.text);
      if (!detail) return [];
      const detailKey = normalizeProcessKey(detail);
      if (seen.has(detailKey)) return [];
      if (item.step && activeStepNames.has(item.step) && detail.startsWith("节点目标：")) return [];
      seen.add(detailKey);
      return [{
        id: `timeline:${item.id}`,
        title: timelineRowTitle(item.status),
        detail,
        meta: item.createdAt ? formatMessageTime(item.createdAt) : undefined,
        status: item.status,
      }];
    })
    .slice(0, 6)
    .reverse();

  return [...rows, ...timelineRows];
}

function stepStatusToRailStatus(status: VibeRunStepStatus): VibeRunTimelineItem["status"] {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "canceled") return "warning";
  return "done";
}

function timelineRowTitle(status: VibeRunTimelineItem["status"]) {
  if (status === "running") return "正在处理";
  if (status === "done") return "已完成";
  if (status === "failed") return "执行失败";
  if (status === "warning") return "需要关注";
  return "进度摘要";
}

function normalizeProcessDetail(value?: string) {
  return value?.replace(/\s+/g, " ").trim();
}

function normalizeProcessKey(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function ToolCallRow({ call }: { call: VibeToolCallView }) {
  const statusIcon =
    call.status === "done" ? (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
    ) : call.status === "failed" ? (
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
    ) : (
      <Clock3 className="h-3.5 w-3.5 shrink-0 motion-safe:animate-pulse text-amber-600" />
    );
  const statusLabel = call.status === "done" ? "已完成" : call.status === "failed" ? "失败" : "执行中";
  const hasDetail = call.args !== undefined || Boolean(call.result);

  return (
    <details className="group relative py-1.5">
      <ProcessStatusDot status={call.status === "done" ? "done" : call.status === "failed" ? "failed" : "running"} />
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-50 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10">
        {statusIcon}
        <span className="font-medium text-gray-700">{call.toolName}</span>
        <span className="text-gray-300">·</span>
        <span className="text-gray-400">{statusLabel}</span>
      </summary>
      {hasDetail ? (
        <div className="mt-1 ml-2 space-y-1.5 rounded-md border-l border-gray-100 pl-3 text-xs leading-5 text-gray-500">
          {call.args !== undefined ? (
            <div>
              <div className="font-semibold text-gray-600">入参</div>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 text-[11px] text-gray-600">{formatToolDetail(call.args)}</pre>
            </div>
          ) : null}
          {call.result ? (
            <div>
              <div className="font-semibold text-gray-600">返回</div>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 text-[11px] text-gray-600">{call.result}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function formatToolDetail(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
