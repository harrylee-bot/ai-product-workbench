export type PatchOperation = {
  op: "add" | "update" | "delete" | "replace";
  path: string;
  value?: unknown;
};

export type PatchTargetDomain = "prd" | "prototype" | "state";

export type Constraint = {
  id: string;
  rule: "must_follow" | "prefer" | "avoid" | "warn";
  scope: "runtime" | "state" | "patch" | "qa";
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

export type RuntimePatchPreview = {
  patchDraft?: {
    id?: string;
    operations: PatchOperation[];
    targetDomains?: PatchTargetDomain[];
    rationale?: string;
  };
  previewSession?: {
    id?: string;
    patchRecordId?: string;
    status?: string;
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
    operations?: PatchOperation[];
    targetDomains?: PatchTargetDomain[];
    message?: string;
  };
  qaReport?: {
    id?: string;
    issues?: string[];
    riskLevel?: "low" | "medium" | "high";
    recommendations?: string[];
    passed?: boolean;
    createdAt?: string;
  };
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
  runtimeSummary?: {
    status?: string;
    outcome?: "success" | "failure" | "partial";
    createdAt?: string;
    message?: string;
  };
};

export type Phase1PrdPreview = {
  id?: string;
  title: string;
  sections: Array<{
    id: string;
    title: string;
    content: string;
    type?: string;
    level?: 1 | 2 | 3;
    order?: number;
    sourcePaths?: string[];
    sourceStatePaths?: string[];
    tags?: string[];
    blocks?: Array<{
      id: string;
      type: "paragraph" | "bullet_list" | "table" | "quote" | "warning" | "info";
      content: string;
      sourcePaths?: string[];
      tags?: string[];
    }>;
  }>;
};

export type Phase1PrototypePreview = {
  id?: string;
  title: string;
  html: string;
  entryFilePath?: string;
};

export type JsonCanvasNode = {
  id: string;
  type: "text" | "group" | "file" | "link";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  label?: string;
  color?: string;
};

export type JsonCanvasEdge = {
  id: string;
  fromNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toNode: string;
  toSide?: "top" | "right" | "bottom" | "left";
  toEnd?: "none" | "arrow";
  label?: string;
  color?: string;
};

export type DocumentCanvasPreview = {
  documentId: string;
  projectId: string;
  title: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  canvas: {
    nodes: JsonCanvasNode[];
    edges: JsonCanvasEdge[];
  };
  stats: {
    sectionCount: number;
    blockCount: number;
    nodeCount: number;
    edgeCount: number;
  };
  generatedAt: string;
};

export type PreviewMode = "prd" | "canvas" | "prototype" | "qa" | "state" | "feedback";
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
  componentId?: string;
  pageId?: string;
  componentName?: string;
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
