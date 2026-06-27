"use client";

import {
  AlertCircle,
  ChevronRight,
  CheckCircle2,
  Circle,
  Clock3,
  Copy,
  FileCode2,
  FileText,
  ListChecks,
  PanelLeftOpen,
  Plus,
  Search,
  Sparkles,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { Badge, Button, EmptyState } from "@/components/ui";
import { toChineseText } from "@/components/workspace-preview/helpers";
import { ChatComposer } from "./workspace-chat/chat-composer";

export type Phase1Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type VibeRunStepStatus = "pending" | "running" | "done" | "failed";

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
    | "failed";
  currentLabel?: string;
  summary?: string;
  steps: VibeRunStepView[];
  timeline?: VibeRunTimelineItem[];
  debugEvents?: VibeRunDebugEvent[];
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
  creatingConversation,
  onToggleSidebar,
  onCreateConversation,
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
  creatingConversation?: boolean;
  onToggleSidebar?: () => void;
  onCreateConversation?: () => void;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
  onSend: (content: string) => Promise<void> | void;
}) {
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
              <span className="truncate">搜索会话内容...</span>
            </div>
            <button
              type="button"
              onClick={onCreateConversation}
              disabled={creatingConversation}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-gray-950 px-3 text-sm font-semibold text-white shadow-[var(--shadow-control)] transition hover:bg-gray-800 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-60"
              title={creatingConversation ? "正在创建任务" : "新任务"}
            >
              <Plus className="h-4 w-4" />
              <span>新任务</span>
            </button>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-950">任务执行</div>
            <div className="truncate text-xs text-gray-500">消息、Agent 过程和工具事件</div>
          </div>
        )}
        <Badge tone={sending ? "warning" : "neutral"} className="bg-white">
          {sending ? (
            <span className="inline-flex items-center gap-1">
              <Circle className="h-3.5 w-3.5 fill-amber-100 text-amber-600" />
              运行中
            </span>
          ) : "可输入"}
        </Badge>
      </div>
      <div className="workbench-scrollbar relative min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length || runState ? <MessageNavigationRail messages={messages} runState={runState} /> : null}
        {messages.length || runState ? (
          <div className="space-y-4 pl-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            <AgentActivityFeed
              runState={runState}
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
      <ChatComposer disabled={disabled} sending={sending} onSend={onSend} />
    </section>
  );
}

