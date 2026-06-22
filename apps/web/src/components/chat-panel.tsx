"use client";

import { FormEvent, useEffect, useState } from "react";
import { Bot, CheckCircle2, ChevronDown, Circle, GitBranch, LoaderCircle, Sparkles } from "lucide-react";
import type { Phase2DecisionView } from "@/components/preview-panel";
import { Badge, Button, EmptyState, TextArea } from "@/components/ui";

export type Phase1Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export function ChatPanel({
  messages,
  decision,
  disabled,
  sending,
  onSend,
}: {
  messages: Phase1Message[];
  decision?: Phase2DecisionView | null;
  disabled?: boolean;
  sending?: boolean;
  onSend: (content: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [runningStep, setRunningStep] = useState(0);

  async function submitDraft() {
    const content = draft.trim();
    if (!content || disabled || sending) return;
    await onSend(content);
    setDraft("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitDraft();
  }

  useEffect(() => {
    if (!sending) {
      setRunningStep(0);
      return;
    }
    setRunningStep(0);
    const timer = window.setInterval(() => {
      setRunningStep((value) => Math.min(value + 1, EXECUTION_STEPS.length - 1));
    }, 700);
    return () => window.clearInterval(timer);
  }, [sending]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel-bg)]">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-950">智能输入</div>
          <div className="truncate text-xs text-gray-500">说出目标，系统自动决策与生成</div>
        </div>
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
        {(sending || decision) ? (
          <ExecutionPathCard decision={decision} running={Boolean(sending)} runningStep={runningStep} />
        ) : null}
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-[var(--color-border)] bg-white px-3 py-2.5 shadow-[0_-10px_26px_rgba(15,23,42,0.04)]">
        <TextArea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled || sending}
          placeholder={sending ? "系统正在处理..." : "输入你的需求..."}
          rows={2}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submitDraft();
            }
          }}
          className="min-h-[56px] max-h-[112px] resize-none border-gray-200 bg-gray-50 py-2 shadow-none focus:bg-white"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="min-w-0 truncate text-xs text-gray-400">Enter 发送，Shift + Enter 换行</div>
          <Button type="submit" size="sm" disabled={disabled || sending || !draft.trim()}>
            <Sparkles className="h-4 w-4" />
            {sending ? "生成中" : "发送意图"}
          </Button>
        </div>
      </form>
    </section>
  );
}

type ExecutionStep = {
  title: string;
  agent: string;
  detail: string;
};

const EXECUTION_STEPS: ExecutionStep[] = [
  { title: "理解意图", agent: "意图智能体", detail: "识别用户目标与需求类型" },
  { title: "应用约束", agent: "约束系统", detail: "检查必须遵守、优先、避免和提醒规则" },
  { title: "生成策略", agent: "决策引擎", detail: "生成多种策略并计算加权得分" },
  { title: "多方评审", agent: "评审委员会", detail: "产品、体验、技术、风险、增长智能体参与评分" },
  { title: "选择方案", agent: "策略选择器", detail: "选择综合得分最高且风险可控的策略" },
  { title: "生成预览", agent: "补丁预览", detail: "生成变更草案，保持确认前不直接应用" },
  { title: "记录进化", agent: "进化系统", detail: "写入决策轨迹并更新策略权重" },
  { title: "输出结果", agent: "编排器", detail: "生成需求文档与可交互网页原型" },
];

function ExecutionPathCard({
  decision,
  running,
  runningStep,
}: {
  decision?: Phase2DecisionView | null;
  running: boolean;
  runningStep: number;
}) {
  const [open, setOpen] = useState(false);
  const completed = Boolean(decision) && !running;
  const currentStep = running ? EXECUTION_STEPS[runningStep] : EXECUTION_STEPS.at(-1);
  const strategy = decision?.selectedStrategy ? strategyLabel(decision.selectedStrategy.name) : "等待策略结果";
  const knowledgeCount = decision?.knowledgeSearch?.results.length ?? 0;
  const knowledgeSummary = decision?.knowledgeSearch?.summary;
  const completedSubtitle = knowledgeCount
    ? `已完成：${strategy}，命中 ${knowledgeCount} 条知识`
    : `已完成：${strategy}`;

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
            {running ? `正在执行：${currentStep?.title ?? "智能编排"}` : completedSubtitle}
          </span>
        </span>
        <Badge tone={completed ? "success" : "warning"}>{completed ? "已完成" : "运行中"}</Badge>
        <ChevronDown className={["h-4 w-4 text-gray-400 transition", open ? "rotate-180" : ""].join(" ")} />
      </button>

      {open ? (
        <div className="border-t border-gray-200 bg-gray-50 px-3 py-2.5">
          <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-[var(--shadow-control)]">
            <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <Bot className="h-3.5 w-3.5" />
                已运行智能流程
              </span>
              <span>{completed ? "成功" : "处理中"}</span>
            </div>
            <div className="space-y-2">
              {EXECUTION_STEPS.map((step, index) => {
                const status = completed ? "done" : index < runningStep ? "done" : index === runningStep ? "running" : "pending";
                const detail = step.title === "应用约束" && knowledgeSummary ? knowledgeSummary : step.detail;
                return (
                  <div key={step.title} className="flex gap-2 rounded-lg bg-gray-50 px-2 py-2 text-xs">
                    <StepIcon status={status} />
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
          {decision ? (
            <div className="mt-2 text-xs leading-5 text-gray-500">
              已选择「{strategy}」，共生成 {decision.decisionPlan.strategies.length} 个策略，评审智能体{" "}
              {decision.reviewBoard.reviews.length} 位。{knowledgeCount ? `本轮知识库命中 ${knowledgeCount} 条。` : "本轮未命中正式知识库。"}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StepIcon({ status }: { status: "done" | "running" | "pending" }) {
  if (status === "done") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "running") return <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-600" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />;
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
