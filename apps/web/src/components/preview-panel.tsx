"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  Clock3,
  Code2,
  CircleDollarSign,
  Crop,
  FileText,
  GitBranch,
  Layers,
  ListChecks,
  Loader2,
  MessageSquare,
  MousePointer2,
  PencilLine,
  RefreshCw,
  Scale,
  ShieldAlert,
  Sparkles,
  Target,
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

type PreviewMode = "prd" | "prototype" | "qa" | "state" | "feedback";
type PrototypeCanvasMode = "browse" | "select";
type PrototypeLocalAction = "copy_generate" | "visual_refine" | "layout_adjust" | "interaction_fill";
type QaSeverity = "critical" | "warning" | "passed";
type WorkflowStepStatus = "done" | "active" | "pending";

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

type PrototypeComponentNode = {
  id: string;
  name: string;
  type: string;
  detail: string;
  depth: number;
};

type QaIssue = {
  id: string;
  title: string;
  detail: string;
  severity: QaSeverity;
  source: string;
};

type FeedbackWorkflowStep = {
  id: string;
  title: string;
  detail: string;
  status: WorkflowStepStatus;
};

const LOCAL_ACTIONS: Array<{ id: PrototypeLocalAction; label: string; icon: typeof Sparkles }> = [
  { id: "copy_generate", label: "文案生成", icon: PencilLine },
  { id: "visual_refine", label: "视觉优化", icon: Wand2 },
  { id: "layout_adjust", label: "布局调整", icon: Crop },
  { id: "interaction_fill", label: "交互补齐", icon: MousePointer2 },
];

