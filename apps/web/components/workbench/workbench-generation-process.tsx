"use client";

import type { GenerationPreview, Run, RunGenerationStage } from "@workbench/workbench-contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

type GenerationActivity = {
  id: string;
  detail: string | null;
  label: string;
  status: string;
};

const GENERATION_STAGE_LABELS: Partial<Record<RunGenerationStage, string>> = {
  thinking: "理解需求",
  "collecting-prd-context": "整理资料",
  "structuring-prd": "规划结构",
  "drafting-prd": "编写需求文档",
  "validating-prd": "检查需求文档",
  "design-system": "生成设计系统",
  "mapping-components": "映射界面组件",
  "creating-flows": "创建用户流程",
  "generating-ui": "生成界面",
  "screen-streaming": "流式生成页面",
  summarizing: "整理生成结果",
  "screen-stable": "稳定画布",
};

const ACTIVE_RUN_STATUSES: ReadonlySet<Run["status"]> = new Set([
  "queued",
  "running",
  "waiting_input",
  "cancelling",
]);

const PRD_STAGE_STEPS: Array<{ stage: RunGenerationStage; label: string; summary: string }> = [
  { stage: "thinking", label: "理解需求", summary: "确认目标、范围和交付物" },
  { stage: "collecting-prd-context", label: "整理资料", summary: "读取已授权的项目资料与知识库" },
  { stage: "structuring-prd", label: "规划结构", summary: "组织背景、业务规则和验收关系" },
  { stage: "drafting-prd", label: "编写文档", summary: "把结构整理成可编辑的需求文档" },
  { stage: "validating-prd", label: "检查文档", summary: "核对字段、引用、验收和安全边界" },
];

const PROTOTYPE_STAGE_STEPS: Array<{ stage: RunGenerationStage; label: string; summary: string }> = [
  { stage: "thinking", label: "理解需求", summary: "确认目标、范围和交付物" },
  { stage: "design-system", label: "设计系统", summary: "确定颜色、间距和组件层级" },
  { stage: "mapping-components", label: "映射组件", summary: "把需求映射到页面结构和组件" },
  { stage: "creating-flows", label: "串联流程", summary: "串联关键路径、状态和反馈" },
  { stage: "generating-ui", label: "生成界面", summary: "生成首屏和关键交互状态" },
  { stage: "screen-streaming", label: "流式补齐", summary: "逐步补齐页面内容和细节" },
  { stage: "summarizing", label: "整理结果", summary: "整理页面说明与生成结果" },
  { stage: "screen-stable", label: "稳定画布", summary: "准备把最终版本回写到画布" },
];

const PROTOTYPE_STAGES = new Set<RunGenerationStage>(PROTOTYPE_STAGE_STEPS.filter((step) => step.stage !== "thinking").map((step) => step.stage));

function processSteps(
  generationStage: RunGenerationStage | null,
  motionKind: "neutral" | "prd" | "prototype",
) {
  const prototype = motionKind === "prototype" || (generationStage !== null && PROTOTYPE_STAGES.has(generationStage));
  return prototype ? PROTOTYPE_STAGE_STEPS : PRD_STAGE_STEPS;
}

function stepState(
  step: { stage: RunGenerationStage },
  generationStage: RunGenerationStage | null,
  steps: ReadonlyArray<{ stage: RunGenerationStage }>,
) {
  if (!generationStage) return "pending";
  const current = steps.findIndex((candidate) => candidate.stage === generationStage);
  const index = steps.findIndex((candidate) => candidate.stage === step.stage);
  if (current < 0 || index < 0) return "pending";
  if (index < current) return "done";
  if (index === current) return "active";
  return "pending";
}

function isActiveRun(status: Run["status"] | null): boolean {
  return status !== null && ACTIVE_RUN_STATUSES.has(status);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function shortReleaseId(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 18) return normalized;
  return `${normalized.slice(0, 8)}…${normalized.slice(-6)}`;
}

