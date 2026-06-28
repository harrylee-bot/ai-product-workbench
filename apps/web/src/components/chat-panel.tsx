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
  HelpCircle,
  ListChecks,
  PanelLeftOpen,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
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
            <div className="text-sm font-semibold text-gray-950">对话执行</div>
            <div className="truncate text-xs text-gray-500">消息、Agent 过程和工具事件</div>
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
      <ChatComposer disabled={disabled} sending={sending} stopping={stoppingRun} onStop={onStopRun} onSend={onSend} />
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
  const artifactEvents = timeline.filter(isProductChangeEvent);
  const visibleSteps = visibleRunSteps(runState);
  const productChangeItems = artifactEvents.slice(-4);

  return (
    <div className="mr-auto w-full max-w-[min(96%,_1100px)] space-y-2">
      <div className="rounded-[14px] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
        <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
              <TerminalSquare className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="truncate text-sm font-semibold text-gray-950">执行过程</div>
                <Badge tone={runStatusTone(runState.status)}>{runStatusLabel(runState.status)}</Badge>
              </div>
              <div className="mt-1 break-words text-sm leading-6 text-gray-600">
                {runCardSummary(runState)}
              </div>
          </div>
        </div>
      </div>

      {/* Phase 2 透明化：assistant 逐字流式思考文本，像真人对话一样实时显示在干什么 */}
      {runState.streamingText ? (
        <div className="mr-auto max-w-[min(88%,_760px)]">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-gray-400">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Workbench</span>
            <span className="inline-flex items-center gap-1 text-amber-600">
              <Clock3 className="h-3 w-3" />
              正在思考
            </span>
          </div>
          <div className="whitespace-pre-wrap rounded-[14px] border border-gray-200 bg-white px-3.5 py-2.5 text-sm leading-6 text-gray-700 shadow-[var(--shadow-control)]">
            {runState.streamingText}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-gray-400 align-middle" aria-hidden="true" />
          </div>
        </div>
      ) : null}

      {/* Phase 2 透明化：工具调用平铺展示（名称 + 状态 + 可展开入参/返回） */}
      {runState.toolCalls?.length ? (
        <div className="rounded-[14px] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-500">
            <Wrench className="h-3.5 w-3.5" />
            工具调用
          </div>
          <div className="space-y-1.5">
            {runState.toolCalls.map((call) => <ToolCallRow key={call.id} call={call} />)}
          </div>
        </div>
      ) : null}

      <ClarificationCard runState={runState} />
      <ConfirmationCard
        runState={runState}
        confirmingPrd={confirmingPrd}
        onConfirmPrd={onConfirmPrd}
        confirmingPrototypeId={confirmingPrototypeId}
        onConfirmPrototype={onConfirmPrototype}
      />
      <AgentStepDisclosure steps={visibleSteps} timeline={timeline} />
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

function ToolCallRow({ call }: { call: VibeToolCallView }) {
  const statusIcon = call.status === "done"
    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
    : call.status === "failed"
      ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
      : <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  const statusLabel = call.status === "done" ? "已完成" : call.status === "failed" ? "失败" : "执行中";
  const hasDetail = call.args !== undefined || Boolean(call.result);

  return (
    <details className="rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        {statusIcon}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800">{call.toolName}</span>
        <span className="shrink-0 text-[11px] text-gray-400">{statusLabel}</span>
      </summary>
      {hasDetail ? (
        <div className="mt-2 space-y-1.5 text-xs leading-5 text-gray-500">
          {call.args !== undefined ? (
            <div>
              <div className="font-semibold text-gray-600">入参</div>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-[11px] text-gray-600">{formatToolDetail(call.args)}</pre>
            </div>
          ) : null}
          {call.result ? (
            <div>
              <div className="font-semibold text-gray-600">返回</div>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-[11px] text-gray-600">{call.result}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function formatToolDetail(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function ClarificationCard({ runState }: { runState: VibeRunView }) {
  if (runState.status !== "waiting_clarification") return null;
  const questions = runState.clarificationQuestions ?? [];

  return (
    <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-3 shadow-[var(--shadow-control)]">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-amber-700 ring-1 ring-amber-200">
          <HelpCircle className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-amber-950">需要补充信息</div>
            <Badge tone="warning" className="bg-white">等待回复</Badge>
          </div>
          <p className="mt-1 break-words text-sm leading-6 text-amber-900">
            {runState.summary || "我需要先确认这些信息，再继续生成后续产物。请在下方输入框直接回复。"}
          </p>
          <div className="mt-3 space-y-2">
            {questions.length ? questions.map((question, index) => (
              <ClarificationQuestionRow key={question.id} question={question} index={index} />
            )) : (
              <div className="rounded-[var(--radius-control)] border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900">
                请补充关键目标、用户范围、页面边界或约束条件。
              </div>
            )}
          </div>
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
    <div className="rounded-[var(--radius-control)] border border-amber-200 bg-white px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[11px] font-semibold text-amber-800">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
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
          {question.recommendation ? (
            <div className="mt-2 break-words text-xs leading-5 text-amber-800">建议：{question.recommendation}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConfirmationCard({
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
      <div className="rounded-[14px] border border-blue-200 bg-blue-50 p-3 shadow-[var(--shadow-control)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-2">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-blue-700 ring-1 ring-blue-200">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-blue-950">需要确认后继续</div>
              <p className="mt-1 break-words text-sm leading-6 text-blue-900">
                {runState.summary || "PRD 已生成。确认后我会继续推进后续原型生成。"}
              </p>
            </div>
          </div>
          {onConfirmPrd ? (
            <Button type="button" size="sm" disabled={confirmingPrd} onClick={() => onConfirmPrd(true)} className="w-full sm:w-auto">
              {confirmingPrd ? "确认中..." : "确认并继续"}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (runState.status === "waiting_prototype_confirm") {
    const artifactId = runState.prototypeArtifactId;
    const confirming = Boolean(artifactId && confirmingPrototypeId === artifactId);
    return (
      <div className="rounded-[14px] border border-blue-200 bg-blue-50 p-3 shadow-[var(--shadow-control)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-2">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-blue-700 ring-1 ring-blue-200">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-blue-950">需要确认/授权继续</div>
              <p className="mt-1 break-words text-sm leading-6 text-blue-900">
                {runState.summary || "原型已生成。确认后会标记为可分享和可发布的稳定版本。"}
              </p>
            </div>
          </div>
          {artifactId && onConfirmPrototype ? (
            <Button type="button" size="sm" disabled={confirming} onClick={() => onConfirmPrototype(artifactId)} className="w-full sm:w-auto">
              {confirming ? "确认中..." : "确认原型"}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (runState.status === "waiting_confirmation") {
    return (
      <div className="rounded-[14px] border border-blue-200 bg-blue-50 p-3 text-sm leading-6 text-blue-900 shadow-[var(--shadow-control)]">
        <div className="font-semibold text-blue-950">需要确认</div>
        <div className="mt-1 break-words">{runState.summary || "请在下方回复确认信息，我会继续处理。"}</div>
      </div>
    );
  }

  return null;
}

function AgentStepDisclosure({
  steps,
  timeline,
}: {
  steps: VibeRunStepView[];
  timeline: VibeRunTimelineItem[];
}) {
  return (
    <details open className="group rounded-[14px] border border-gray-200 bg-white shadow-[var(--shadow-control)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 transition group-open:rotate-90" />
        <ListChecks className="h-4 w-4 shrink-0 text-gray-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">
          执行步骤（{steps.length}）
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
          原始事件流（{debugEvents.length}）
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
        <div className="break-words text-sm leading-5 text-gray-800">{item.text}</div>
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
      <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-gray-500">{item.body}</div>
    </details>
  );
}

function ArtifactEventRow({ item }: { item: VibeRunTimelineItem }) {
  const Icon = item.step === "prd_generation" ? FileText : FileCode2;
  return (
    <div className="flex gap-2 rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 py-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
      <div className="min-w-0 flex-1 break-words text-sm leading-5 text-gray-800">{item.text}</div>
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
  const canceled = runState.status === "canceled";
  return [
    {
      step: "answer",
      title: runState.status === "running" ? "生成回复" : canceled ? "已停止" : "完成回复",
      executor: "Workbench",
      detail: summary,
      status: runState.status === "failed" ? "failed" : canceled ? "canceled" : runState.status === "running" ? "running" : "done",
      message: summary,
    },
  ];
}

function isProductChangeEvent(item: VibeRunTimelineItem) {
  return (
    item.step === "product_design" ||
    item.step === "prd_generation" ||
    item.step === "prototype_design" ||
    item.step === "prototype_code_generation"
  );
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
  if (status === "canceled") return <Circle className="h-3.5 w-3.5 shrink-0 fill-gray-100 text-gray-500" />;
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
    running: "正在执行，可停止",
    waiting_clarification: "待补充",
    waiting_confirmation: "待确认",
    waiting_prd_confirm: "待确认 PRD",
    waiting_prototype_confirm: "待确认原型",
    completed: "已完成",
    canceled: "已停止",
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

function chatHeaderStatusTone(
  sending?: boolean,
  runState?: VibeRunView | null,
): "neutral" | "info" | "success" | "warning" | "danger" {
  if (sending) return "warning";
  if (runState?.status === "canceled") return "neutral";
  return "neutral";
}

function runCardSummary(runState: VibeRunView) {
  if (runState.status === "running") {
    return runState.summary || runState.currentLabel || "正在执行，可停止。步骤、工具调用和事件会持续记录在下方。";
  }
  if (runState.status === "canceled") {
    return runState.summary || "已停止。本轮执行没有被标记为失败，你可以继续输入新的消息。";
  }
  return runState.errorMessage || runState.summary || runState.currentLabel || "正在整理对话上下文和执行路径。";
}

function stepStatusLabel(status: VibeRunStepStatus) {
  const labels: Record<VibeRunStepStatus, string> = {
    pending: "待执行",
    running: "执行中",
    done: "已完成",
    canceled: "已停止",
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
