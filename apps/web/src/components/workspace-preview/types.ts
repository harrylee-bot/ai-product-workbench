export type PatchOperation = {
  op: "add" | "update" | "delete" | "replace";
  path: string;
  value?: unknown;
};

export type Phase2Strategy = {
  id: string;
  name:
    | "conservative_fix"
    | "ux_improve"
    | "structure_rewrite"
    | "full_regenerate"
    | "conservative"
    | "balanced"
    | "aggressive"
    | "full_rewrite";
  description: string;
  patchOperations: PatchOperation[];
  impact: "low" | "medium" | "high";
};

export type Phase2AgentReview = {
  agentName: string;
  scores: {
    usability: number;
    feasibility: number;
    risk: number;
    businessValue: number;
  };
  preferredStrategyId: string;
  objections: string[];
};

export type SystemNode = {
  id: string;
  type: "agent" | "orchestrator" | "tool" | "policy" | "compiler";
  name: string;
  config: Record<string, unknown>;
  status: "active" | "inactive" | "experimental";
};

export type SystemEdge = {
  from: string;
  to: string;
  relation: "calls" | "depends_on" | "feeds";
};

export type SystemGraphSnapshot = {
  id?: string;
  version: number;
  nodes: SystemNode[];
  edges: SystemEdge[];
};

export type SystemMutation = {
  id: string;
  type: "add_agent" | "remove_agent" | "modify_agent" | "modify_pipeline" | "add_step" | "remove_step";
  target: string;
  payload: unknown;
  reason: string;
  riskLevel: "low" | "medium" | "high";
};

export type SystemChangeProposalView = {
  id: string;
  status: string;
  mutations: SystemMutation[];
  impactAnalysis: string[];
  riskLevel: "low" | "medium" | "high";
  previewGraph: SystemGraphSnapshot;
  createdAt: string;
  sourceTraceId?: string | null;
};

export type SelfGenerationView = {
  insight: {
    bottleneck: string;
    weakness: string;
    opportunity: string;
  };
  proposal: SystemChangeProposalView;
  applied: {
    status: string;
    graph?: SystemGraphSnapshot;
    mutations?: SystemMutation[];
  } | null;
  executionPlan: SystemGraphSnapshot;
};

export type Constraint = {
  id: string;
  rule: "must_follow" | "prefer" | "avoid" | "warn";
  scope: "agent" | "decision" | "patch" | "qa";
  condition: string;
  effect: string;
  weight: number;
  sourceKnowledgeId: string;
};

export type ConstraintContext = {
  mustFollow: Constraint[];
  prefer: Constraint[];
  avoid: Constraint[];
  warn: Constraint[];
};

export type DepartmentType =
  | "ceo"
  | "product"
  | "engineering"
  | "design"
  | "qa"
  | "growth"
  | "evolution";

export type CompanyRuntimeView = {
  company: {
    id: string;
    name: string;
    budget: number;
    strategy: string;
    departments: Array<{
      id: string;
      type: DepartmentType;
      budgetAllocation: number;
      agents: Array<{
        id: string;
        name: string;
        role: string;
        departmentId: string;
        capabilities: string[];
      }>;
    }>;
  };
  ceoPlan: {
    approved: boolean;
    budgetAllocation: Record<DepartmentType, number>;
    priority: string[];
  };
  productInitiative: {
    id: string;
    name: string;
    goal: string;
    features: string[];
    ceoApproved: boolean;
    priority: string;
    allocatedBudget: number;
  };
  engineeringPlan: {
    id?: string;
    modules: string[];
    apis: string[];
    systemChanges: SystemMutation[];
  };
  designPlan: {
    id?: string;
    layouts: string[];
    uxFlows: string[];
  };
  qaReport: {
    id?: string;
    issues: string[];
    riskLevel: "low" | "medium" | "high";
    recommendations: string[];
  };
  growthPlan: {
    id?: string;
    optimizations: string[];
    experiments: string[];
  };
  evolutionPlan: {
    id?: string;
    structuralChanges: SystemMutation[];
    agentChanges: Array<{
      op: "add" | "move" | "update" | "disable";
      departmentType: DepartmentType;
      reason: string;
    }>;
  };
  runtimeRun: {
    id: string;
    status: string;
    createdAt: string;
  };
};

