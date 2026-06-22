"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ListChecks,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { EmptyPreview } from "./empty-preview";
import {
  normalizeRisk,
  riskLabel,
  statusLabel,
  toChineseText,
} from "./helpers";
import type { Phase2DecisionView, QaIssue, QaSeverity } from "./types";

export function QaPreviewView({ decision }: { decision?: Phase2DecisionView | null }) {
  const [rerunning, setRerunning] = useState(false);
  const issues = useMemo(() => buildQaIssues(decision), [decision]);
  const stats = qaIssueStats(issues);
  const risk = normalizeRisk(decision?.companyRuntime?.qaReport.riskLevel ?? decision?.previewSession.riskPanel?.level);
  const recommendations = decision?.companyRuntime?.qaReport.recommendations ?? [];

  if (!decision) {
    return (
      <div className="h-full p-4">
        <EmptyPreview
          title="暂无 QA 结果"
          description="完成一次生成后，这里会显示严重程度、统计和重新 QA 状态。"
        />
      </div>
    );
  }

  const rerunQa = () => {
    setRerunning(true);
    window.setTimeout(() => setRerunning(false), 720);
  };

  return (
    <div className="workbench-scrollbar h-full overflow-y-auto p-2.5">
      <div className="space-y-3">
        <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
                <ShieldAlert className="h-4 w-4 text-amber-600" />
                QA 扫描
              </div>
              <div className="mt-1 text-xs text-gray-500">风险等级 {riskLabel(risk)} · {statusLabel(decision.previewSession.status)}</div>
            </div>
            <Button type="button" size="sm" variant="secondary" disabled={rerunning} onClick={rerunQa}>
              {rerunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {rerunning ? "QA 中" : "重新 QA"}
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <QaStatCard label="严重" value={stats.critical} severity="critical" />
            <QaStatCard label="警告" value={stats.warning} severity="warning" />
            <QaStatCard label="通过" value={stats.passed} severity="passed" />
          </div>
        </div>

        <div className="space-y-2">
          {issues.map((issue) => (
            <div key={issue.id} className={qaIssueClass(issue.severity)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {issue.severity === "critical" ? (
                      <AlertTriangle className="h-4 w-4 text-red-600" />
                    ) : issue.severity === "warning" ? (
                      <ShieldAlert className="h-4 w-4 text-amber-600" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    )}
                    <div className="truncate text-sm font-semibold text-gray-950">{issue.title}</div>
                  </div>
                  <div className="mt-1 text-xs leading-5 text-gray-600">{issue.detail}</div>
                </div>
                <Badge tone={severityTone(issue.severity)}>{severityLabel(issue.severity)}</Badge>
              </div>
              <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">{issue.source}</div>
            </div>
          ))}
        </div>

        {recommendations.length ? (
          <div className="rounded-[var(--radius-panel)] border border-sky-100 bg-sky-50 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-sky-900">
              <ListChecks className="h-4 w-4" />
              QA 建议
            </div>
            <div className="mt-2 space-y-1.5">
              {recommendations.map((item) => (
                <div key={item} className="rounded-lg bg-white/80 px-2.5 py-2 text-xs leading-5 text-sky-900">
                  {toChineseText(item)}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QaStatCard({ label, value, severity }: { label: string; value: number; severity: QaSeverity }) {
  return (
    <div className={qaStatClass(severity)}>
      <div className="text-base font-semibold">{value}</div>
      <div className="text-[11px]">{label}</div>
    </div>
  );
}

function buildQaIssues(decision?: Phase2DecisionView | null): QaIssue[] {
  if (!decision) return [];
  const report = decision.companyRuntime?.qaReport;
  const risk = normalizeRisk(report?.riskLevel ?? decision.previewSession.riskPanel?.level);
  const reportIssues = report?.issues ?? [];
  const issues: QaIssue[] = reportIssues.map((issue, index) => ({
    id: `qa-report-${index}`,
    title: toChineseText(issue),
    detail: toChineseText(report?.recommendations[index] ?? "需要在应用前确认影响范围和回归路径。"),
    severity: risk === "high" && index === 0 ? "critical" : "warning",
    source: "QA Report",
  }));

  if (decision.previewSession.riskPanel?.requiresConfirmation) {
    issues.unshift({
      id: "qa-confirmation",
      title: "补丁应用需要人工确认",
      detail: "当前预览包含需要确认的风险项，建议完成选区回归后再应用。",
      severity: risk === "high" ? "critical" : "warning",
      source: "Risk Panel",
    });
  }

  Object.entries(decision.previewSession.riskPanel?.checks ?? {})
    .filter(([, passed]) => !passed)
    .forEach(([name], index) => {
      issues.push({
        id: `qa-check-${index}-${name}`,
        title: `${toChineseText(name)} 未通过`,
        detail: "该检查项未通过，需要重新生成或缩小补丁范围。",
        severity: "warning",
        source: "Preview Checks",
      });
    });

  if (!issues.length) {
    issues.push({
      id: "qa-passed",
      title: "当前预览未发现阻断问题",
      detail: "基础检查通过，可继续收集反馈或进入应用确认。",
      severity: "passed",
      source: "QA Report",
    });
  }

  return issues;
}

function qaIssueStats(issues: QaIssue[]) {
  return {
    critical: issues.filter((issue) => issue.severity === "critical").length,
    warning: issues.filter((issue) => issue.severity === "warning").length,
    passed: Math.max(issues.filter((issue) => issue.severity === "passed").length, issues.length ? 1 : 0),
  };
}

function severityLabel(severity: QaSeverity) {
  if (severity === "critical") return "严重";
  if (severity === "warning") return "警告";
  return "通过";
}

function severityTone(severity: QaSeverity) {
  if (severity === "critical") return "danger" as const;
  if (severity === "warning") return "warning" as const;
  return "success" as const;
}

function qaIssueClass(severity: QaSeverity) {
  const base = "rounded-[var(--radius-panel)] border bg-white p-3 shadow-[var(--shadow-control)]";
  if (severity === "critical") return `${base} border-red-200`;
  if (severity === "warning") return `${base} border-amber-200`;
  return `${base} border-emerald-200`;
}

function qaStatClass(severity: QaSeverity) {
  const base = "rounded-[12px] border px-3 py-2";
  if (severity === "critical") return `${base} border-red-200 bg-red-50 text-red-700`;
  if (severity === "warning") return `${base} border-amber-200 bg-amber-50 text-amber-700`;
  return `${base} border-emerald-200 bg-emerald-50 text-emerald-700`;
}
