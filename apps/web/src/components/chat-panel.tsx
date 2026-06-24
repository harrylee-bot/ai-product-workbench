"use client";

import { useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  GitBranch,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import type { Phase2DecisionView } from "@/components/preview-panel";
import { Badge, Button, EmptyState } from "@/components/ui";
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
  agent: string;
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

export type VibeRunView = {
  runId?: string;
  status: "idle" | "running" | "waiting_confirmation" | "waiting_prd_confirm" | "waiting_prototype_confirm" | "completed" | "failed";
  currentLabel?: string;
  summary?: string;
  steps: VibeRunStepView[];
  timeline?: VibeRunTimelineItem[];
  debugEvents?: VibeRunDebugEvent[];
  knowledgeHitCount?: number;
  qaIssueCount?: number;
  qaGateStatus?: "open" | "warning" | "blocked";
  qaGateSummary?: string;
  exportFileName?: string;
  patchId?: string;
  patchPreviewMessage?: string;
  prototypeArtifactId?: string;
  /** 确认门 A：用户确认 PRD 后是否应继续生成原型（FR-1.3） */
  wantsPrototype?: boolean;
  errorMessage?: string;
};

export function ChatPanel({
  messages,
  decision,
  runState,
  disabled,
  sending,
  confirmingPatchId,
  onConfirmPatch,
  confirmingPrd,
  onConfirmPrd,
  confirmingPrototypeId,
  onConfirmPrototype,
  onSend,
}: {
  messages: Phase1Message[];
  decision?: Phase2DecisionView | null;
  runState?: VibeRunView | null;
  disabled?: boolean;
  sending?: boolean;
  confirmingPatchId?: string;
  onConfirmPatch?: (patchId: string) => Promise<void> | void;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
  onSend: (content: string) => Promise<void> | void;
}) {
  const displayRun = runState ?? (decision ? legacyRunStateFromDecision(decision) : null);
  const running = sending || displayRun?.status === "running";

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
        {messages.length ? (
          messages.map((message) => (
            <div
              key={message.id}
              className={[
                "w-fit max-w-[min(86%,_720px)] rounded-[12px] px-3 py-2 text-sm leading-6 shadow-[var(--shadow-control)]",
                message.role === "user"
                  ? "ml-auto bg-[var(--color-primary)] text-white"
                  : "mr-auto border border-gray-200 bg-white text-gray-700",
              ].join(" ")}
            >
              {toChineseText(message.content)}
            </div>
          ))
        ) : (
          <EmptyState
            title="从一句目标开始"
            description="系统会自动经过约束、决策、进化与统一编排，并生成需求结果、设计结果和执行路径。"
            icon={<Sparkles className="h-5 w-5" />}
          />
        )}
        {displayRun ? (
          <ExecutionPathCard
            runState={displayRun}
            running={Boolean(running)}
            confirmingPatchId={confirmingPatchId}
            onConfirmPatch={onConfirmPatch}
            confirmingPrd={confirmingPrd}
            onConfirmPrd={onConfirmPrd}
            confirmingPrototypeId={confirmingPrototypeId}
            onConfirmPrototype={onConfirmPrototype}
          />
        ) : null}
      </div>
      <ChatComposer disabled={disabled} sending={sending} onSend={onSend} />
    </section>
  );
}

