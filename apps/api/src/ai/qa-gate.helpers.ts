import type {
  QACheckType,
  QAGateAction,
  QAGateDecision,
  QAIssue,
  QAReportStatus,
} from "./ai-vibe.types";

export type QAGateReportRecord = {
  id: string;
  status: QAReportStatus;
  blockingCount: number;
  majorCount: number;
  minorCount: number;
  infoCount: number;
  issues: QAIssue[];
};

/**
 * 关键维度（结构性一致性）：任一 < 40% 即 blocked（地板线）。
 * 其余维度（knowledge_rule_compliance / assumption_risk）为非关键。
 */
const CRITICAL_DIMENSIONS: ReadonlySet<QACheckType> = new Set<QACheckType>([
  "state_schema",
  "prd_completeness",
  "prototype_completeness",
  "state_prd_consistency",
  "state_prototype_consistency",
  "prd_prototype_consistency",
]);

/** 单维度扣分权重（core-2 评分模型）。 */
const SEVERITY_PENALTY: Record<QAIssue["severity"], number> = {
  blocking: 50,
  major: 25,
  minor: 10,
  info: 2,
};

const PASS_THRESHOLD = 85;
const WARN_THRESHOLD = 60;
const CRITICAL_FLOOR = 40;

type DimensionScore = { checkType: QACheckType; score: number; critical: boolean };

function computeDimensionScores(issues: QAIssue[]): DimensionScore[] {
  const byDimension = new Map<QACheckType, QAIssue[]>();
  for (const issue of issues) {
    const list = byDimension.get(issue.checkType) ?? [];
    list.push(issue);
    byDimension.set(issue.checkType, list);
  }
  const scores: DimensionScore[] = [];
  for (const [checkType, dimIssues] of byDimension) {
    const penalty = dimIssues.reduce((sum, issue) => sum + (SEVERITY_PENALTY[issue.severity] ?? 0), 0);
    const score = Math.max(0, Math.min(100, 100 - penalty));
    scores.push({ checkType, score, critical: CRITICAL_DIMENSIONS.has(checkType) });
  }
  return scores;
}

function overallScore(scores: DimensionScore[], issues: QAIssue[]): number {
  if (!issues.length) return 100;
  if (!scores.length) return 100;
  return Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length);
}

/**
 * 85/60/40 评分门禁（core-2，已定决策）：
 * - overall ≥ 85 且无关键维度 < 40 → open（达标，可确认/导出）
 * - 60 ≤ overall < 85 → warning（强制修订：禁止确认，要求修订后重跑 QA）
 * - overall < 60 或任一关键维度 < 40 → blocked
 * 此前实现是 severity 计数器（任一 major 即 blocked），与决策不符。
 */
export function evaluateQaGate(report: QAGateReportRecord | null | undefined): QAGateDecision {
  if (!report) return missingQaGate();

  const issues = report.issues ?? [];
  const scores = computeDimensionScores(issues);
  const overall = overallScore(scores, issues);
  const criticalFloorBroken = scores.some((item) => item.critical && item.score < CRITICAL_FLOOR);
  const blockingIssues = issues.filter((issue) => issue.severity === "blocking");
  const majorIssues = issues.filter((issue) => issue.severity === "major");
  const minorIssues = issues.filter((issue) => issue.severity === "minor");
  const infoIssues = issues.filter((issue) => issue.severity === "info");

  const evaluatedAt = new Date().toISOString();

  if (overall < WARN_THRESHOLD || criticalFloorBroken) {
    return {
      status: "blocked",
      allowConfirmArtifacts: false,
      allowPersistKnowledge: false,
      allowExportOrPublish: false,
      shouldReviseArtifacts: true,
      reportId: report.id,
      reportStatus: report.status,
      blockingReasons: [
        ...blockingIssues.map((issue) => `阻塞：${issue.title}`),
        ...scores
          .filter((item) => item.critical && item.score < CRITICAL_FLOOR)
          .map((item) => `关键维度 ${item.checkType} 得分 ${item.score} 低于地板线 ${CRITICAL_FLOOR}`),
        ...(overall < WARN_THRESHOLD ? [`总体得分 ${overall} 低于 ${WARN_THRESHOLD}`] : []),
      ].slice(0, 8),
      warnings: [
        ...minorIssues.map((issue) => `轻微：${issue.title}`),
        ...infoIssues.map((issue) => `提示：${issue.title}`),
      ].slice(0, 8),
      requiredActions: ["revise_artifacts", "run_qa"],
      evaluatedAt,
    };
  }

  if (overall < PASS_THRESHOLD) {
    // warning：强制修订（60 ≤ overall < 85）
    return {
      status: "warning",
      allowConfirmArtifacts: false,
      allowPersistKnowledge: false,
      allowExportOrPublish: false,
      shouldReviseArtifacts: true,
      reportId: report.id,
      reportStatus: report.status,
      blockingReasons: [],
      warnings: [
        ...majorIssues.map((issue) => `重要：${issue.title}`),
        ...minorIssues.map((issue) => `轻微：${issue.title}`),
        ...infoIssues.map((issue) => `提示：${issue.title}`),
        `总体得分 ${overall} 未达达标线 ${PASS_THRESHOLD}，需修订后重跑 QA`,
      ].slice(0, 8),
      requiredActions: ["revise_artifacts", "run_qa"],
      evaluatedAt,
    };
  }

  return {
    status: "open",
    allowConfirmArtifacts: true,
    allowPersistKnowledge: true,
    allowExportOrPublish: true,
    shouldReviseArtifacts: false,
    reportId: report.id,
    reportStatus: report.status,
    blockingReasons: [],
    warnings: [],
    requiredActions: [],
    evaluatedAt,
  };
}

export function isQaGateActionAllowed(gate: QAGateDecision, action: QAGateAction) {
  if (action === "confirm_artifacts") return gate.allowConfirmArtifacts;
  if (action === "persist_knowledge") return gate.allowPersistKnowledge;
  if (action === "export_or_publish") return gate.allowExportOrPublish;
  if (action === "revise_artifacts") return gate.shouldReviseArtifacts;
  return gate.status !== "blocked";
}

function missingQaGate(): QAGateDecision {
  return {
    status: "blocked",
    allowConfirmArtifacts: false,
    allowPersistKnowledge: false,
    allowExportOrPublish: false,
    shouldReviseArtifacts: false,
    blockingReasons: ["尚未完成 QA，不能确认产物、沉淀知识或导出发布。"],
    warnings: [],
    requiredActions: ["run_qa"],
    evaluatedAt: new Date().toISOString(),
  };
}
