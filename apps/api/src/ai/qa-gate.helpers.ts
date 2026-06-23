import type { QAGateAction, QAGateDecision, QAIssue, QAReportStatus } from "./ai-vibe.types";

export type QAGateReportRecord = {
  id: string;
  status: QAReportStatus;
  blockingCount: number;
  majorCount: number;
  minorCount: number;
  infoCount: number;
  issues: QAIssue[];
};

export function evaluateQaGate(report: QAGateReportRecord | null | undefined): QAGateDecision {
  if (!report) return missingQaGate();

  const blockingIssues = report.issues.filter((issue) => issue.severity === "blocking");
  const majorIssues = report.issues.filter((issue) => issue.severity === "major");
  const minorIssues = report.issues.filter((issue) => issue.severity === "minor");
  const infoIssues = report.issues.filter((issue) => issue.severity === "info");

  if (report.status === "failed" || report.blockingCount > 0 || report.majorCount > 0) {
    return {
      status: "blocked",
      allowConfirmArtifacts: false,
      allowPersistKnowledge: false,
      allowExportOrPublish: false,
      shouldReturnToPatch: true,
      reportId: report.id,
      reportStatus: report.status,
      blockingReasons: [
        ...blockingIssues.map((issue) => `阻塞：${issue.title}`),
        ...majorIssues.map((issue) => `重要：${issue.title}`),
      ].slice(0, 8),
      warnings: [
        ...minorIssues.map((issue) => `轻微：${issue.title}`),
        ...infoIssues.map((issue) => `提示：${issue.title}`),
      ].slice(0, 8),
      requiredActions: ["return_to_patch", "run_qa"],
      evaluatedAt: new Date().toISOString(),
    };
  }

  if (report.status === "warning" || report.minorCount > 0 || report.infoCount > 0) {
    const hasOnlyInfo = report.minorCount === 0 && report.infoCount > 0;
    return {
      status: "warning",
      allowConfirmArtifacts: true,
      allowPersistKnowledge: hasOnlyInfo,
      allowExportOrPublish: hasOnlyInfo,
      shouldReturnToPatch: false,
      reportId: report.id,
      reportStatus: report.status,
      blockingReasons: [],
      warnings: [
        ...minorIssues.map((issue) => `轻微：${issue.title}`),
        ...infoIssues.map((issue) => `提示：${issue.title}`),
      ].slice(0, 8),
      requiredActions: hasOnlyInfo ? [] : ["run_qa"],
      evaluatedAt: new Date().toISOString(),
    };
  }

  return {
    status: "open",
    allowConfirmArtifacts: true,
    allowPersistKnowledge: true,
    allowExportOrPublish: true,
    shouldReturnToPatch: false,
    reportId: report.id,
    reportStatus: report.status,
    blockingReasons: [],
    warnings: [],
    requiredActions: [],
    evaluatedAt: new Date().toISOString(),
  };
}

export function isQaGateActionAllowed(gate: QAGateDecision, action: QAGateAction) {
  if (action === "confirm_artifacts") return gate.allowConfirmArtifacts;
  if (action === "persist_knowledge") return gate.allowPersistKnowledge;
  if (action === "export_or_publish") return gate.allowExportOrPublish;
  if (action === "return_to_patch") return gate.shouldReturnToPatch;
  return gate.status !== "blocked";
}

function missingQaGate(): QAGateDecision {
  return {
    status: "blocked",
    allowConfirmArtifacts: false,
    allowPersistKnowledge: false,
    allowExportOrPublish: false,
    shouldReturnToPatch: false,
    blockingReasons: ["尚未完成 QA，不能确认产物、沉淀知识或导出发布。"],
    warnings: [],
    requiredActions: ["run_qa"],
    evaluatedAt: new Date().toISOString(),
  };
}