function shortRunId(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 18) return normalized;
  return `${normalized.slice(0, 8)}…${normalized.slice(-6)}`;
}

function runStatusLabel(status: Run["status"] | null): string {
  switch (status) {
    case "queued": return "排队中";
    case "running": return "运行中";
    case "waiting_input": return "等待确认";
    case "cancelling": return "正在取消";
    case "succeeded": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    default: return "未开始";
  }
}

function formatDiagnosticTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
    hour12: false,
  }).format(parsed);
}

function shortDiagnosticText(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}…`;
}

export function WorkbenchGenerationProcess({
  activities = [], generationStage = null, motionKind = "neutral", previews,
  cancellationReason = null, failure = null, finishedAt = null, knowledgeReleaseId = null,
  lastEventSequence = null, retryOfRunId = null, runAttempt = null, runId = null,
  runStartedAt = null, runStatus = null, variant = "inline",
}: {
  activities?: readonly GenerationActivity[];
  cancellationReason?: string | null;
  failure?: Run["failure"] | null;
  finishedAt?: string | null;
  generationStage?: RunGenerationStage | null;
  knowledgeReleaseId?: string | null;
  lastEventSequence?: number | null;
  motionKind?: "neutral" | "prd" | "prototype";
  previews: readonly GenerationPreview[];
  retryOfRunId?: string | null;
  runAttempt?: number | null;
  runId?: string | null;
  runStartedAt?: string | null;
  runStatus?: Run["status"] | null;
  variant?: "inline" | "popover";
}) {
  const [processOpen, setProcessOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [elapsedMilliseconds, setElapsedMilliseconds] = useState(0);
  const contentId = useId();
  const activeRun = isActiveRun(runStatus);
  const preview = previews.at(-1);
  const steps = processSteps(generationStage, motionKind);
  const currentStepIndex = generationStage === null
    ? -1
    : steps.findIndex((step) => step.stage === generationStage);
  const progressPercent = currentStepIndex < 0
    ? 0
    : Math.round(((currentStepIndex + 1) / steps.length) * 100);
  const structure = preview?.kind === "prd"
    ? [...new Set((preview.markdown.match(/^#{1,6} .+$/gm) ?? []).map((line) => line.replace(/^#+ /, "")))].slice(0, 8)
    : preview?.screens.map((screen) => screen.name).filter(Boolean) ?? [];
  const evidence = activities.filter((activity) => activity.id.startsWith("knowledge:")).slice(-6);
  const documentReferences = activities.filter((activity) => activity.id.startsWith("document:")).slice(-6);
  const latestActivity = activities.at(-1);
  const diagnosticReason = failure?.message ?? cancellationReason;
  useEffect(() => {
    setProcessOpen(false);
    setDiagnosticsOpen(false);
    setElapsedMilliseconds(0);
    if (!activeRun) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedMilliseconds(Date.now() - startedAt), 1_000);
    return () => window.clearInterval(timer);
  }, [activeRun, runId]);
  if (!activeRun) return null;
  return (
    <div className={variant === "popover" ? "size-[24px] shrink-0" : "mt-3 min-h-0 border-t border-white/10 pt-2"}
      data-workbench-generation-process-anchor={variant}>
      <button
        aria-controls={contentId}
        aria-expanded={processOpen}
        aria-label={processOpen ? "收起生成过程" : "查看生成过程"}
        className={variant === "popover"
          ? "absolute inset-y-0 left-0 right-[40px] rounded-[13px] text-[#c7cad0] hover:bg-white/[0.025]"
          : "flex w-full items-center gap-2 rounded-md py-1 text-left text-xs text-[#c7cad0] hover:text-white"}
        onClick={() => setProcessOpen((open) => !open)}
        type="button"
      >
        <span className={variant === "popover" ? "sr-only" : "min-w-0 flex-1"}>
          生成过程 · {GENERATION_STAGE_LABELS[generationStage ?? "thinking"] ?? "准备中"} · {formatElapsed(elapsedMilliseconds)}
        </span>
        <ChevronDownIcon aria-hidden className={`${variant === "popover" ? "absolute right-2 top-1/2 -translate-y-1/2" : ""} size-4 shrink-0 transition-transform ${processOpen ? "rotate-180" : ""}`} />
      </button>
      {processOpen && (
        <section aria-label="生成过程" id={contentId} data-workbench-generation-process
          className={variant === "popover"
            ? "absolute inset-x-0 top-[calc(100%+8px)] z-[70] max-h-[min(52dvh,360px)] space-y-3 overflow-y-auto rounded-[13px] border border-white/10 bg-[#202125] p-3 text-[#d8dbe1] shadow-xl"
            : "mt-2 max-h-[260px] space-y-3 overflow-y-auto text-[#d8dbe1]"}>
              <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2" data-workbench-generation-timeline>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <p className="font-medium text-[#d8dbe1]">生成阶段时间线</p>
                  <span className="text-[#9da3ad]">{progressPercent}%</span>
                </div>
                <div aria-hidden="true" className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                  <div className="h-full rounded-full bg-[#8f86ff] transition-[width] duration-300" data-testid="generation-timeline-progress" style={{ width: `${progressPercent}%` }} />
                </div>
                <p className="mt-2 text-[11px] leading-4 text-[#9da3ad]">
                  {GENERATION_STAGE_LABELS[generationStage ?? "thinking"] ?? "等待运行时进入第一个阶段"}
                  {runStatus === "waiting_input" ? " · 等待确认" : runStatus === "cancelling" ? " · 正在取消" : ""}
                </p>
              </div>
              {runId && (
                <div className="rounded-md border border-white/[0.06] px-3 py-2 text-xs" data-workbench-run-correlation>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-[#d8dbe1]">运行标识</span>
                    <span className="font-mono text-[10px] text-[#b9bec7]">{shortRunId(runId)}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-[#9da3ad]">
                    {runAttempt === null || runAttempt === undefined ? "当前运行" : `第 ${runAttempt} 次尝试`}
                    {" · 用于关联阶段事件、产物版本和重试记录"}
                  </p>
                </div>
              )}
              {runId && (
                <div className="rounded-md border border-white/[0.06] px-3 py-2 text-xs" data-workbench-attempt-diagnostics>
                  <button
                    aria-expanded={diagnosticsOpen}
                    className="flex w-full items-center justify-between gap-3 text-left text-[#d8dbe1]"
                    onClick={() => setDiagnosticsOpen((open) => !open)}
                    type="button"
                  >
                    <span className="font-medium">{diagnosticsOpen ? "收起尝试诊断" : "查看尝试诊断"}</span>
                    <ChevronDownIcon aria-hidden className={`size-4 shrink-0 transition-transform ${diagnosticsOpen ? "rotate-180" : ""}`} />
                  </button>
                  {diagnosticsOpen && (
                    <dl className="mt-2 grid gap-2 text-[11px] leading-4 text-[#b9bec7]" data-workbench-attempt-diagnostics-details>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-[#9da3ad]">运行状态</dt>
                        <dd className="text-right text-[#d8dbe1]">{runStatusLabel(runStatus)}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-[#9da3ad]">重试关系</dt>
                        <dd className="text-right text-[#d8dbe1]">{retryOfRunId ? `重试自 ${shortRunId(retryOfRunId)}` : "首次运行"}</dd>
                      </div>
                      {(runStartedAt || finishedAt) && (
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-[#9da3ad]">生命周期</dt>
                          <dd className="text-right text-[#d8dbe1]">
                            {runStartedAt ? `开始 ${formatDiagnosticTime(runStartedAt)}` : "未记录开始时间"}
                            {finishedAt ? ` · 结束 ${formatDiagnosticTime(finishedAt)}` : ""}
                          </dd>
                        </div>
                      )}
                      {lastEventSequence !== null && lastEventSequence !== undefined && (
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-[#9da3ad]">事件证据</dt>
                          <dd className="text-right text-[#d8dbe1]">已接收 {lastEventSequence} 个有序事件</dd>
                        </div>
                      )}
                      {latestActivity && (
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-[#9da3ad]">最近阶段</dt>
                          <dd className="text-right text-[#d8dbe1]">{latestActivity.label} · {latestActivity.status}</dd>
                        </div>
                      )}
                      {diagnosticReason && (
                        <div className="border-t border-white/[0.06] pt-2 text-[#f2c1c1]" data-workbench-attempt-diagnostic-reason>
                          {shortDiagnosticText(diagnosticReason)}
                        </div>
                      )}
                    </dl>
                  )}
                </div>
              )}
              {knowledgeReleaseId && (
                <div className="rounded-md border border-[#6f67d9]/35 bg-[#6f67d9]/[0.08] px-3 py-2 text-xs" data-workbench-knowledge-binding>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-[#d8dbe1]">已绑定知识版本</span>
                    <span className="font-mono text-[10px] text-[#c8c3ff]">{shortReleaseId(knowledgeReleaseId)}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-[#b9bec7]">
                    生成文档和原型只能引用本次运行检索到的资料；引用证据会随产物一起校验。
                  </p>
                </div>
              )}
              {structure.length > 0 && (
                <div className="rounded-md border border-white/[0.06] px-3 py-2 text-xs text-[#b9bec7]">
                  <p className="font-medium">{preview?.kind === "prd" ? "当前文档结构" : "当前页面结构"}</p>
                  <ul className="mt-1 space-y-1">{structure.map((title) => <li key={title}>{title}</li>)}</ul>
                  <p className="mt-2 text-[#9da3ad]">根据当前草稿更新，尚未定稿。</p>
                </div>
              )}
              {evidence.length > 0 && (
                <div className="rounded-md border border-white/[0.06] px-3 py-2">
                  <p className="text-xs font-medium text-[#b9bec7]">参考资料 · 最近检索</p>
                  <ul className="mt-1 space-y-2 text-xs leading-5 text-[#b9bec7]">
                    {evidence.map((activity) => <li className="whitespace-pre-wrap break-words" key={activity.id}>
                      <span className="font-medium">{activity.status === "running" ? "检索中" : activity.status === "succeeded" ? "检索已返回" : "检索未完成"}</span>
                      {activity.detail ? `\n${activity.detail}` : ""}
                    </li>)}
                  </ul>
                </div>
              )}
              {documentReferences.length > 0 && (
                <div className="rounded-md border border-white/[0.06] px-3 py-2">
                  <p className="text-xs font-medium text-[#b9bec7]">文档规范 · 已读取</p>
                  <ul className="mt-1 space-y-2 text-xs leading-5 text-[#b9bec7]">
                    {documentReferences.map((activity) => <li className="whitespace-pre-wrap break-words" key={activity.id}>
                      <span className="font-medium">{activity.status === "running" ? "读取中" : activity.status === "succeeded" ? "读取完成" : "读取失败"}</span>
                      {activity.detail ? `\n${activity.detail}` : ""}
                    </li>)}
                  </ul>
                </div>
              )}
              <ol className="grid gap-2 sm:grid-cols-2">
                {steps.map((step) => {
                  const state = stepState(step, generationStage, steps);
                  return (
                    <li className="flex gap-2 rounded-md border border-white/[0.06] bg-white/[0.025] px-2.5 py-2" data-generation-step={step.stage} data-generation-step-state={state} key={step.stage}>
                      <span className={state === "done" ? "text-[#9de5b0]" : state === "active" ? "text-[#c8c3ff]" : "text-[#7d838d]"}>{state === "done" ? "✓" : state === "active" ? "•" : "○"}</span>
                      <span className="min-w-0">
                        <span className="block text-[11px] font-medium">{step.label}{state === "active" ? " · 进行中" : state === "done" ? " · 已完成" : " · 待进行"}</span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-[#9da3ad]">{step.summary}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>

        </section>
      )}
    </div>
  );
}
