import type { LucideIcon } from "lucide-react";
import {
  CircleDollarSign,
  Clock3,
  Code2,
  FileText,
  GitBranch,
  Layers,
  Scale,
  Sparkles,
  Target,
} from "lucide-react";
import { Badge } from "@/components/ui";
import { EmptyPreview } from "./empty-preview";
import {
  compactNumber,
  constraintCount,
  decisionConstraintContext,
  derivePrototypeComponents,
  firstConstraints,
  formatShortDate,
  OUTCOME_LABELS,
  RULE_LABELS,
  statusLabel,
  toChineseText,
} from "./helpers";
import type {
  Phase1PrdPreview,
  Phase1PrototypePreview,
  Phase2DecisionView,
} from "./types";

export function StatePreviewView({
  decision,
  prdPreview,
  prototypePreview,
}: {
  decision?: Phase2DecisionView | null;
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
}) {
  const context = decisionConstraintContext(decision);
  const pendingItems = buildPendingConfirmations(decision);
  const timeline = buildVersionTimeline(decision, prdPreview, prototypePreview);
  const company = decision?.companyRuntime?.company;

  if (!decision && !prdPreview && !prototypePreview) {
    return (
      <div className="h-full p-4">
        <EmptyPreview
          title="暂无状态"
          description="生成结果后，这里会汇总指标、AI 推断、待确认问题和版本时间线。"
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
          <StateMetric icon={CircleDollarSign} label="预算" value={company ? compactNumber(company.budget) : "-"} />
        </div>

        <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
              <Sparkles className="h-4 w-4 text-blue-600" />
              AI 推断
            </div>
            <Badge tone={decision?.selfGeneration ? "accent" : "neutral"} className="bg-white">
              {decision?.selfGeneration ? "已推断" : "基础状态"}
            </Badge>
          </div>
          <div className="mt-3 grid gap-2">
            <InferenceRow label="瓶颈" value={decision?.selfGeneration?.insight.bottleneck ?? "等待更多运行样本"} />
            <InferenceRow label="弱点" value={decision?.selfGeneration?.insight.weakness ?? "暂无明确弱点"} />
            <InferenceRow label="机会" value={decision?.selfGeneration?.insight.opportunity ?? "可继续沉淀用户反馈"} />
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

function buildPendingConfirmations(decision?: Phase2DecisionView | null) {
  if (!decision) return ["等待生成结果后确认业务约束、补丁范围和 QA 回归。"];
  const items: string[] = [];
  if (decision.previewSession.riskPanel?.requiresConfirmation) {
    items.push("补丁预览需要人工确认后才能进入应用。");
  }
  firstConstraints(decisionConstraintContext(decision)).forEach((constraint) => {
    items.push(`${RULE_LABELS[constraint.rule]}：${toChineseText(constraint.condition)}`);
  });
  if (!decision.evolution.metrics.qaPassed) {
    items.push("进化结果显示 QA 未完全通过，需要重新 QA 或降低策略风险。");
  }
  return items.length ? items.slice(0, 5) : ["暂无阻断确认项，可继续收集反馈。"];
}

function buildVersionTimeline(
  decision?: Phase2DecisionView | null,
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
  if (decision) {
    items.push({
      id: "timeline-preview-session",
      title: "补丁预览会话",
      meta: `${statusLabel(decision.previewSession.status)} · ${decision.previewSession.operations.length} 个操作`,
      status: "active",
      icon: Code2,
    });
    items.push({
      id: "timeline-evolution",
      title: `策略进化 ${OUTCOME_LABELS[decision.evolution.finalOutcome]}`,
      meta: `${formatShortDate(decision.evolution.createdAt)} · policy v${decision.evolution.policyVersion}`,
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
