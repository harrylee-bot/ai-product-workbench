import type { LucideIcon } from "lucide-react";
import {
  Clock3,
  Code2,
  FileText,
  GitBranch,
  Layers,
  Scale,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
import { Badge } from "@/components/ui";
import { EmptyPreview } from "./empty-preview";
import {
  compactNumber,
  constraintCount,
  derivePrototypeComponents,
  firstConstraints,
  formatShortDate,
  normalizeRisk,
  RULE_LABELS,
  riskLabel,
  runtimeConstraintContext,
  statusLabel,
  toChineseText,
} from "./helpers";
import type {
  Phase1PrdPreview,
  Phase1PrototypePreview,
  RuntimePatchPreview,
} from "./types";

export function StatePreviewView({
  runtimePreview,
  prdPreview,
  prototypePreview,
}: {
  runtimePreview?: RuntimePatchPreview | null;
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
}) {
  const context = runtimeConstraintContext(runtimePreview);
  const pendingItems = buildPendingConfirmations(runtimePreview);
  const timeline = buildVersionTimeline(runtimePreview, prdPreview, prototypePreview);
  const qaIssueCount = runtimePreview?.qaReport?.issues?.length ?? 0;

  if (!runtimePreview && !prdPreview && !prototypePreview) {
    return (
      <div className="h-full p-4">
        <EmptyPreview
          title="暂无状态"
          description="生成结果后，这里会汇总产品指标、运行时摘要、待确认问题和版本时间线。"
        />
      </div>
    );
  }

  return (
    <div className="workbench-scrollbar h-full overflow-y-auto p-2.5">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <StateMetric icon={FileText} label="PRD 章节" value={prdPreview?.sections.length ?? 0} />
          <StateMetric icon={Layers} label="原型组件" value={derivePrototypeComponents(prototypePreview?.html ?? "").length} />
          <StateMetric icon={Scale} label="约束" value={constraintCount(context)} />
          <StateMetric icon={ShieldCheck} label="QA 问题" value={compactNumber(qaIssueCount)} />
        </div>

        <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
              <Sparkles className="h-4 w-4 text-blue-600" />
              Runtime 摘要
            </div>
            <Badge tone={runtimePreview ? "accent" : "neutral"} className="bg-white">
              {runtimePreview ? "有运行结果" : "基础状态"}
            </Badge>
          </div>
          <div className="mt-3 grid gap-2">
            <InferenceRow label="状态" value={runtimeStatus(runtimePreview)} />
            <InferenceRow label="补丁范围" value={runtimePatchScope(runtimePreview)} />
            <InferenceRow label="QA 风险" value={runtimeRisk(runtimePreview)} />
          </div>
        </div>

        <div className="rounded-[var(--radius-panel)] border border-amber-100 bg-amber-50 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <Target className="h-4 w-4" />
            待确认问题
          </div>
          <div className="mt-2 space-y-1.5">
            {pendingItems.map((item) => (
              <div key={item} className="break-words rounded-lg bg-white/80 px-2.5 py-2 text-xs leading-5 text-amber-900" title={item}>
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
            <GitBranch className="h-4 w-4 text-gray-700" />
            版本时间线
          </div>
          <div className="mt-3 space-y-2">
            {timeline.map((item, index) => {
              const Icon = item.icon;
              return (
                <div key={item.id} className="flex gap-2">
                  <div className="flex flex-col items-center">
                    <span className={item.status === "done" ? "inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700" : "inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-blue-700"}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    {index < timeline.length - 1 ? <span className="h-7 w-px bg-gray-200" /> : null}
                  </div>
                  <div className="min-w-0 pb-2">
                    <div className="break-words text-xs font-semibold text-gray-950" title={item.title}>{item.title}</div>
                    <div className="mt-0.5 break-words text-[11px] leading-4 text-gray-500" title={item.meta}>{item.meta}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function StateMetric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number | string }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-gray-100 text-gray-700">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 break-words text-right text-lg font-semibold text-gray-950" title={String(value)}>{value}</div>
      </div>
      <div className="mt-2 text-xs text-gray-500">{label}</div>
    </div>
  );
}

function InferenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[12px] border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="text-[11px] font-semibold text-gray-500">{label}</div>
      <div className="mt-1 break-words text-xs leading-5 text-gray-800" title={toChineseText(value)}>{toChineseText(value)}</div>
    </div>
  );
}

function buildPendingConfirmations(runtimePreview?: RuntimePatchPreview | null) {
  if (!runtimePreview) return ["等待生成结果后确认业务约束、补丁范围和 QA 回归。"];
  const items: string[] = [];
  if (runtimePreview.previewSession?.riskPanel?.requiresConfirmation) {
    items.push("补丁预览需要人工确认后才能进入应用。");
  }
  firstConstraints(runtimeConstraintContext(runtimePreview)).forEach((constraint) => {
    items.push(`${RULE_LABELS[constraint.rule]}：${toChineseText(constraint.condition)}`);
  });
  const qaPassed = runtimePreview.qaReport?.passed ?? (
    runtimePreview.qaReport ? (runtimePreview.qaReport.issues?.length ?? 0) === 0 : true
  );
  if (!qaPassed) {
    items.push("QA 仍有需要处理的问题，建议重新检查或缩小补丁范围。");
  }
  return items.length ? items.slice(0, 5) : ["暂无阻断确认项，可继续收集反馈。"];
}

function buildVersionTimeline(
  runtimePreview?: RuntimePatchPreview | null,
  prdPreview?: Phase1PrdPreview | null,
  prototypePreview?: Phase1PrototypePreview | null,
) {
  const items: Array<{
    id: string;
    title: string;
    meta: string;
    status: "done" | "active";
    icon: LucideIcon;
  }> = [];
  if (prdPreview) {
    items.push({
      id: "timeline-prd",
      title: "PRD 已生成",
      meta: `${prdPreview.sections.length} 个章节进入可读编辑状态`,
      status: "done",
      icon: FileText,
    });
  }
  if (prototypePreview) {
    items.push({
      id: "timeline-prototype",
      title: "原型已生成",
      meta: prototypePreview.entryFilePath ?? "index.html",
      status: "done",
      icon: Layers,
    });
  }
  if (runtimePreview?.previewSession) {
    const operations = runtimePreview.previewSession.operations
      ?? runtimePreview.patchDraft?.operations
      ?? [];
    items.push({
      id: "timeline-preview-session",
      title: "补丁预览会话",
      meta: `${statusLabel(runtimePreview.previewSession.status)} · ${operations.length} 个操作`,
      status: "active",
      icon: Code2,
    });
  }
  if (runtimePreview?.qaReport) {
    const issueCount = runtimePreview.qaReport.issues?.length ?? 0;
    items.push({
      id: "timeline-qa",
      title: runtimePreview.qaReport.passed === false ? "QA 待处理" : "QA 已完成",
      meta: [
        `${issueCount} 个问题`,
        runtimePreview.qaReport.createdAt ? formatShortDate(runtimePreview.qaReport.createdAt) : "",
      ].filter(Boolean).join(" · "),
      status: "done",
      icon: GitBranch,
    });
  }
  return items.length ? items : [{
    id: "timeline-empty",
    title: "等待首次生成",
    meta: "生成 PRD 或原型后会形成版本时间线",
    status: "active" as const,
    icon: Clock3,
  }];
}

function runtimeStatus(runtimePreview?: RuntimePatchPreview | null) {
  const status = runtimePreview?.previewSession?.status ?? runtimePreview?.runtimeSummary?.status;
  return status ? statusLabel(status) : "等待运行结果";
}

function runtimePatchScope(runtimePreview?: RuntimePatchPreview | null) {
  const operations = runtimePreview?.previewSession?.operations
    ?? runtimePreview?.patchDraft?.operations
    ?? [];
  if (!operations.length) return "暂无补丁候选";
  return `${operations.length} 个状态路径操作`;
}

function runtimeRisk(runtimePreview?: RuntimePatchPreview | null) {
  const risk = normalizeRisk(runtimePreview?.qaReport?.riskLevel ?? runtimePreview?.previewSession?.riskPanel?.level);
  return riskLabel(risk);
}
