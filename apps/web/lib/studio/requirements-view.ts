// UI presentation models only. These are not HTTP contracts or persisted data.
// A backend-contract adapter supplies permissions, readiness and fixed identities.
export type RequirementFactView = {
  id: string;
  text: string;
  origin: "user" | "knowledge" | "suggestion" | "analysis";
  evidenceIds: readonly string[];
};
export type RequirementEvidenceView = {
  id: string;
  title: string;
  location: string;
  quote: string;
  release: string;
  version: number;
  scope: "platform" | "template" | "regional" | "prototype" | "uncertain";
};
export type RequirementQuestionView = {
  id: string;
  question: string;
  reason: string;
  blocking: boolean;
  evidenceIds: readonly string[];
};
export type RequirementReviewView = {
  id: string;
  version: number;
  goal: string;
  platform?: string;
  roles: readonly string[];
  rolesUnchanged?: boolean;
  modules: readonly string[];
  existing: readonly RequirementFactView[];
  reuse: readonly RequirementFactView[];
  changes: readonly RequirementFactView[];
  pages: readonly string[];
  flows: readonly string[];
  pagesUnaffected?: boolean;
  flowsUnaffected?: boolean;
  preserved: readonly string[];
  assumptions: readonly RequirementFactView[];
  platformChanges: readonly string[];
  target: string;
  design: readonly string[];
  outputKinds: readonly ("prd" | "prototype")[];
};
export type RequirementDiscussionView = {
  scopeKey: string;
  status:
    | "discussing"
    | "analyzing"
    | "needs-clarification"
    | "ready"
    | "generating";
  // Retain the exact input target in the UI: fixed revision/page/node/feedback,
  // artifact operation or draft; never relabel a revision as an unrelated new job.
  contextLabel: string;
  messages: readonly {
    id: string;
    speaker: "user" | "assistant";
    text: string;
    afterConfirmation: boolean;
  }[];
  questions: readonly RequirementQuestionView[];
  review?: RequirementReviewView;
  evidence: readonly RequirementEvidenceView[];
  knowledgeStatus:
    | "available"
    | "missing"
    | "conflict"
    | "restricted"
    | "unavailable"
    | "source-changed"
    | "source-unreadable"
    | "source-too-large"
    | "searching"
    | "not-provided";
  // Authoritative result of server readiness + latest input/summary binding.
  canConfirm: boolean;
  reviewCurrent: boolean;
  confirmationPending: boolean;
  generationStarting?: boolean;
  generationOutcome?: "succeeded" | "failed" | "cancelled";
  generationIssue?: string;
  hasEarlierMessages: boolean;
  currentGeneration?: { label: string; baseline: string };
};

export function requirementConfirmationBlock(
  view: RequirementDiscussionView,
  options: { canEdit: boolean; dirtyInput: boolean },
): string | undefined {
  if (!options.canEdit) return "当前权限只能查看需求讨论。";
  if (view.confirmationPending)
    return "上次确认的结果尚未核实，请先恢复确认结果。";
  if (view.generationStarting)
    return view.generationIssue
      ? "已确认的生成暂未启动，请恢复同一份任务。"
      : "需求已确认，正在等待生成启动。";
  if (view.status === "generating")
    return "本次生成已开始；追加需求会保留到后续讨论。";
  if (view.status === "analyzing")
    return "正在整理最新需求，请等待新的改动摘要。";
  if (options.dirtyInput)
    return "输入或上下文已有调整，请先发送并审阅更新后的改动摘要。";
  if (!view.review || !view.reviewCurrent)
    return "请先完成需求交流并审阅最新改动摘要。";
  if (view.questions.some((question) => question.blocking))
    return "仍有会影响范围或关键规则的问题需要确认。";
  if (view.knowledgeStatus === "searching") return "正在核对平台能力依据。";
  if (!view.canConfirm || view.status !== "ready")
    return "当前需求尚未达到可确认状态，请继续补充或解决提示的问题。";
  return undefined;
}
