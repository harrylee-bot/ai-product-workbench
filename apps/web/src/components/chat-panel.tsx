"use client";

import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock3,
  FileCode2,
  FileText,
  ListChecks,
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
  disabled,
  sending,
  confirmingPrd,
  onConfirmPrd,
  confirmingPrototypeId,
  onConfirmPrototype,
  onSend,
}: {
  messages: Phase1Message[];
  runState?: VibeRunView | null;
  disabled?: boolean;
  sending?: boolean;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
  onSend: (content: string) => Promise<void> | void;
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel-bg)]">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-950">智能输入</div>
          <div className="truncate text-xs text-gray-500">说出目标，系统自动决策与生成</div>
        </div>
        <Badge tone={sending ? "warning" : "neutral"} className="bg-white">
          {sending ? (
            <span className="inline-flex items-center gap-1">
              <Circle className="h-3.5 w-3.5 fill-amber-100 text-amber-600" />
              运行中
            </span>
          ) : "可输入"}
        </Badge>
      </div>
      <div className="workbench-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.length || runState ? (
          <>
            {messages.map((message) => (
            <div
              key={message.id}
              className={[
                "w-fit max-w-[min(86%,_720px)] whitespace-pre-wrap rounded-[12px] px-3 py-2 text-sm leading-6 shadow-[var(--shadow-control)]",
                message.role === "user"
                  ? "ml-auto bg-[var(--color-primary)] text-white"
                  : "mr-auto border border-gray-200 bg-white text-gray-700",
              ].join(" ")}
            >
              {toChineseText(message.content)}
            </div>
            ))}
            <AgentActivityFeed
              runState={runState}
              confirmingPrd={confirmingPrd}
              onConfirmPrd={onConfirmPrd}
              confirmingPrototypeId={confirmingPrototypeId}
              onConfirmPrototype={onConfirmPrototype}
            />
          </>
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

  const timeline = (runState.timeline ?? []).slice(-10);
  const debugEvents = (runState.debugEvents ?? []).slice(-6);
  const artifactEvents = timeline.filter((item) =>
    item.step === "prd_generation" || item.step === "prototype_code_generation" || item.step === "qa_check" || /PRD|原型|HTML|QA|导出/.test(item.text)
  );

  return (
    <div className="mr-auto w-full max-w-[min(92%,_760px)] rounded-[12px] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="h-4 w-4 shrink-0 text-gray-500" />
          <div className="truncate text-sm font-semibold text-gray-950">Agent 过程</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={runStatusTone(runState.status)}>{runStatusLabel(runState.status)}</Badge>
          <RunConfirmationActions
            runState={runState}
            confirmingPrd={confirmingPrd}
            onConfirmPrd={onConfirmPrd}
            confirmingPrototypeId={confirmingPrototypeId}
            onConfirmPrototype={onConfirmPrototype}
          />
        </div>
      </div>
      <AgentPlanChecklist runState={runState} />
      {runState.summary || runState.errorMessage ? (
        <div className="mt-2 rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600">
          {runState.errorMessage || runState.summary}
        </div>
      ) : null}
      <div className="mt-3 space-y-2">
        {timeline.length ? timeline.map((item) => <ActivityRow key={item.id} item={item} />) : <ActivityEmpty text="暂无执行事件。" />}
      </div>
      <div className="mt-3 border-t border-gray-100 pt-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-500">
          <Wrench className="h-3.5 w-3.5" />
          工具调用与事件
        </div>
        <div className="space-y-2">
          {debugEvents.length ? debugEvents.map((item) => <ToolEventRow key={item.id} item={item} />) : <ActivityEmpty text="暂无工具事件。" />}
        </div>
      </div>
      {artifactEvents.length ? (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-500">
            <FileCode2 className="h-3.5 w-3.5" />
            产物变化
          </div>
          <div className="space-y-2">
            {artifactEvents.slice(-4).map((item) => <ArtifactEventRow key={`${item.id}:artifact`} item={item} />)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentPlanChecklist({ runState }: { runState: VibeRunView }) {
  const completed = runState.steps.filter((step) => step.status === "done").length;

  return (
    <div className="mt-3 rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gray-800">
          <ListChecks className="h-4 w-4 shrink-0 text-gray-500" />
          <span className="truncate">执行清单</span>
        </div>
        <span className="shrink-0 text-xs font-semibold text-gray-500">第 {Math.min(completed + 1, runState.steps.length)}/{runState.steps.length} 步</span>
      </div>
      <div className="space-y-1.5">
        {runState.steps.map((step) => (
          <div key={step.step} className="flex min-w-0 items-start gap-2 text-sm leading-5 text-gray-700">
            <StepStatusIcon status={step.status} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{step.title}</div>
              {step.status === "running" || step.status === "failed" ? (
                <div className="truncate text-xs text-gray-500">{step.message || step.detail}</div>
              ) : null}
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
