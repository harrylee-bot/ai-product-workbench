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
import { Badge, EmptyState } from "@/components/ui";
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

export type VibeRunView = {
  runId?: string;
  status: "idle" | "running" | "completed" | "failed";
  currentLabel?: string;
  summary?: string;
  steps: VibeRunStepView[];
  knowledgeHitCount?: number;
  qaIssueCount?: number;
  exportFileName?: string;
  errorMessage?: string;
};

export function ChatPanel({
  messages,
  decision,
  runState,
  disabled,
  sending,
  onSend,
}: {
  messages: Phase1Message[];
  decision?: Phase2DecisionView | null;
  runState?: VibeRunView | null;
  disabled?: boolean;
  sending?: boolean;
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
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
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
          <ExecutionPathCard runState={displayRun} running={Boolean(running)} />
        ) : null}
      </div>
      <ChatComposer disabled={disabled} sending={sending} onSend={onSend} />
    </section>
  );
}

function ExecutionPathCard({
  runState,
  running,
}: {
  runState: VibeRunView;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const completed = runState.status === "completed";
  const failed = runState.status === "failed";
  const activeStep = runState.steps.find((step) => step.status === "running")
    ?? lastActiveStep(runState.steps)
    ?? runState.steps[0];
  const doneCount = runState.steps.filter((step) => step.status === "done").length;
  const progress = completed
    ? 100
    : Math.max(4, Math.round((doneCount / Math.max(runState.steps.length, 1)) * 100));
  const subtitle = failed
    ? runState.errorMessage ?? "运行失败，请查看失败步骤"
    : running
      ? runState.currentLabel ?? `正在执行：${activeStep?.title ?? "Vibe 智能编排"}`
      : runState.summary ?? "运行已完成";

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
          {failed ? "失败" : completed ? "已完成" : `${doneCount + 1}/${runState.steps.length}`}
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

      {open ? (
        <div className="border-t border-gray-200 bg-gray-50 px-3 py-2.5">
          <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-[var(--shadow-control)]">
            <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <Bot className="h-3.5 w-3.5" />
                Vibe Coding 主链路
              </span>
              <span>{failed ? "失败" : completed ? "成功" : "处理中"}</span>
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
          {runState.knowledgeHitCount || runState.qaIssueCount !== undefined || runState.exportFileName ? (
            <div className="mt-2 text-xs leading-5 text-gray-500">
              {runState.knowledgeHitCount ? `本轮知识库命中 ${runState.knowledgeHitCount} 条。` : null}
              {runState.qaIssueCount !== undefined ? `QA 发现 ${runState.qaIssueCount} 个问题。` : null}
              {runState.exportFileName ? `导出文件：${runState.exportFileName}` : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StepIcon({ status }: { status: VibeRunStepStatus }) {
  if (status === "done") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "running") return <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-600" />;
  if (status === "failed") return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />;
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