const PREVIEW_TABS: Array<{ value: PreviewMode; label: string; icon: typeof FileText; description: string }> = [
  { value: "prd", label: "PRD", icon: FileText, description: "文档阅读与段落编辑" },
  { value: "prototype", label: "原型", icon: Crop, description: "画布选区与局部补丁" },
  { value: "qa", label: "QA", icon: ShieldAlert, description: "问题严重程度与回归" },
  { value: "state", label: "状态", icon: Activity, description: "指标、推断与版本" },
  { value: "feedback", label: "反馈", icon: MessageSquare, description: "反馈闭环工作流" },
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
  decision,
}: {
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
  decision?: Phase2DecisionView | null;
}) {
  const [mode, setMode] = useState<PreviewMode>("prototype");
  const activeTab = PREVIEW_TABS.find((tab) => tab.value === mode) ?? PREVIEW_TABS[1];

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
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-950">结果预览</div>
          <div className="truncate text-xs text-gray-500">{activeTab.description}</div>
        </div>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          ariaLabel="结果预览切换"
          className="max-w-[360px] overflow-x-auto"
          options={PREVIEW_TABS.map((tab) => {
            const Icon = tab.icon;
            return {
              value: tab.value,
              label: tab.label,
              icon: <Icon className="h-3.5 w-3.5" />,
            };
          })}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "prd" ? (
          <div className="workbench-scrollbar h-full overflow-y-auto p-2.5">
            <PrdPreviewView prdPreview={prdPreview} />
          </div>
        ) : mode === "prototype" ? (
          <PrototypePreviewView prototypePreview={prototypePreview} />
        ) : mode === "qa" ? (
          <QaPreviewView decision={decision} />
        ) : mode === "state" ? (
          <StatePreviewView decision={decision} prdPreview={prdPreview} prototypePreview={prototypePreview} />
        ) : (
          <FeedbackWorkflowView decision={decision} />
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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [sectionEdits, setSectionEdits] = useState<Record<string, string>>({});
  const [draftText, setDraftText] = useState("");

  useEffect(() => {
    setSelectedIndex(0);
    setEditingIndex(null);
    setSectionEdits({});
    setDraftText("");
  }, [prdPreview?.id, prdPreview?.title]);

  if (!prdPreview) {
    return (
      <EmptyPreview
        title="暂无需求文档"
        description="发送需求后，系统会在完成约束、决策、进化流程后生成一份可预览需求文档。"
      />
    );
  }

  const documentKey = prdPreview.id ?? prdPreview.title;
  const sections = prdPreview.sections.map((section, index) => ({
    ...section,
    title: toChineseText(section.title),
    content: toChineseText(sectionEdits[sectionEditKey(documentKey, index)] ?? section.content),
  }));
  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, sections.length - 1));
  const selectedSection = sections[safeSelectedIndex] ?? sections[0];
  const totalCharacters = sections.reduce((sum, section) => sum + section.content.replace(/\s+/g, "").length, 0);
  const readMinutes = Math.max(1, Math.ceil(totalCharacters / 500));

  const beginEdit = (index: number) => {
    const section = sections[index];
    if (!section) return;
    setSelectedIndex(index);
    setEditingIndex(index);
    setDraftText(section.content);
  };

  const saveEdit = () => {
    if (editingIndex === null) return;
    setSectionEdits((current) => ({
      ...current,
      [sectionEditKey(documentKey, editingIndex)]: draftText.trim() || sections[editingIndex]?.content || "",
    }));
    setEditingIndex(null);
  };

  const generateAcceptanceDraft = () => {
    const section = sections[safeSelectedIndex];
    if (!section) return;
    setEditingIndex(safeSelectedIndex);
    setDraftText([
      section.content,
      "",
      "验收标准：",
      "1. 用户能清楚理解该段落描述的目标和边界。",
      "2. 相关状态、异常和反馈路径在原型中有对应表达。",
      "3. QA 能依据本段内容完成回归检查。",
    ].join("\n"));
  };

  return (
    <div className="space-y-3">
      <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white px-4 py-3 shadow-[var(--shadow-control)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-sky-700">
              <FileText className="h-4 w-4" />
              需求文档
            </div>
            <h2 className="mt-2 text-lg font-semibold leading-tight text-gray-950">{toChineseText(prdPreview.title)}</h2>
          </div>
          <Badge tone="info" className="bg-sky-50">
            阅读态
          </Badge>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <Metric label="章节" value={sections.length} />
          <Metric label="阅读" value={`${readMinutes} 分钟`} />
          <Metric label="字符" value={compactNumber(totalCharacters)} />
        </div>
      </div>

      <div className="grid min-h-0 gap-3 xl:grid-cols-[190px_minmax(0,1fr)]">
        <div className="space-y-2 rounded-[var(--radius-panel)] border border-gray-200 bg-white p-2 shadow-[var(--shadow-control)]">
          <div className="flex items-center justify-between px-1">
            <div className="text-xs font-semibold text-gray-500">文档目录</div>
            <Badge tone="neutral" className="bg-gray-50">{safeSelectedIndex + 1}/{sections.length}</Badge>
          </div>
          <div className="space-y-1">
            {sections.map((section, index) => {
              const selected = index === safeSelectedIndex;
              return (
                <button
                  key={`${section.title}-${index}`}
                  type="button"
                  onClick={() => {
                    setSelectedIndex(index);
                    setEditingIndex(null);
                  }}
                  className={[
                    "w-full rounded-[10px] border px-2.5 py-2 text-left transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
                    selected
                      ? "border-blue-200 bg-blue-50 text-blue-900"
                      : "border-transparent bg-white text-gray-600 hover:border-gray-200 hover:bg-gray-50 hover:text-gray-950",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={[
                        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
                        selected ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500",
                      ].join(" ")}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 truncate text-xs font-semibold">{section.title}</span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[11px] leading-4 opacity-75">{section.content}</div>
                </button>
              );
            })}
          </div>
        </div>

        <section className="min-w-0 rounded-[var(--radius-panel)] border border-gray-200 bg-white shadow-[var(--shadow-control)]">
          <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gray-950 text-xs font-semibold text-white">
                  {safeSelectedIndex + 1}
                </span>
                <h3 className="min-w-0 truncate text-sm font-semibold text-gray-950">{selectedSection.title}</h3>
              </div>
              <div className="mt-1 text-xs text-gray-500">{selectedSection.content.replace(/\s+/g, "").length} 字符</div>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={() => beginEdit(safeSelectedIndex)}>
              <PencilLine className="h-4 w-4" />
              编辑段落
            </Button>
          </div>

          <div className="space-y-3 px-4 py-3">
            {splitParagraphs(selectedSection.content).map((paragraph, index) => (
              <p key={`${safeSelectedIndex}-${index}`} className="whitespace-pre-wrap rounded-[12px] border border-transparent px-3 py-2 text-sm leading-7 text-gray-600 hover:border-blue-100 hover:bg-blue-50/40">
                {paragraph}
              </p>
            ))}
          </div>

          <div className="sticky bottom-2 mx-3 mb-3 rounded-[14px] border border-blue-100 bg-white/95 p-2.5 shadow-[var(--shadow-float)] backdrop-blur">
            {editingIndex === safeSelectedIndex ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-blue-700">段落编辑器</div>
                  <Badge tone="accent" className="bg-blue-50">局部草稿</Badge>
                </div>
                <textarea
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  rows={5}
                  className="block max-h-[180px] min-h-[120px] w-full resize-none rounded-[12px] border border-gray-200 bg-gray-50 px-3 py-2 text-sm leading-6 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-950 focus:bg-white focus:ring-3 focus:ring-gray-950/10"
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => setEditingIndex(null)}>
                    取消
                  </Button>
                  <Button type="button" size="sm" onClick={saveEdit}>
                    <Check className="h-4 w-4" />
                    保存草稿
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-gray-950">{selectedSection.title}</div>
                  <div className="text-xs text-gray-500">选区可进入局部段落编辑</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => beginEdit(safeSelectedIndex)}>
                    改写
                  </Button>
                  <Button type="button" size="sm" onClick={generateAcceptanceDraft}>
                    生成验收点
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function PrototypePreviewView({ prototypePreview }: { prototypePreview?: Phase1PrototypePreview | null }) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const componentNodes = useMemo(
    () => derivePrototypeComponents(prototypePreview?.html ?? ""),
    [prototypePreview?.html],
  );
  const [canvasMode, setCanvasMode] = useState<PrototypeCanvasMode>("select");
  const [activeComponentId, setActiveComponentId] = useState("");
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
    setActiveComponentId("");
    setDragStart(null);
    setDraftBox(null);
    setSelection(null);
    setDialogOpen(false);
    setLocalAction("copy_generate");
    setInstruction("");
    setGenerating(false);
    setGeneration(null);
  }, [prototypePreview?.id, prototypePreview?.html]);

  useEffect(() => {
    if (!componentNodes.length) return;
    setActiveComponentId((current) => (
      current && componentNodes.some((node) => node.id === current) ? current : componentNodes[0].id
    ));
  }, [componentNodes]);

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

  const selectComponent = (node: PrototypeComponentNode, index: number) => {
    setActiveComponentId(node.id);
    setCanvasMode("select");
    setDialogOpen(false);
    setGeneration(null);

    const bounds = canvasRef.current?.getBoundingClientRect();
    const width = Math.min(280, Math.max(160, (bounds?.width ?? 640) * 0.3));
    const height = Math.min(180, Math.max(96, (bounds?.height ?? 640) * 0.18));
    const maxX = Math.max(8, (bounds?.width ?? 640) - width - 8);
    const maxY = Math.max(8, (bounds?.height ?? 640) - height - 8);
    const nextRect = {
      x: clamp(24 + (index % 3) * 86, 8, maxX),
      y: clamp(32 + index * 48, 8, maxY),
      width,
      height,
    };

    setSelection({
      ...nextRect,
      id: `prototype-component-${node.id}`,
      kind: "box",
      label: `${node.name} 组件选区`,
      createdAt: Date.now(),
    });
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
      <div className="grid min-h-0 flex-1 grid-cols-[174px_minmax(0,1fr)] gap-2 p-2">
        <aside className="flex min-h-0 flex-col rounded-[var(--radius-control)] border border-blue-100 bg-white shadow-[var(--shadow-control)]">
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-blue-100 px-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-900">
              <Layers className="h-3.5 w-3.5 text-blue-600" />
              Component Tree
            </div>
            <Badge tone="neutral" className="bg-gray-50">{componentNodes.length}</Badge>
          </div>
          <div className="workbench-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {componentNodes.map((node, index) => {
              const active = node.id === activeComponentId;
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => selectComponent(node, index)}
                  className={[
                    "w-full rounded-[10px] border px-2 py-2 text-left transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
                    active
                      ? "border-blue-200 bg-blue-50 text-blue-900"
                      : "border-transparent bg-white text-gray-600 hover:border-gray-200 hover:bg-gray-50 hover:text-gray-950",
                  ].join(" ")}
                  style={{ paddingLeft: 8 + node.depth * 10 }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={[
                        "h-2 w-2 shrink-0 rounded-full",
                        active ? "bg-blue-600" : "bg-gray-300",
                      ].join(" ")}
                    />
                    <span className="min-w-0 truncate text-xs font-semibold">{node.name}</span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-gray-500">{node.type} · {node.detail}</div>
                </button>
              );
            })}
          </div>
          <PrototypePatchPreview selection={selection} generation={generation} />
        </aside>

        <div className="min-w-0 overflow-hidden rounded-[var(--radius-control)] border border-blue-100 bg-white shadow-[var(--shadow-panel)]">
          <div className="flex h-9 items-center gap-2 border-b border-blue-100 bg-gray-50 px-3">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span className="ml-2 truncate text-xs text-gray-500">{prototypePreview.entryFilePath ?? "index.html"}</span>
            {selection ? (
              <Badge tone="accent" className="ml-auto bg-white">
                {selection.kind === "box" ? "框选" : "点选"}
              </Badge>
            ) : null}
            {generation ? (
              <Badge tone="success" className={selection ? "gap-1" : "ml-auto gap-1"}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                Patch
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
                      left: clamp(selection.x, 8, Math.max(8, selection.x + selection.width - 236)),
                      top: Math.max(8, selection.y - 44),
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setLocalAction("copy_generate");
                        setDialogOpen(true);
                      }}
                      className="h-8 rounded-full px-3 text-xs"
                    >
                      文案
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        setLocalAction("visual_refine");
                        setDialogOpen(true);
                      }}
                      className="h-8 rounded-full px-3 text-xs"
                    >
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