function MessageNavigationRail({
  messages,
  runState,
}: {
  messages: Phase1Message[];
  runState?: VibeRunView | null;
}) {
  const dotCount = Math.min(8, messages.length + (runState ? 1 : 0));
  if (!dotCount) return null;

  return (
    <div className="absolute left-2 top-4 flex w-3 flex-col items-center gap-1.5" aria-hidden="true">
      {Array.from({ length: dotCount }).map((_, index) => (
        <span
          key={index}
          className={[
            "h-1.5 w-1.5 rounded-full",
            index === dotCount - 1 ? "bg-gray-500" : "bg-gray-300",
          ].join(" ")}
        />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: Phase1Message }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[min(82%,_720px)]">
        <div className="mb-1 text-right text-[11px] font-semibold text-gray-400">{formatMessageTime(message.createdAt)}</div>
        <div className="whitespace-pre-wrap rounded-[14px] bg-[var(--color-primary)] px-3.5 py-2.5 text-sm leading-6 text-white shadow-[var(--shadow-control)]">
          {toChineseText(message.content)}
        </div>
      </div>
    );
  }

  return (
    <div className="mr-auto max-w-[min(88%,_760px)]">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-gray-400">
        <Sparkles className="h-3.5 w-3.5" />
        <span>{message.role === "system" ? "系统" : "Workbench"}</span>
        <span>{formatMessageTime(message.createdAt)}</span>
      </div>
      <div className="whitespace-pre-wrap rounded-[14px] border border-gray-200 bg-white px-3.5 py-2.5 text-sm leading-6 text-gray-700 shadow-[var(--shadow-control)]">
        {toChineseText(message.content)}
      </div>
    </div>
  );
}

function RunConfirmationActions({
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
  if (runState.status === "waiting_prd_confirm" && onConfirmPrd) {
    return (
      <Button type="button" size="sm" disabled={confirmingPrd} onClick={() => onConfirmPrd(true)}>
        确认 PRD
      </Button>
    );
  }

  if (runState.status === "waiting_prototype_confirm" && runState.prototypeArtifactId && onConfirmPrototype) {
    const confirming = confirmingPrototypeId === runState.prototypeArtifactId;
    return (
      <Button
        type="button"
        size="sm"
        disabled={confirming}
        onClick={() => onConfirmPrototype(runState.prototypeArtifactId!)}
      >
        确认原型
      </Button>
    );
  }

  return null;
}

function AgentActivityFeed({
  runState,
  confirmingPrd,
  onConfirmPrd,
  confirmingPrototypeId,
  onConfirmPrototype,
}: {
  runState?: VibeRunView | null;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
}) {
  if (!runState) return null;

  const timeline = (runState.timeline ?? []).slice(-12);
  const debugEvents = (runState.debugEvents ?? []).slice(-10);
  const artifactEvents = timeline.filter((item) =>
    item.step === "prd_generation" || item.step === "prototype_code_generation" || item.step === "qa_check" || /PRD|原型|HTML|QA|导出/.test(item.text)
  );
  const visibleSteps = visibleRunSteps(runState);
  const productChangeItems = artifactEvents.length
    ? artifactEvents.slice(-4)
    : visibleProductChangeItems(runState);

  return (
    <div className="mr-auto w-full max-w-[min(96%,_1100px)] space-y-2">
      <div className="rounded-[14px] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-2">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
              <TerminalSquare className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="truncate text-sm font-semibold text-gray-950">深度思考</div>
                <Badge tone={runStatusTone(runState.status)}>{runStatusLabel(runState.status)}</Badge>
              </div>
              <div className="mt-1 text-sm leading-6 text-gray-600">
                {runState.errorMessage || runState.summary || runState.currentLabel || "正在整理任务上下文和执行路径。"}
              </div>
            </div>
          </div>
          <RunConfirmationActions
            runState={runState}
            confirmingPrd={confirmingPrd}
            onConfirmPrd={onConfirmPrd}
            confirmingPrototypeId={confirmingPrototypeId}
            onConfirmPrototype={onConfirmPrototype}
          />
        </div>
      </div>

      <AgentStepDisclosure
        runState={runState}
        steps={visibleSteps}
        timeline={timeline}
      />
      <ToolEventDisclosure debugEvents={debugEvents} />
      {productChangeItems.length ? (
        <div className="rounded-[14px] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-500">
            <FileCode2 className="h-3.5 w-3.5" />
            产物变化
          </div>
          <div className="space-y-2">
            {productChangeItems.map((item) => <ArtifactEventRow key={`${item.id}:artifact`} item={item} />)}
          </div>
        </div>
      ) : null}
      <RunFinalActions runState={runState} />
    </div>
  );
}

function AgentStepDisclosure({
  runState,
  steps,
  timeline,
}: {
  runState: VibeRunView;
  steps: VibeRunStepView[];
  timeline: VibeRunTimelineItem[];
}) {
  return (
    <details className="group rounded-[14px] border border-gray-200 bg-white shadow-[var(--shadow-control)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 transition group-open:rotate-90" />
        <ListChecks className="h-4 w-4 shrink-0 text-gray-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">
          查看 {steps.length} 个步骤
        </span>
        <span className="shrink-0 text-xs text-gray-400">实时更新</span>
      </summary>
      <div className="space-y-3 border-t border-gray-100 px-3 py-3">
        <AgentPlanChecklist steps={steps} />
        <div className="space-y-2">
          {timeline.length ? timeline.map((item) => <ActivityRow key={item.id} item={item} />) : <ActivityEmpty text="暂无执行事件。" />}
        </div>
      </div>
    </details>
  );
}

function ToolEventDisclosure({ debugEvents }: { debugEvents: VibeRunDebugEvent[] }) {
  return (
    <details className="group rounded-[14px] border border-gray-200 bg-white shadow-[var(--shadow-control)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 transition group-open:rotate-90" />
        <Wrench className="h-4 w-4 shrink-0 text-gray-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">
          查看 {debugEvents.length} 个工具调用与事件
        </span>
        <span className="shrink-0 text-xs text-gray-400">可展开</span>
      </summary>
      <div className="space-y-2 border-t border-gray-100 px-3 py-3">
        {debugEvents.length ? debugEvents.map((item) => <ToolEventRow key={item.id} item={item} />) : <ActivityEmpty text="暂无工具事件。" />}
      </div>
    </details>
  );
}

function AgentPlanChecklist({ steps }: { steps: VibeRunStepView[] }) {
  const completed = steps.filter((step) => step.status === "done").length;

  return (
    <div className="rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gray-800">
          <ListChecks className="h-4 w-4 shrink-0 text-gray-500" />
          <span className="truncate">执行清单</span>
        </div>
        <span className="shrink-0 text-xs font-semibold text-gray-500">第 {Math.min(completed + 1, steps.length)}/{steps.length} 步</span>
      </div>
      <div className="space-y-1.5">
        {steps.map((step) => (
          <div key={step.step} className="flex min-w-0 items-start gap-2 text-sm leading-5 text-gray-700">
            <StepStatusIcon status={step.status} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="truncate font-medium">{step.title}</div>
                <span className="shrink-0 text-[11px] text-gray-400">{stepStatusLabel(step.status)}</span>
              </div>
              <div className="truncate text-xs text-gray-500">{step.message || step.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: VibeRunTimelineItem }) {
  return (
    <div className="flex gap-2 rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 py-2">
      <TimelineStatusIcon status={item.status} />
      <div className="min-w-0 flex-1">
        <div className="text-sm leading-5 text-gray-800">{item.text}</div>
        <div className="mt-1 text-xs text-gray-400">{item.step || "runtime"}</div>
      </div>
    </div>
  );
}

function ToolEventRow({ item }: { item: VibeRunDebugEvent }) {
  return (
    <details className="rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <TimelineStatusIcon status={item.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800">{item.title}</span>
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] text-gray-400">{item.type}</span>
      </summary>
      <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-gray-500">{item.body}</div>
    </details>
  );
}

function ArtifactEventRow({ item }: { item: VibeRunTimelineItem }) {
  const Icon = item.step === "prd_generation" ? FileText : FileCode2;
  return (
    <div className="flex gap-2 rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 py-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
      <div className="min-w-0 flex-1 text-sm leading-5 text-gray-800">{item.text}</div>
    </div>
  );
}

function ActivityEmpty({ text }: { text: string }) {
  return <div className="rounded-[var(--radius-control)] border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-center text-xs text-gray-500">{text}</div>;
}

function visibleRunSteps(runState: VibeRunView): VibeRunStepView[] {
  const activeSteps = runState.steps.filter((step) => step.status !== "pending");
  if (activeSteps.length) return activeSteps;

  const summary = runState.errorMessage || runState.summary || runState.currentLabel || "本轮回复已生成。";
  return [
    {
      step: "answer",
      title: runState.status === "running" ? "生成回复" : "完成回复",
      executor: "Workbench",
      detail: summary,
      status: runState.status === "failed" ? "failed" : runState.status === "running" ? "running" : "done",
      message: summary,
    },
  ];
}

function visibleProductChangeItems(runState: VibeRunView): VibeRunTimelineItem[] {
  const text = runState.errorMessage || runState.summary || runState.currentLabel;
  if (!text) return [];
  return [
    {
      id: `${runState.runId ?? "run"}:product-change-summary`,
      text,
      status: runState.status === "failed" ? "failed" : runState.status === "running" ? "running" : "done",
      step: "answer",
    },
  ];
}

function RunFinalActions({ runState }: { runState: VibeRunView }) {
  if (runState.status === "running" || runState.status === "idle") return null;
  const copyText = formatRunSummary(runState, "text");
  const markdownText = formatRunSummary(runState, "markdown");

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-gray-200 bg-white px-3 py-2 shadow-[var(--shadow-control)]">
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(copyText)}
        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-xs font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
      >
        <Copy className="h-3.5 w-3.5" />
        复制文本
      </button>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(markdownText)}
        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-xs font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
      >
        <Copy className="h-3.5 w-3.5" />
        复制 Markdown 格式
      </button>
    </div>
  );
}

function StepStatusIcon({ status }: { status: VibeRunStepStatus }) {
  if (status === "done") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />;
  if (status === "failed") return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />;
  if (status === "running") return <Clock3 className="h-3.5 w-3.5 shrink-0 text-amber-600" />;
  return <Circle className="h-3.5 w-3.5 shrink-0 text-gray-300" />;
}

function TimelineStatusIcon({ status }: { status: VibeRunTimelineItem["status"] }) {
  if (status === "done") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "failed" || status === "warning") return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  if (status === "running") return <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />;
}

function runStatusLabel(status: VibeRunView["status"]) {
  const labels: Record<VibeRunView["status"], string> = {
    idle: "空闲",
    running: "运行中",
    waiting_clarification: "待补充",
    waiting_confirmation: "待确认",
    waiting_prd_confirm: "待确认 PRD",
    waiting_prototype_confirm: "待确认原型",
    completed: "已完成",
    failed: "失败",
  };
  return labels[status];
}

function runStatusTone(status: VibeRunView["status"]): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "failed") return "danger";
  if (status === "running") return "warning";
  if (status.startsWith("waiting_")) return "info";
  if (status === "completed") return "success";
  return "neutral";
}

function stepStatusLabel(status: VibeRunStepStatus) {
  const labels: Record<VibeRunStepStatus, string> = {
    pending: "待执行",
    running: "执行中",
    done: "已完成",
    failed: "失败",
  };
  return labels[status];
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

function formatRunSummary(runState: VibeRunView, format: "text" | "markdown") {
  const summary = runState.errorMessage || runState.summary || runState.currentLabel || "本轮执行已完成。";
  const steps = visibleRunSteps(runState).map((step) => `${stepStatusLabel(step.status)}：${step.title}`).join("\n");

  if (format === "markdown") {
    return [
      `## ${runStatusLabel(runState.status)}`,
      "",
      summary,
      "",
      "### 执行步骤",
      steps,
    ].join("\n");
  }

  return [`状态：${runStatusLabel(runState.status)}`, `摘要：${summary}`, "执行步骤：", steps].join("\n");
}