export type Phase2DecisionView = {
  decisionPlan: {
    strategies: Phase2Strategy[];
    selectedStrategyId?: string;
    reasoning?: string[];
    scores?: Record<
      string,
      {
        usability: number;
        feasibility: number;
        risk: number;
        businessValue: number;
        weightedScore: number;
        constraintPenalty: number;
      }
    >;
    constraintContext?: ConstraintContext;
  };
  reviewBoard: {
    reviews: Phase2AgentReview[];
    finalDecision: {
      selectedStrategyId: string;
      confidence: number;
    };
  };
  selection: {
    selectedStrategyId: string;
    reason: string;
  };
  selectedStrategy: Phase2Strategy;
  patchDraft: {
    id: string;
    strategyId: string;
    operations: PatchOperation[];
    targetDomains: Array<"prd" | "prototype" | "state">;
  };
  previewSession: {
    id: string;
    patchRecordId: string;
    status: string;
    diff?: {
      summary?: string;
      operations?: PatchOperation[];
      beforeVersion?: number;
      afterPreviewOnly?: boolean;
    };
    riskPanel?: {
      level?: string;
      requiresConfirmation?: boolean;
      versionedApply?: boolean;
      checks?: Record<string, boolean>;
    };
    operations: PatchOperation[];
    targetDomains: Array<"prd" | "prototype" | "state">;
    message: string;
  };
  evolution: {
    traceId: string;
    finalOutcome: "success" | "failure" | "partial";
    metrics: {
      qaPassed: boolean;
      userFeedbackScore: number;
      executionTime: number;
    };
    signal: {
      strategyId: string;
      signalType: "promote" | "demote" | "neutral";
      weightDelta: number;
      reason: string;
    };
    policyVersion: number;
    strategyDelta: number;
    agentDeltas: Record<string, number>;
    policy: {
      strategyWeights: Record<string, number>;
      agentWeights: Record<string, number>;
      decisionBias: {
        riskAversion: number;
        innovationBias: number;
      };
    };
    createdAt: string;
  };
  selfGeneration?: SelfGenerationView;
  executionPlan?: SystemGraphSnapshot;
  companyRuntime?: CompanyRuntimeView;
  knowledgeSearch?: {
    summary: string;
    results: Array<{
      itemId?: string;
      title: string;
      type: string;
      score: number;
      reason: string;
    }>;
    references: Array<{
      id: string;
      knowledgeId?: string;
      title: string;
      snippet?: string;
      content?: string;
      type?: string;
    }>;
  };
  constraintContext?: ConstraintContext;
  agentInput?: {
    userInput: string;
    constraintContext: ConstraintContext;
    decisionContext: Phase2DecisionView["decisionPlan"];
    knowledgeReferences?: NonNullable<Phase2DecisionView["knowledgeSearch"]>["references"];
    knowledgeSummary?: string;
  };
};

export type Phase1PrdPreview = {
  id?: string;
  title: string;
  sections: Array<{
    title: string;
    content: string;
  }>;
};

export type Phase1PrototypePreview = {
  id?: string;
  title: string;
  html: string;
  entryFilePath?: string;
};

export type PreviewMode = "prd" | "prototype" | "qa" | "state" | "feedback";
export type PrototypeCanvasMode = "browse" | "select";
export type PrototypeLocalAction = "copy_generate" | "visual_refine" | "layout_adjust" | "interaction_fill";
export type QaSeverity = "critical" | "warning" | "passed";
export type WorkflowStepStatus = "done" | "active" | "pending";

export type CanvasRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PrototypeCanvasSelection = CanvasRect & {
  id: string;
  kind: "point" | "box";
  label: string;
  createdAt: number;
};

export type PrototypeLocalGeneration = {
  title: string;
  changes: string[];
};

export type PrototypeComponentNode = {
  id: string;
  name: string;
  type: string;
  detail: string;
  depth: number;
};

export type QaIssue = {
  id: string;
  title: string;
  detail: string;
  severity: QaSeverity;
  source: string;
};

export type FeedbackWorkflowStep = {
  id: string;
  title: string;
  detail: string;
  status: WorkflowStepStatus;
};