function PrototypePatchPreview({
  selection,
  generation,
}: {
  selection: PrototypeCanvasSelection | null;
  generation: PrototypeLocalGeneration | null;
}) {
  return (
    <div className="shrink-0 border-t border-blue-100 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-900">
          <Code2 className="h-3.5 w-3.5 text-blue-600" />
          Patch Preview
        </div>
        <Badge tone={generation ? "success" : selection ? "accent" : "neutral"} className="bg-white">
          {generation ? "已生成" : selection ? "待生成" : "未选区"}
        </Badge>
      </div>
      {generation ? (
        <div className="space-y-1.5">
          {generation.changes.slice(0, 3).map((change) => (
            <div key={change} className="rounded-lg border border-emerald-100 bg-emerald-50 px-2 py-1.5 text-[11px] leading-4 text-emerald-900">
              {change}
            </div>
          ))}
        </div>
      ) : selection ? (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-2 py-2 text-[11px] leading-4 text-blue-800">
          {selection.label}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-2 text-[11px] leading-4 text-gray-500">
          选择画布区域后会展示局部补丁草稿。
        </div>
      )}
    </div>
  );
}

function QaPreviewView({ decision }: { decision?: Phase2DecisionView | null }) {
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

function StatePreviewView({
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
              <div key={item} className="rounded-lg bg-white/80 px-2.5 py-2 text-xs leading-5 text-amber-900">
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
                    <div className="text-xs font-semibold text-gray-950">{item.title}</div>
                    <div className="mt-0.5 text-[11px] leading-4 text-gray-500">{item.meta}</div>
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

function StateMetric({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: number | string }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-gray-100 text-gray-700">
          <Icon className="h-4 w-4" />
        </span>
        <div className="text-lg font-semibold text-gray-950">{value}</div>
      </div>
      <div className="mt-2 text-xs text-gray-500">{label}</div>
    </div>
  );
}

function InferenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[12px] border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="text-[11px] font-semibold text-gray-500">{label}</div>
      <div className="mt-1 text-xs leading-5 text-gray-800">{toChineseText(value)}</div>
    </div>
  );
}

