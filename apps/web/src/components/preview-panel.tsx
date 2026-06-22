"use client";

import { useEffect, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from "react";
import {
  Activity,
  Building2,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Crop,
  FileText,
  GitBranch,
  Loader2,
  MousePointer2,
  PencilLine,
  Scale,
  ShieldAlert,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { Badge, Button, EmptyState, IconButton, SegmentedControl } from "@/components/ui";

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

type PreviewMode = "prototype" | "prd";
type PrototypeCanvasMode = "browse" | "select";
type PrototypeLocalAction = "copy_generate" | "visual_refine" | "layout_adjust" | "interaction_fill";

type CanvasRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PrototypeCanvasSelection = CanvasRect & {
  id: string;
  kind: "point" | "box";
  label: string;
  createdAt: number;
};

type PrototypeLocalGeneration = {
  title: string;
  changes: string[];
};

const LOCAL_ACTIONS: Array<{ id: PrototypeLocalAction; label: string; icon: typeof Sparkles }> = [
  { id: "copy_generate", label: "文案生成", icon: PencilLine },
  { id: "visual_refine", label: "视觉优化", icon: Wand2 },
  { id: "layout_adjust", label: "布局调整", icon: Crop },
  { id: "interaction_fill", label: "交互补齐", icon: MousePointer2 },
];

const STRATEGY_LABELS: Record<Phase2Strategy["name"], string> = {
  conservative_fix: "保守修正",
  ux_improve: "体验优化",
  structure_rewrite: "结构重写",
  full_regenerate: "完整重建",
  conservative: "保守策略",
  balanced: "平衡策略",
  aggressive: "进取策略",
  full_rewrite: "完整重写",
};

const RULE_LABELS: Record<Constraint["rule"], string> = {
  must_follow: "必须遵守",
  prefer: "优先考虑",
  avoid: "避免",
  warn: "提醒",
};

const SCOPE_LABELS: Record<Constraint["scope"], string> = {
  agent: "智能体",
  decision: "决策",
  patch: "补丁",
  qa: "质检",
};

const IMPACT_LABELS: Record<Phase2Strategy["impact"], string> = {
  low: "低影响",
  medium: "中影响",
  high: "高影响",
};

const OUTCOME_LABELS: Record<Phase2DecisionView["evolution"]["finalOutcome"], string> = {
  success: "成功",
  failure: "失败",
  partial: "部分成功",
};

const DOMAIN_LABELS: Record<"prd" | "prototype" | "state", string> = {
  prd: "需求文档",
  prototype: "原型",
  state: "产品状态",
};

const OPERATION_LABELS: Record<PatchOperation["op"], string> = {
  add: "新增",
  update: "更新",
  delete: "删除",
  replace: "替换",
};

const MUTATION_LABELS: Record<SystemMutation["type"], string> = {
  add_agent: "新增智能体",
  remove_agent: "移除智能体",
  modify_agent: "修改智能体",
  modify_pipeline: "修改流程",
  add_step: "新增步骤",
  remove_step: "移除步骤",
};

export function PreviewPanel({
  prdPreview,
  prototypePreview,
}: {
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
}) {
  const [mode, setMode] = useState<PreviewMode>("prototype");

  useEffect(() => {
    if (prototypePreview?.html) {
      setMode("prototype");
      return;
    }
    if (prdPreview) {
      setMode("prd");
    }
  }, [prdPreview?.id, prototypePreview?.id, prototypePreview?.html]);

  return (
    <aside className="flex min-h-0 min-w-0 flex-col bg-[var(--color-panel-bg)]">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-950">结果预览</div>
          <div className="truncate text-xs text-gray-500">需求文档与网页原型</div>
        </div>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          ariaLabel="结果预览切换"
          options={[
            { value: "prd", label: "需求" },
            { value: "prototype", label: "预览" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "prd" ? (
          <div className="workbench-scrollbar h-full overflow-y-auto p-2.5">
            <PrdPreviewView prdPreview={prdPreview} />
          </div>
        ) : (
          <PrototypePreviewView prototypePreview={prototypePreview} />
        )}
      </div>
    </aside>
  );
}

function ResultSection({
  title,
  description,
  icon: Icon,
  ready,
  children,
}: {
  title: string;
  description: string;
  icon: typeof FileText;
  ready: boolean;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-gray-200 bg-gray-50 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white text-gray-700 shadow-[var(--shadow-control)]">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-950">{title}</div>
            <div className="mt-0.5 text-xs leading-5 text-gray-500">{description}</div>
          </div>
        </div>
        <Badge tone={ready ? "success" : "neutral"} className={!ready ? "bg-white" : undefined}>
          {ready ? "已生成" : "等待输入"}
        </Badge>
      </div>
      {children}
    </section>
  );
}

function PrdPreviewView({ prdPreview }: { prdPreview?: Phase1PrdPreview | null }) {
  if (!prdPreview) {
    return (
      <EmptyPreview
        title="暂无需求文档"
        description="发送需求后，系统会在完成约束、决策、进化流程后生成一份可预览需求文档。"
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[14px] border border-gray-200 bg-white px-4 py-3 shadow-[var(--shadow-control)]">
        <div className="flex items-center gap-2 text-xs font-semibold text-sky-700">
          <FileText className="h-4 w-4" />
          需求文档
        </div>
        <h2 className="mt-2 text-lg font-semibold leading-tight text-gray-950">{toChineseText(prdPreview.title)}</h2>
        <div className="mt-1 text-xs text-gray-500">{prdPreview.sections.length} 个章节</div>
      </div>
      {prdPreview.sections.map((section, index) => (
        <section key={`${section.title}-${index}`} className="rounded-[14px] border border-gray-200 bg-white px-4 py-3 shadow-[var(--shadow-control)]">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gray-950 text-xs font-semibold text-white">
              {index + 1}
            </span>
            <h3 className="text-sm font-semibold text-gray-950">{toChineseText(section.title)}</h3>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-gray-600">{toChineseText(section.content)}</p>
        </section>
      ))}
    </div>
  );
}

function PrototypePreviewView({ prototypePreview }: { prototypePreview?: Phase1PrototypePreview | null }) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasMode, setCanvasMode] = useState<PrototypeCanvasMode>("select");
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draftBox, setDraftBox] = useState<CanvasRect | null>(null);
  const [selection, setSelection] = useState<PrototypeCanvasSelection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [localAction, setLocalAction] = useState<PrototypeLocalAction>("copy_generate");
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generation, setGeneration] = useState<PrototypeLocalGeneration | null>(null);

  useEffect(() => {
    setCanvasMode("select");
    setDragStart(null);
    setDraftBox(null);
    setSelection(null);
    setDialogOpen(false);
    setLocalAction("copy_generate");
    setInstruction("");
    setGenerating(false);
    setGeneration(null);
  }, [prototypePreview?.id, prototypePreview?.html]);

  if (!prototypePreview?.html) {
    return (
      <div className="h-full p-4">
        <EmptyPreview
          title="暂无原型"
          description="发送需求后，系统会生成一份网页原型，并在这里直接预览。"
        />
      </div>
    );
  }

  const activeBox = draftBox ?? selection;

  const startSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (canvasMode !== "select" || !canvasRef.current) return;
    const point = getCanvasPoint(event, canvasRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(point);
    setDraftBox({ ...point, width: 0, height: 0 });
    setSelection(null);
    setGeneration(null);
  };

  const updateSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (canvasMode !== "select" || !dragStart || !canvasRef.current) return;
    const point = getCanvasPoint(event, canvasRef.current);
    setDraftBox(rectFromPoints(dragStart, point));
  };

  const finishSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (canvasMode !== "select" || !dragStart || !canvasRef.current) return;
    const point = getCanvasPoint(event, canvasRef.current);
    const canvasBounds = canvasRef.current.getBoundingClientRect();
    const rawRect = rectFromPoints(dragStart, point);
    const isBox = rawRect.width >= 18 && rawRect.height >= 18;
    const nextRect = isBox ? rawRect : pointSelectionRect(point, canvasBounds.width, canvasBounds.height);
    const nextSelection: PrototypeCanvasSelection = {
      ...nextRect,
      id: `prototype-selection-${Date.now()}`,
      kind: isBox ? "box" : "point",
      label: selectionLabel(nextRect, isBox ? "box" : "point"),
      createdAt: Date.now(),
    };

    setSelection(nextSelection);
    setDraftBox(null);
    setDragStart(null);
    setDialogOpen(true);
    setInstruction("");
    setLocalAction("copy_generate");
  };

  const cancelSelectionDrag = () => {
    setDragStart(null);
    setDraftBox(null);
  };

  const clearSelection = () => {
    setSelection(null);
    setDialogOpen(false);
    setInstruction("");
    setGeneration(null);
  };

  const generateLocalDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selection || !instruction.trim()) return;
    setGenerating(true);
    setGeneration(null);

    await new Promise((resolve) => window.setTimeout(resolve, 480));
    setGeneration(buildLocalGeneration(selection, localAction, instruction));
    setGenerating(false);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--color-accent-soft)]">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-blue-100 bg-white/80 px-3 backdrop-blur">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-950">{toChineseText(prototypePreview.title)}</div>
          <div className="truncate text-xs text-gray-500">
            {selection ? selection.label : canvasMode === "select" ? "画布选择" : "网页原型预览"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SegmentedControl
            value={canvasMode}
            onChange={setCanvasMode}
            ariaLabel="原型画布模式"
            className="bg-blue-50"
            options={[
              { value: "browse", label: "浏览", icon: <MousePointer2 className="h-3.5 w-3.5" /> },
              { value: "select", label: "选择", icon: <Crop className="h-3.5 w-3.5" /> },
            ]}
          />
          <Badge tone="accent" className="bg-white">已生成</Badge>
        </div>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <div className="h-full overflow-hidden rounded-[var(--radius-control)] border border-blue-100 bg-white shadow-[var(--shadow-panel)]">
          <div className="flex h-9 items-center gap-2 border-b border-blue-100 bg-gray-50 px-3">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span className="ml-2 truncate text-xs text-gray-500">{prototypePreview.entryFilePath ?? "index.html"}</span>
            {generation ? (
              <Badge tone="success" className="ml-auto gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                局部草稿
              </Badge>
            ) : null}
          </div>
          <div ref={canvasRef} className="relative h-[calc(100%-36px)] min-h-[600px] bg-white">
            <iframe
              title="原型预览"
              srcDoc={prototypePreview.html}
              sandbox="allow-scripts"
              className={[
                "h-full min-h-[600px] w-full border-0 bg-white",
                canvasMode === "select" ? "pointer-events-none select-none" : "",
              ].join(" ")}
            />

            {canvasMode === "select" ? (
              <div
                className="absolute inset-0 z-10 cursor-crosshair bg-blue-500/0"
                onPointerDown={startSelection}
                onPointerMove={updateSelection}
                onPointerUp={finishSelection}
                onPointerCancel={cancelSelectionDrag}
                onPointerLeave={cancelSelectionDrag}
              >
                {activeBox ? <PrototypeSelectionBox box={activeBox} selected={Boolean(selection && !draftBox)} /> : null}

                {selection && !draftBox ? (
                  <div
                    className="absolute z-20 flex items-center gap-1 rounded-full border border-blue-200 bg-white p-1 shadow-[var(--shadow-float)]"
                    style={{
                      left: clamp(selection.x, 8, Math.max(8, selection.x + selection.width - 156)),
                      top: Math.max(8, selection.y - 44),
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <Button type="button" size="sm" onClick={() => setDialogOpen(true)} className="h-8 rounded-full px-3 text-xs">
                      <Sparkles className="h-3.5 w-3.5" />
                      局部生成
                    </Button>
                    <IconButton label="清除选区" onClick={clearSelection} className="h-8 w-8 rounded-full">
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {dialogOpen && selection ? (
        <PrototypeLocalEditDialog
          selection={selection}
          action={localAction}
          instruction={instruction}
          generating={generating}
          generation={generation}
          onActionChange={(value) => {
            setLocalAction(value);
            setGeneration(null);
          }}
          onInstructionChange={(value) => {
            setInstruction(value);
            setGeneration(null);
          }}
          onClose={() => setDialogOpen(false)}
          onSubmit={generateLocalDraft}
        />
      ) : null}
    </div>
  );
}

function PrototypeSelectionBox({ box, selected }: { box: CanvasRect; selected: boolean }) {
  return (
    <div
      className={[
        "absolute rounded-[10px] border bg-blue-500/10 shadow-[0_0_0_9999px_rgba(15,23,42,0.03)]",
        selected ? "border-blue-600 ring-4 ring-blue-500/15" : "border-blue-500",
      ].join(" ")}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <span className="absolute -left-px -top-7 rounded-md border border-blue-200 bg-white px-2 py-1 text-xs font-semibold text-blue-700 shadow-[var(--shadow-control)]">
        {selectionLabel(box, selected ? "box" : "point")}
      </span>
      {selected ? (
        <>
          <span className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full border border-blue-600 bg-white" />
          <span className="absolute -right-1.5 -top-1.5 h-3 w-3 rounded-full border border-blue-600 bg-white" />
          <span className="absolute -bottom-1.5 -left-1.5 h-3 w-3 rounded-full border border-blue-600 bg-white" />
          <span className="absolute -bottom-1.5 -right-1.5 h-3 w-3 rounded-full border border-blue-600 bg-white" />
        </>
      ) : null}
    </div>
  );
}

function PrototypeLocalEditDialog({
  selection,
  action,
  instruction,
  generating,
  generation,
  onActionChange,
  onInstructionChange,
  onClose,
  onSubmit,
}: {
  selection: PrototypeCanvasSelection;
  action: PrototypeLocalAction;
  instruction: string;
  generating: boolean;
  generation: PrototypeLocalGeneration | null;
  onActionChange: (value: PrototypeLocalAction) => void;
  onInstructionChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="局部生成"
      className="absolute right-3 top-14 z-30 w-[360px] max-w-[calc(100%-24px)] overflow-hidden rounded-[14px] border border-gray-200 bg-white shadow-[var(--shadow-float)]"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
            <Sparkles className="h-4 w-4 text-blue-600" />
            局部生成
          </div>
          <div className="mt-1 truncate text-xs text-gray-500">{selection.label}</div>
        </div>
        <IconButton label="关闭" onClick={onClose} className="h-8 w-8 shrink-0 rounded-full">
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      <form onSubmit={onSubmit} className="space-y-2.5 px-3 py-2.5">
        <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="局部生成动作">
          {LOCAL_ACTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onActionChange(item.id)}
                className={[
                  "flex h-9 items-center justify-center gap-1.5 rounded-[10px] border px-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
                  action === item.id
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-950",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>

        <textarea
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          placeholder="描述这个局部区域要生成或调整的内容"
          rows={4}
          className="block max-h-[140px] min-h-[96px] w-full resize-none rounded-[12px] border border-gray-200 bg-gray-50 px-3 py-2 text-sm leading-6 text-gray-900 shadow-none outline-none transition placeholder:text-gray-400 focus:border-gray-950 focus:bg-white focus:ring-3 focus:ring-gray-950/10"
        />

        <div className="rounded-[12px] border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
          当前输出会作为局部补丁草稿保留，不覆盖完整原型。
        </div>

        {generation ? (
          <div className="rounded-[12px] border border-emerald-200 bg-emerald-50 px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="h-4 w-4" />
              {generation.title}
            </div>
            <div className="mt-2 space-y-1.5">
              {generation.changes.map((change) => (
                <div key={change} className="rounded-lg bg-white/80 px-2 py-1.5 text-xs leading-5 text-emerald-900">
                  {change}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>
            收起
          </Button>
          <Button type="submit" size="sm" disabled={!instruction.trim() || generating}>
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? "生成中" : "生成局部草稿"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function getCanvasPoint(event: PointerEvent<HTMLDivElement>, element: HTMLDivElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp(event.clientX - rect.left, 0, rect.width),
    y: clamp(event.clientY - rect.top, 0, rect.height),
  };
}

function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): CanvasRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function pointSelectionRect(point: { x: number; y: number }, canvasWidth: number, canvasHeight: number): CanvasRect {
  const width = Math.min(240, Math.max(144, canvasWidth * 0.24));
  const height = Math.min(156, Math.max(96, canvasHeight * 0.18));
  return {
    x: clamp(point.x - width / 2, 8, Math.max(8, canvasWidth - width - 8)),
    y: clamp(point.y - height / 2, 8, Math.max(8, canvasHeight - height - 8)),
    width,
    height,
  };
}

function selectionLabel(box: CanvasRect, kind: "point" | "box") {
  const prefix = kind === "point" ? "点击选区" : "框选区域";
  return `${prefix} ${Math.round(box.width)}×${Math.round(box.height)}`;
}

function buildLocalGeneration(
  selection: PrototypeCanvasSelection,
  action: PrototypeLocalAction,
  instruction: string,
): PrototypeLocalGeneration {
  const actionLabel = localActionLabel(action);
  const cleanInstruction = instruction.trim();
  return {
    title: `${actionLabel}草稿已生成`,
    changes: localDraftChanges(selection, action, cleanInstruction),
  };
}

function localActionLabel(action: PrototypeLocalAction) {
  return LOCAL_ACTIONS.find((item) => item.id === action)?.label ?? "局部生成";
}

function localDraftChanges(
  selection: PrototypeCanvasSelection,
  action: PrototypeLocalAction,
  instruction: string,
) {
  const scope = `作用范围：${selection.label}`;
  const guard = "应用方式：生成局部补丁候选，不替换完整 HTML。";
  if (action === "copy_generate") {
    return [
      scope,
      `主文案：围绕「${instruction}」生成更明确的标题与一句核心说明。`,
      "按钮文案：补充 1 个主行动和 1 个次级行动，保持当前布局不变。",
      guard,
    ];
  }
  if (action === "visual_refine") {
    return [
      scope,
      `视觉层级：针对「${instruction}」强化选区内的标题、说明与按钮优先级。`,
      "样式策略：只调整局部间距、对比度、边框与阴影，不触碰页面外层结构。",
      guard,
    ];
  }
  if (action === "layout_adjust") {
    return [
      scope,
      `布局草案：根据「${instruction}」重排选区内部信息块。`,
      "约束：保留选区外的导航、页面容器和其它模块位置。",
      guard,
    ];
  }
  return [
    scope,
    `交互补齐：为「${instruction}」补充局部状态、反馈和异常提示。`,
    "状态范围：只影响选区内控件的 hover、loading、empty 或 error 表达。",
    guard,
  ];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function EmptyPreview({ title, description }: { title: string; description: string }) {
  return (
    <EmptyState title={title} description={description} icon={<FileText className="h-5 w-5" />} />
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 px-1 py-1">
      <div className="font-semibold text-gray-950">{value}</div>
      <div className="text-gray-500">{label}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-sky-200 bg-white px-2 py-2">
      <div className="font-semibold text-gray-950">{value}</div>
      <div className="text-gray-500">{label}</div>
    </div>
  );
}

function PlanMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "low" | "medium" | "high";
}) {
  return (
    <div className="rounded-md border border-indigo-200 bg-white px-2 py-2">
      <div className="text-gray-500">{label}</div>
      <div className={tone ? riskTextClass(tone) : "mt-1 font-semibold text-gray-950"}>{value}</div>
    </div>
  );
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function compactNumber(value: number) {
  return Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function constraintCount(context: ConstraintContext | null) {
  if (!context) return 0;
  return context.mustFollow.length + context.prefer.length + context.avoid.length + context.warn.length;
}

function firstConstraints(context: ConstraintContext | null) {
  if (!context) return [];
  return [
    ...context.mustFollow,
    ...context.prefer,
    ...context.avoid,
    ...context.warn,
  ].slice(0, 4);
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function evolutionCopy(signalType: "promote" | "demote" | "neutral") {
  if (signalType === "promote") return "策略已提升";
  if (signalType === "demote") return "策略已降级";
  return "策略保持中性";
}

function agentLabel(agent: string) {
  const labels: Record<string, string> = {
    productStrategist: "产品策略官",
    uxExpert: "体验专家",
    techArchitect: "技术架构师",
    riskController: "风险控制官",
    growthAnalyst: "增长分析师",
    "Product Strategist": "产品策略官",
    "UX Expert": "体验专家",
    "Tech Architect": "技术架构师",
    "Risk Controller": "风险控制官",
    "Growth Analyst": "增长分析师",
    product: "产品智能体",
    ux: "体验智能体",
    tech: "技术智能体",
    risk: "风险智能体",
    growth: "增长智能体",
  };
  return labels[agent] ?? agent;
}

function departmentLabel(type: DepartmentType) {
  const labels: Record<DepartmentType, string> = {
    ceo: "首席决策",
    product: "产品",
    engineering: "工程",
    design: "设计",
    qa: "质检",
    growth: "增长",
    evolution: "进化",
  };
  return labels[type] ?? type;
}

function riskLabel(risk?: string) {
  if (risk === "high") return "高";
  if (risk === "medium") return "中";
  return "低";
}

function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    ready: "已生成",
    preview: "待预览",
    applied: "已应用",
    already_applied: "已应用",
    blocked: "已阻止",
    completed: "已完成",
    pending: "待处理",
    running: "运行中",
    failed: "失败",
  };
  return status ? labels[status] ?? status : "未知";
}

function domainLabel(domain: "prd" | "prototype" | "state") {
  return DOMAIN_LABELS[domain];
}

function targetLabel(target: string) {
  const labels: Record<string, string> = {
    pipeline: "系统流程",
    agent_self_generation_observer: "自生成观察智能体",
    system_policy: "系统策略",
    evolution_engine: "进化引擎",
    company_runtime: "公司运行时",
  };
  return labels[target] ?? toChineseText(target.replace(/_/g, " "));
}

function toChineseText(text: string) {
  return text
    .replace(/AI Product Workbench/g, "智能产品工作台")
    .replace(/AI Product Company/g, "智能产品公司")
    .replace(/AI Product OS/g, "智能产品操作系统")
    .replace(/AI Product/g, "智能产品")
    .replace(/Triple System Fusion/g, "三系统融合")
    .replace(/Triple System/g, "三系统融合")
    .replace(/Constraint Context/g, "约束上下文")
    .replace(/Constraint System/g, "约束系统")
    .replace(/Decision System/g, "决策系统")
    .replace(/Evolution System/g, "进化系统")
    .replace(/Decision Engine/g, "决策引擎")
    .replace(/Review Board/g, "评审委员会")
    .replace(/Strategy Selector/g, "策略选择器")
    .replace(/Patch Preview/g, "补丁预览")
    .replace(/System Preview/g, "系统预览")
    .replace(/System Policy/g, "系统策略")
    .replace(/SystemMutation/g, "系统变更")
    .replace(/SystemGraph/g, "系统图")
    .replace(/ProductDesignState/g, "产品设计状态")
    .replace(/Product Department/g, "产品部门")
    .replace(/Engineering Department/g, "工程部门")
    .replace(/Design Department/g, "设计部门")
    .replace(/QA Department/g, "质检部门")
    .replace(/Growth Department/g, "增长部门")
    .replace(/Evolution Department/g, "进化部门")
    .replace(/CEO Agent/g, "首席决策智能体")
    .replace(/Product Department Agent/g, "产品部门智能体")
    .replace(/Engineering Department Agent/g, "工程部门智能体")
    .replace(/Design Department Agent/g, "设计部门智能体")
    .replace(/QA Department Agent/g, "质检部门智能体")
    .replace(/Growth Department Agent/g, "增长部门智能体")
    .replace(/Evolution Department Agent/g, "进化部门智能体")
    .replace(/Self-Generation Observer/g, "自生成观察智能体")
    .replace(/Flow Optimization Agent/g, "流程优化智能体")
    .replace(/Generate multiple strategies and select one by weighted score\./g, "生成多个策略，并按加权得分选择最优策略。")
    .replace(/Route through 补丁预览 before apply\./g, "执行前必须进入补丁预览。")
    .replace(/Avoid direct database mutation and protected module edits\./g, "避免直接修改数据库和受保护模块。")
    .replace(/Prefer lower-risk strategies when business value is similar\./g, "业务价值接近时优先选择低风险策略。")
    .replace(/QA passed and user satisfaction was strong\./g, "质检通过，用户满意度较高。")
    .replace(/QA failed; strategy should be less preferred until constraints or implementation improve\./g, "质检失败；在约束或实现改善前降低该策略优先级。")
    .replace(/Outcome was partial; policy receives a small adjustment\./g, "结果为部分成功，系统策略进行小幅调整。")
    .replace(/Build approved product initiatives through department-owned execution\./g, "通过部门负责制交付已批准的产品计划。")
    .replace(/No critical bottleneck detected\./g, "未发现关键瓶颈。")
    .replace(/Graph observability can be improved\./g, "系统图可观测性仍可提升。")
    .replace(/Register a low-risk self-generation observer node\./g, "注册低风险自生成观察节点。")
    .replace(/Pipeline/g, "流程")
    .replace(/Agent/g, "智能体")
    .replace(/Strategy/g, "策略")
    .replace(/Outcome/g, "结果")
    .replace(/Company/g, "公司")
    .replace(/Dashboard/g, "看板")
    .replace(/Runtime/g, "运行时")
    .replace(/Product/g, "产品");
}

function riskClass(risk: "low" | "medium" | "high") {
  const base = "rounded-md border px-2 py-0.5 text-xs";
  if (risk === "high") return `${base} border-red-300 bg-red-50 text-red-700`;
  if (risk === "medium") return `${base} border-amber-300 bg-amber-50 text-amber-700`;
  return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`;
}

function riskTextClass(risk: "low" | "medium" | "high") {
  if (risk === "high") return "font-semibold text-red-600";
  if (risk === "medium") return "font-semibold text-amber-700";
  return "font-semibold text-emerald-700";
}
