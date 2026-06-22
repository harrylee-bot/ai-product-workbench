"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const [qaError, setQaError] = useState<string | null>(null);
  const rerunTimerRef = useRef<number | null>(null);
  const issues = useMemo(() => buildQaIssues(decision), [decision]);
  const stats = qaIssueStats(issues);
  const risk = normalizeRisk(decision?.companyRuntime?.qaReport.riskLevel ?? decision?.previewSession.riskPanel?.level);
  const recommendations = decision?.companyRuntime?.qaReport.recommendations ?? [];

  useEffect(() => {
    return () => {
      if (rerunTimerRef.current !== null) {
        window.clearTimeout(rerunTimerRef.current);
      }
    };
  }, []);

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
    setQaError(null);
    if (rerunTimerRef.current !== null) {
      window.clearTimeout(rerunTimerRef.current);
    }
    rerunTimerRef.current = window.setTimeout(() => {
      setRerunning(false);
      rerunTimerRef.current = null;
    }, 720);
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
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={rerunning}
              onClick={rerunQa}
              title={rerunning ? "QA 正在重新扫描" : "重新执行 QA 扫描"}
            >
              {rerunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {rerunning ? "QA 中" : "重新 QA"}
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <QaStatCard label="严重" value={stats.critical} severity="critical" />
            <QaStatCard label="警告" value={stats.warning} severity="warning" />
            <QaStatCard label="通过" value={stats.passed} severity="passed" />
          </div>
          {rerunning ? <QaRerunSkeleton /> : null}
          {qaError ? (
            <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-[12px] border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
              <span className="min-w-0 break-words">{qaError}</span>
              <Button type="button" size="sm" variant="secondary" onClick={rerunQa} title="重试 QA">
                重试
              </Button>
            </div>
          ) : null}
        </div>

        <div className="space-y-2" aria-live={rerunning ? "polite" : undefined}>
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
                    <div className="min-w-0 break-words text-sm font-semibold text-gray-950">{issue.title}</div>
                  </div>
                  <div className="mt-1 break-words text-xs leading-5 text-gray-600">{issue.detail}</div>
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
                <div key={item} className="break-words rounded-lg bg-white/80 px-2.5 py-2 text-xs leading-5 text-sky-900">
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
    <div className={qaStatClass(severity)} title={`${label} ${value}`}>
      <div className="text-base font-semibold">{value}</div>
      <div className="text-[11px]">{label}</div>
    </div>
  );
}

function QaRerunSkeleton() {
  return (
    <div className="mt-3 rounded-[12px] border border-gray-200 bg-white px-3 py-3" aria-label="QA 重新扫描中">
      <div className="h-3 w-24 animate-pulse rounded-full bg-gray-200" />
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="h-10 animate-pulse rounded-[10px] bg-gray-100" />
        <div className="h-10 animate-pulse rounded-[10px] bg-gray-100" />
        <div className="h-10 animate-pulse rounded-[10px] bg-gray-100" />
      </div>
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