function FeedbackWorkflowView({ decision }: { decision?: Phase2DecisionView | null }) {
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackItems, setFeedbackItems] = useState<Array<{ id: string; text: string; status: string }>>([]);
  const workflow = buildFeedbackWorkflow(decision, feedbackItems.length);

  const addFeedback = () => {
    const text = feedbackText.trim();
    if (!text) return;
    setFeedbackItems((items) => [
      { id: `feedback-${Date.now()}`, text, status: "已记录" },
      ...items,
    ]);
    setFeedbackText("");
  };

  return (
    <div className="workbench-scrollbar h-full overflow-y-auto p-2.5">
      <div className="space-y-3">
        <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
                <MessageSquare className="h-4 w-4 text-blue-600" />
                反馈闭环
              </div>
              <div className="mt-1 text-xs text-gray-500">从用户反馈到补丁回归的工作流面板</div>
            </div>
            <Badge tone={feedbackItems.length ? "accent" : "neutral"} className="bg-white">
              {feedbackItems.length} 条反馈
            </Badge>
          </div>
          <div className="mt-3 grid gap-2">
            {workflow.map((step, index) => (
              <div key={step.id} className="flex items-center gap-2 rounded-[12px] border border-gray-200 bg-gray-50 px-3 py-2">
                <span className={workflowStepClass(step.status)}>
                  {step.status === "done" ? <Check className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-gray-950">{step.title}</div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-500">{step.detail}</div>
                </div>
                {index < workflow.length - 1 ? <ArrowRight className="h-3.5 w-3.5 text-gray-300" /> : null}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[var(--radius-panel)] border border-blue-100 bg-blue-50 p-3">
          <div className="text-sm font-semibold text-blue-950">记录反馈</div>
          <textarea
            value={feedbackText}
            onChange={(event) => setFeedbackText(event.target.value)}
            rows={4}
            placeholder="输入用户反馈、验收意见或需要回归的问题"
            className="mt-2 block min-h-[104px] w-full resize-none rounded-[12px] border border-blue-100 bg-white px-3 py-2 text-sm leading-6 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-950 focus:ring-3 focus:ring-gray-950/10"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={!decision}>
              <Sparkles className="h-4 w-4" />
              生成补丁建议
            </Button>
            <Button type="button" size="sm" disabled={!feedbackText.trim()} onClick={addFeedback}>
              <MessageSquare className="h-4 w-4" />
              记录反馈
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {feedbackItems.length ? (
            feedbackItems.map((item) => (
              <div key={item.id} className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-gray-950">{item.status}</div>
                  <Badge tone="accent" className="bg-blue-50">待归因</Badge>
                </div>
                <div className="mt-2 text-sm leading-6 text-gray-700">{item.text}</div>
              </div>
            ))
          ) : (
            <div className="rounded-[var(--radius-panel)] border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
              反馈记录会以闭环任务的方式沉淀在这里。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function sectionEditKey(documentKey: string, index: number) {
  return `${documentKey}:${index}`;
}

function splitParagraphs(content: string) {
  const paragraphs = content
    .split(/\n{2,}|\r?\n(?=(?:[0-9]+[.、]|[一二三四五六七八九十]+[、.]))/)
    .map((item) => item.trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [content];
}

function derivePrototypeComponents(html: string): PrototypeComponentNode[] {
  if (!html.trim()) return [];

  const nodes: PrototypeComponentNode[] = [];
  const structuralPattern = /<(header|nav|main|section|article|form|footer|aside)\b([^>]*)>/gi;
  Array.from(html.matchAll(structuralPattern)).slice(0, 9).forEach((match, index) => {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? "";
    nodes.push({
      id: `structure-${index}-${tag}`,
      name: componentName(tag, attrs, index),
      type: tag.toUpperCase(),
      detail: componentDetail(attrs) || "结构容器",
      depth: tag === "main" || tag === "header" || tag === "footer" ? 0 : 1,
    });
  });

  const headingPattern = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  Array.from(html.matchAll(headingPattern)).slice(0, 4).forEach((match, index) => {
    nodes.push({
      id: `heading-${index}`,
      name: trimText(stripHtml(match[2]), `标题 ${index + 1}`),
      type: `H${match[1]}`,
      detail: "文案节点",
      depth: 2,
    });
  });

  const actionPattern = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  Array.from(html.matchAll(actionPattern)).slice(0, 4).forEach((match, index) => {
    nodes.push({
      id: `action-${index}`,
      name: trimText(stripHtml(match[3]), `动作 ${index + 1}`),
      type: match[1].toUpperCase(),
      detail: componentDetail(match[2] ?? "") || "可交互控件",
      depth: 2,
    });
  });

  if (!nodes.length) {
    nodes.push({
      id: "document-root",
      name: "页面根节点",
      type: "HTML",
      detail: "完整原型",
      depth: 0,
    });
  }

  return nodes.slice(0, 14);
}

function componentName(tag: string, attrs: string, index: number) {
  const explicit = attrs.match(/\b(?:aria-label|data-component|data-name|id)=["']([^"']+)["']/i)?.[1];
  if (explicit) return toChineseText(humanizeToken(explicit));
  const fallback: Record<string, string> = {
    header: "顶部导航",
    nav: "导航",
    main: "主内容",
    section: `内容区 ${index + 1}`,
    article: `内容卡片 ${index + 1}`,
    form: "表单",
    footer: "页脚",
    aside: "侧栏",
  };
  return fallback[tag] ?? `${tag} ${index + 1}`;
}

function componentDetail(attrs: string) {
  const className = attrs.match(/\bclass=["']([^"']+)["']/i)?.[1];
  if (!className) return "";
  return humanizeToken(className.split(/\s+/).slice(0, 2).join(" "));
}

function humanizeToken(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function trimText(value: string, fallback: string) {
  const text = value.trim();
  if (!text) return fallback;
  return toChineseText(text.length > 18 ? `${text.slice(0, 18)}...` : text);
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

  const checks = decision.previewSession.riskPanel?.checks ?? {};
  Object.entries(checks)
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

function normalizeRisk(value?: string): "low" | "medium" | "high" {
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
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

function decisionConstraintContext(decision?: Phase2DecisionView | null) {
  return decision?.constraintContext
    ?? decision?.decisionPlan.constraintContext
    ?? decision?.agentInput?.constraintContext
    ?? null;
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
    icon: typeof FileText;
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

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildFeedbackWorkflow(decision?: Phase2DecisionView | null, feedbackCount = 0): FeedbackWorkflowStep[] {
  return [
    {
      id: "collect",
      title: "收集反馈",
      detail: feedbackCount ? `${feedbackCount} 条反馈已进入闭环` : "等待用户反馈",
      status: feedbackCount ? "done" : "active",
    },
    {
      id: "attribute",
      title: "语义归因",
      detail: decision?.knowledgeSearch?.summary ? toChineseText(decision.knowledgeSearch.summary) : "关联知识库与约束",
      status: decision?.knowledgeSearch ? "done" : feedbackCount ? "active" : "pending",
    },
    {
      id: "patch",
      title: "生成补丁",
      detail: decision ? `${decision.patchDraft.operations.length} 个补丁操作` : "等待决策结果",
      status: decision?.patchDraft.operations.length ? "done" : "pending",
    },
    {
      id: "regression",
      title: "QA 回归",
      detail: decision ? `QA ${decision.evolution.metrics.qaPassed ? "通过" : "待处理"}` : "等待补丁",
      status: decision?.evolution.metrics.qaPassed ? "done" : decision ? "active" : "pending",
    },
    {
      id: "learn",
      title: "沉淀进化",
      detail: decision ? evolutionCopy(decision.evolution.signal.signalType) : "等待闭环完成",
      status: decision ? "done" : "pending",
    },
  ];
}

function workflowStepClass(status: WorkflowStepStatus) {
  const base = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full";
  if (status === "done") return `${base} bg-emerald-100 text-emerald-700`;
  if (status === "active") return `${base} bg-blue-100 text-blue-700`;
  return `${base} bg-gray-100 text-gray-400`;
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
