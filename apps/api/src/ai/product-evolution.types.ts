export type InteractionEventType = "patch" | "comment" | "selection" | "feedback";
export type InteractionTargetType = "prd" | "prototype" | "state";
export type InsightIssueType = "ux" | "logic" | "flow" | "content";
export type InsightSeverity = "low" | "medium" | "high";
export type EvolutionPriority = "low" | "medium" | "high";
export type EvolutionPatchOperationType = "add" | "update" | "delete";

export type ProductInteractionEventItem = {
  id: string;
  projectId: string;
  type: InteractionEventType;
  targetType: InteractionTargetType;
  targetId?: string;
  content?: string;
  metadata?: unknown;
  createdBy: string;
  createdAt: string;
};

export type ProductInsightItem = {
  id: string;
  projectId: string;
  issueType: InsightIssueType;
  severity: InsightSeverity;
  affectedArea: string[];
  rootCause: string;
  suggestion: string;
  sourceEvents: string[];
  generatedBy: string;
  createdAt: string;
};

export type ProductReviewAgentName = "ux" | "business" | "risk" | "clarity" | "growth";

export type ProductReviewAgentOutput = {
  agent: ProductReviewAgentName;
  issues: Array<{
    title: string;
    issueType: InsightIssueType;
    severity: InsightSeverity;
    affectedArea: string[];
    reason: string;
  }>;
  improvements: string[];
  confidence: number;
};

export type ProductReviewReportItem = {
  id: string;
  projectId: string;
  issues: ProductReviewAgentOutput["issues"];
  conflicts: string[];
  improvements: string[];
  consensusScore: number;
  agentOutputs: Record<ProductReviewAgentName, ProductReviewAgentOutput>;
  generatedBy: string;
  createdAt: string;
};

export type EvolutionPatchOperation = {
  type: EvolutionPatchOperationType;
  targetPath: string;
  value?: unknown;
  reason?: string;
};

export type EvolutionPlanItem = {
  id: string;
  projectId: string;
  reason: string;
  priority: EvolutionPriority;
  patchOperations: EvolutionPatchOperation[];
  prdChanges: unknown[];
  prototypeChanges: unknown[];
  impactedAreas: string[];
  sourceInsightIds: string[];
  sourceReviewId?: string;
  generatedBy: string;
  executedAt?: string;
  createdAt: string;
};

export type EvolutionPatchExecutionItem = {
  id: string;
  projectId: string;
  evolutionPlanId: string;
  patchRecordId?: string;
  result: "success" | "failed";
  appliedOperations: EvolutionPatchOperation[];
  newStateVersion?: number;
  rollbackId?: string;
  errorMessage?: string;
  createdBy: string;
  createdAt: string;
};

export type ProductMemoryCategory = "ux" | "flow" | "business" | "risk";

export type ProductMemoryItem = {
  id: string;
  projectId: string;
  version: number;
  category?: ProductMemoryCategory;
  changeReason: string;
  evolutionPlan: unknown;
  patchResult: unknown;
  beforeState: unknown;
  afterState: unknown;
  insights: unknown;
  agentReport: unknown;
  evolutionPlanId?: string;
  patchExecutionId?: string;
  patchRecordId?: string;
  createdBy: string;
  createdAt: string;
};

export type ProductMemoryTimelineItem = {
  id: string;
  projectId: string;
  version: number;
  category?: ProductMemoryCategory;
  title: string;
  description: string;
  evolutionPlanId?: string;
  patchExecutionId?: string;
  patchRecordId?: string;
  createdAt: string;
};

export type OrchestrationRunStatus = "running" | "completed" | "failed";
export type OrchestrationTriggerType = "event" | "batch" | "manual" | "patch";
export type OrchestrationModuleKey =
  | "semanticAnalysis"
  | "multiAgentReview"
  | "evolutionPlanning"
  | "patchExecution"
  | "memorySave";

export type OrchestrationModuleState = {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  errorMessage?: string;
  relatedId?: string;
};

export type OrchestrationRunItem = {
  id: string;
  projectId: string;
  status: OrchestrationRunStatus;
  triggerType: OrchestrationTriggerType;
  moduleStates: Record<OrchestrationModuleKey, OrchestrationModuleState>;
  result: unknown;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};