function ExecutionPathCard({
  runState,
  running,
  confirmingPatchId,
  onConfirmPatch,
  confirmingPrd,
  onConfirmPrd,
  confirmingPrototypeId,
  onConfirmPrototype,
}: {
  runState: VibeRunView;
  running: boolean;
  confirmingPatchId?: string;
  onConfirmPatch?: (patchId: string) => Promise<void> | void;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const completed = runState.status === "completed";
  const waitingForConfirmation = runState.status === "waiting_confirmation";
  const waitingForPrdConfirm = runState.status === "waiting_prd_confirm";
  const waitingForPrototypeConfirm = runState.status === "waiting_prototype_confirm";
  const failed = runState.status === "failed";
  const canConfirmPatch = waitingForConfirmation && Boolean(runState.patchId && onConfirmPatch);
  const confirmingPatch = Boolean(runState.patchId && confirmingPatchId === runState.patchId);
  const canConfirmPrd = waitingForPrdConfirm && Boolean(onConfirmPrd);
  const canConfirmPrototype = waitingForPrototypeConfirm && Boolean(runState.prototypeArtifactId && onConfirmPrototype);
  const confirmingPrototype = Boolean(runState.prototypeArtifactId && confirmingPrototypeId === runState.prototypeArtifactId);
  const activeStep = runState.steps.find((step) => step.status === "running")
    ?? lastActiveStep(runState.steps)
    ?? runState.steps[0];
  const timeline = runState.timeline ?? [];
  const doneCount = runState.steps.filter((step) => step.status === "done").length;
  const settledLike = completed || waitingForConfirmation || waitingForPrdConfirm || waitingForPrototypeConfirm;
  const progress = settledLike
    ? 100
    : Math.max(4, Math.round((doneCount / Math.max(runState.steps.length, 1)) * 100));
  const subtitle = failed
    ? runState.errorMessage ?? "运行失败，请查看失败步骤"
    : waitingForPrdConfirm
      ? runState.summary ?? "PRD 已生成，请确认无误"
    : waitingForPrototypeConfirm
      ? runState.summary ?? "原型已生成，请确认无误"
    : waitingForConfirmation
      ? runState.summary ?? "Patch 候选已生成，等待确认"
      : running
      ? runState.currentLabel ?? `正在执行：${activeStep?.title ?? "Vibe 智能编排"}`
      : runState.summary ?? "运行已完成";
  const waitingLabel = waitingForPrdConfirm ? "待确认 PRD" : waitingForPrototypeConfirm ? "待确认原型" : "待确认";

  return (
    <div className="mr-auto max-w-[96%] overflow-hidden rounded-[14px] border border-gray-200 bg-white shadow-[var(--shadow-control)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-gray-50 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
      >
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <GitBranch className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-gray-950">执行路径</span>
          <span className="block truncate text-xs text-gray-500">
            {subtitle}
          </span>
        </span>
        <Badge tone={failed ? "danger" : completed ? "success" : "warning"}>
          {failed ? "失败" : waitingForPrdConfirm || waitingForPrototypeConfirm ? waitingLabel : waitingForConfirmation ? "待确认" : completed ? "已完成" : `${doneCount + 1}/${runState.steps.length}`}
        </Badge>
        <ChevronDown className={["h-4 w-4 text-gray-400 transition", open ? "rotate-180" : ""].join(" ")} />
      </button>
      <div className="h-1 bg-gray-100">
        <div
          className={[
            "h-full rounded-r-full transition-all duration-500",
            failed ? "bg-red-500" : completed ? "bg-emerald-500" : "bg-amber-500",
          ].join(" ")}
          style={{ width: `${progress}%` }}
        />
      </div>

      {timeline.length ? (
        <div className="border-t border-gray-100 bg-white px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1">
              <Bot className="h-3.5 w-3.5" />
              过程播报
            </span>
            <span>{timeline.length} 条更新</span>
          </div>
          <div className="space-y-2">
            {timeline.map((item) => (
              <div key={item.id} className="flex gap-2 text-xs leading-5">
                <TimelineIcon item={item} />
                <span className="min-w-0 flex-1 text-gray-700">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {canConfirmPrd ? (
        <div className="flex items-center justify-between gap-3 border-t border-sky-100 bg-sky-50 px-3 py-2">
          <span className="min-w-0 truncate text-xs text-sky-900">
            {runState.summary ?? (runState.wantsPrototype
              ? "确认无误后将继续生成原型；如需修改可直接在预览中编辑或在下方提出意见。"
              : "PRD 已生成，确认无误后可继续生成原型。")}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={Boolean(confirmingPrd)}
            onClick={() => void onConfirmPrd?.(runState.wantsPrototype ?? true)}
            title="确认 PRD 并生成原型"
          >
            {confirmingPrd ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {confirmingPrd ? "生成中" : "确认并生成原型"}
          </Button>
        </div>
      ) : null}

      {canConfirmPrototype ? (
        <div className="flex items-center justify-between gap-3 border-t border-emerald-100 bg-emerald-50 px-3 py-2">
          <span className="min-w-0 truncate text-xs text-emerald-900">
            {runState.summary ?? "原型确认后即可创建只读分享链接；如需修改可先在预览中选区编辑。"}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={confirmingPrototype}
            onClick={() => runState.prototypeArtifactId ? void onConfirmPrototype?.(runState.prototypeArtifactId) : undefined}
            title="确认原型"
          >
            {confirmingPrototype ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {confirmingPrototype ? "确认中" : "确认原型"}
          </Button>
        </div>
      ) : null}

      {canConfirmPatch ? (
        <div className="flex items-center justify-between gap-3 border-t border-amber-100 bg-amber-50 px-3 py-2">
          <span className="min-w-0 truncate text-xs text-amber-900">
            {runState.patchPreviewMessage ?? "确认后将应用 Patch 并重新生成 PRD、原型和 QA。"}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={confirmingPatch}
            onClick={() => runState.patchId ? void onConfirmPatch?.(runState.patchId) : undefined}
            title="确认应用 Patch"
          >
            {confirmingPatch ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {confirmingPatch ? "应用中" : "应用 Patch"}
          </Button>
        </div>
      ) : null}

      {open ? (
        <div className="border-t border-gray-200 bg-gray-50 px-3 py-2.5">
          <div className="px-1 py-1">
            <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <Bot className="h-3.5 w-3.5" />
                详细步骤
              </span>
              <span>{failed ? "失败" : waitingForConfirmation || waitingForPrdConfirm || waitingForPrototypeConfirm ? "待确认" : completed ? "成功" : "处理中"}</span>
            </div>
            <div className="space-y-2">
              {runState.steps.map((step) => {
                const detail = step.message ?? step.detail;
                return (
                  <div key={step.step} className="flex gap-2 rounded-lg bg-gray-50 px-2 py-2 text-xs">
                    <StepIcon status={step.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-gray-900">{step.title}</span>
                        <span className="shrink-0 text-gray-500">{step.agent}</span>
                      </div>
                      <div className="mt-1 leading-5 text-gray-500">{detail}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {runState.debugEvents?.length ? (
            <div className="mt-3 border-t border-gray-200 pt-3">
              <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                <span className="inline-flex items-center gap-1">
                  <Bot className="h-3.5 w-3.5" />
                  调试详情
                </span>
                <span>{runState.debugEvents.length} 个事件</span>
              </div>
              <div className="space-y-2">
                {runState.debugEvents.map((event) => (
                  <div key={event.id} className="rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs">
                    <div className="flex items-start gap-2">
                      <TimelineIcon item={event} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-semibold text-gray-900">{event.title}</span>
                          <span className="text-gray-400">{event.type}</span>
                        </div>
                        <div className="mt-1 whitespace-pre-wrap leading-5 text-gray-600">{event.body}</div>
                        {event.raw ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-gray-500 hover:text-gray-900">原始事件</summary>
                            <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-gray-950 px-2 py-2 text-[11px] leading-4 text-gray-100">
                              {event.raw}
                            </pre>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {runState.knowledgeHitCount || runState.qaIssueCount !== undefined || runState.qaGateSummary || runState.exportFileName || runState.patchId ? (
            <div className="mt-2 text-xs leading-5 text-gray-500">
              {runState.knowledgeHitCount ? `本轮知识库命中 ${runState.knowledgeHitCount} 条。` : null}
              {runState.qaIssueCount !== undefined ? `QA 发现 ${runState.qaIssueCount} 个问题。` : null}
              {runState.qaGateSummary ? `QA 闸门：${runState.qaGateSummary}` : null}
              {runState.exportFileName ? `导出文件：${runState.exportFileName}` : null}
              {runState.patchId ? `Patch 候选：${runState.patchId}。${runState.patchPreviewMessage ?? ""}` : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StepIcon({ status }: { status: VibeRunStepStatus }) {
  if (status === "done") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "running") return <Circle className="mt-0.5 h-4 w-4 shrink-0 fill-amber-100 text-amber-600" />;
  if (status === "failed") return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />;
}

function TimelineIcon({ item }: { item: { status: VibeRunTimelineItem["status"] } }) {
  if (item.status === "done") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (item.status === "running") return <Circle className="mt-0.5 h-4 w-4 shrink-0 fill-amber-100 text-amber-600" />;
  if (item.status === "failed") return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />;
  if (item.status === "warning") return <Circle className="mt-0.5 h-4 w-4 shrink-0 fill-amber-50 text-amber-500" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 fill-sky-50 text-sky-500" />;
}

function lastActiveStep(steps: VibeRunStepView[]) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.status === "done" || step?.status === "failed") return step;
  }
  return undefined;
}

function legacyRunStateFromDecision(decision: Phase2DecisionView): VibeRunView {
  return {
    status: "completed",
    summary: `已完成：${strategyLabel(decision.selectedStrategy.name)}`,
    steps: [
      {
        step: "legacy_decision",
        title: "历史决策结果",
        agent: "旧链路",
        detail: `已生成 ${decision.decisionPlan.strategies.length} 个策略，评审智能体 ${decision.reviewBoard.reviews.length} 位。`,
        status: "done",
      },
    ],
    knowledgeHitCount: decision.knowledgeSearch?.results.length,
  };
}

function strategyLabel(name: Phase2DecisionView["selectedStrategy"]["name"]) {
  const labels: Record<Phase2DecisionView["selectedStrategy"]["name"], string> = {
    conservative_fix: "保守修正",
    ux_improve: "体验优化",
    structure_rewrite: "结构重写",
    full_regenerate: "完整重建",
    conservative: "保守策略",
    balanced: "平衡策略",
    aggressive: "进取策略",
    full_rewrite: "完整重写",
  };
  return labels[name] ?? name;
}

function toChineseText(value: string) {
  return value
    .replace(/AI Product Workbench/g, "智能产品工作台")
    .replace(/AI Product OS/g, "智能产品操作系统")
    .replace(/AI Product Company/g, "智能产品公司")
    .replace(/Triple System Fusion/g, "三系统融合")
    .replace(/Triple System/g, "三系统融合")
    .replace(/Constraint System/g, "约束系统")
    .replace(/Decision System/g, "决策系统")
    .replace(/Evolution System/g, "进化系统")
    .replace(/Constraint/g, "约束系统")
    .replace(/Decision/g, "决策系统")
    .replace(/Evolution/g, "进化系统")
    .replace(/Patch Preview/g, "补丁预览")
    .replace(/PatchDraft/g, "补丁草稿")
    .replace(/Patch/g, "补丁")
    .replace(/Prototype/g, "原型")
    .replace(/PRD/g, "需求文档")
    .replace(/QA/g, "质检")
    .replace(/AI/g, "智能");
}
