"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Activity, Building2, Check, CircleDollarSign, Code2, FileText, GitBranch, Scale, ShieldAlert } from "lucide-react";

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
    <aside className="flex min-h-0 flex-col bg-[var(--color-panel-bg)]">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-950">结果预览</div>
          <div className="truncate text-xs text-gray-500">需求文档与网页原型</div>
        </div>
        <div className="inline-flex rounded-full bg-gray-100 p-1 shadow-inner">
          <button
            type="button"
            onClick={() => setMode("prd")}
            className={[
              "h-8 rounded-full px-3 text-sm font-semibold transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
              mode === "prd" ? "bg-white text-gray-950 shadow-sm" : "text-gray-500 hover:text-gray-900",
            ].join(" ")}
          >
            需求
          </button>
          <button
            type="button"
            onClick={() => setMode("prototype")}
            className={[
              "h-8 rounded-full px-3 text-sm font-semibold transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
              mode === "prototype" ? "bg-white text-gray-950 shadow-sm" : "text-gray-500 hover:text-gray-900",
            ].join(" ")}
          >
            预览
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "prd" ? (
          <div className="workbench-scrollbar h-full overflow-y-auto p-3">
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
        <span
          className={[
            "shrink-0 rounded-md border px-2 py-0.5 text-xs",
            ready ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-gray-200 bg-white text-gray-500",
          ].join(" ")}
        >
          {ready ? "已生成" : "等待输入"}
        </span>
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-accent-soft)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-blue-100 bg-white/80 px-4 backdrop-blur">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-950">{toChineseText(prototypePreview.title)}</div>
          <div className="text-xs text-gray-500">网页原型预览</div>
        </div>
        <div className="rounded-full border border-blue-100 bg-white px-3 py-1 text-xs font-semibold text-blue-700 shadow-[var(--shadow-control)]">
          已生成
        </div>
      </div>
      <div className="min-h-0 flex-1 p-2.5">
        <div className="h-full overflow-hidden rounded-[14px] border border-blue-100 bg-white shadow-[var(--shadow-panel)]">
          <iframe
            title="原型预览"
            srcDoc={prototypePreview.html}
            sandbox="allow-scripts"
            className="h-full min-h-[720px] w-full border-0 bg-white"
          />
        </div>
      </div>
    </div>
  );
}

function EmptyPreview({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[16px] border border-dashed border-gray-200 bg-white px-4 py-12 text-center shadow-[var(--shadow-control)]">
      <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gray-50 text-gray-400">
        <FileText className="h-5 w-5" />
      </div>
      <div className="text-sm font-semibold text-gray-950">{title}</div>
      <p className="mx-auto mt-2 max-w-[300px] text-sm leading-6 text-gray-500">{description}</p>
    </div>
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
