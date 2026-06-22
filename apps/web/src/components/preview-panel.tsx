"use client";

import { useEffect, useState } from "react";
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
  constraintContext?: ConstraintContext;
  agentInput?: {
    userInput: string;
    constraintContext: ConstraintContext;
    decisionContext: Phase2DecisionView["decisionPlan"];
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

type PreviewTab = "prd" | "prototype" | "decision";

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
  decision,
  prdPreview,
  prototypePreview,
  applyingProposal,
  onApplyProposal,
}: {
  decision?: Phase2DecisionView | null;
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
  applyingProposal?: boolean;
  onApplyProposal?: (proposalId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<PreviewTab>(prdPreview ? "prd" : prototypePreview ? "prototype" : "decision");
  const strategies = decision?.decisionPlan.strategies ?? [];
  const selectedId = decision?.selection.selectedStrategyId ?? "";
  const companyRuntime = decision?.companyRuntime;
  const constraintContext = decision?.constraintContext ?? decision?.decisionPlan.constraintContext ?? null;
  const selectedScore = selectedId ? decision?.decisionPlan.scores?.[selectedId] : null;
  const graph =
    decision?.selfGeneration?.applied?.graph ??
    decision?.selfGeneration?.executionPlan ??
    decision?.executionPlan ??
    null;
  const agents = graph?.nodes.filter((node) => node.type === "agent") ?? [];
  const edges = graph?.edges ?? [];
  const tabs: Array<{ key: PreviewTab; label: string; icon: typeof FileText; ready: boolean }> = [
    { key: "prd", label: "需求文档", icon: FileText, ready: Boolean(prdPreview) },
    { key: "prototype", label: "原型", icon: Code2, ready: Boolean(prototypePreview?.html) },
    { key: "decision", label: "决策链路", icon: GitBranch, ready: Boolean(decision) },
  ];

  useEffect(() => {
    if (prdPreview) {
      setActiveTab("prd");
      return;
    }
    if (prototypePreview?.html) {
      setActiveTab("prototype");
      return;
    }
    setActiveTab("decision");
  }, [prdPreview?.id, prototypePreview?.id, prototypePreview?.html]);

  return (
    <aside className="flex min-h-0 flex-col bg-white">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="text-sm font-semibold text-gray-950">预览中心</div>
        <div className="text-xs text-gray-500">需求文档 / 原型 / 决策链路</div>
      </div>
      <div className="border-b border-gray-200 bg-white px-3 py-2">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={[
                  "inline-flex h-8 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold transition",
                  active ? "bg-white text-gray-950 shadow-sm" : "text-gray-500 hover:text-gray-800",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{tab.label}</span>
                {tab.ready ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activeTab === "prd" ? (
          <PrdPreviewView prdPreview={prdPreview} />
        ) : activeTab === "prototype" ? (
          <PrototypePreviewView prototypePreview={prototypePreview} />
        ) : !decision ? (
          <div className="rounded-lg border border-dashed border-gray-200 px-3 py-10 text-center text-sm leading-6 text-gray-500">
            发送需求后，这里会展示不少于 3 个策略、5 个评审智能体的评分、零维补丁预览和系统预览。
          </div>
        ) : (
          <div className="space-y-5">
            <section className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-amber-700">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  约束视图
                </div>
                <span className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs text-amber-700">
                  已应用 {constraintCount(constraintContext)} 条
                </span>
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-4">
                <Metric label="必须" value={constraintContext?.mustFollow.length ?? 0} />
                <Metric label="优先" value={constraintContext?.prefer.length ?? 0} />
                <Metric label="避免" value={constraintContext?.avoid.length ?? 0} />
                <Metric label="提醒" value={constraintContext?.warn.length ?? 0} />
              </div>
              <div className="mt-3 space-y-1">
                {firstConstraints(constraintContext).map((constraint) => (
                  <div key={constraint.id} className="rounded-md bg-white px-2 py-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-gray-800">{RULE_LABELS[constraint.rule]}</span>
                      <span className="text-amber-700">{SCOPE_LABELS[constraint.scope]}</span>
                    </div>
                    <div className="mt-1 leading-5 text-gray-600">{toChineseText(constraint.effect)}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-orange-700">
                  <Scale className="h-3.5 w-3.5" />
                  决策视图
                </div>
                <span className="rounded-md border border-orange-300 bg-white px-2 py-0.5 text-xs text-orange-700">
                  {strategies.length} 个策略
                </span>
              </div>
              <div className="mt-2 text-sm font-semibold text-gray-950">
                {STRATEGY_LABELS[decision.selectedStrategy.name]}
              </div>
              <div className="mt-1 text-xs leading-5 text-orange-900">
                {toChineseText(decision.decisionPlan.reasoning?.[0] ?? decision.selection.reason)}
              </div>
              {selectedScore ? (
                <div className="mt-3 grid gap-2 text-xs md:grid-cols-5">
                  <Metric label="易用" value={selectedScore.usability} />
                  <Metric label="可行" value={selectedScore.feasibility} />
                  <Metric label="风险" value={selectedScore.risk} />
                  <Metric label="业务" value={selectedScore.businessValue} />
                  <Metric label="得分" value={selectedScore.weightedScore.toFixed(2)} />
                </div>
              ) : null}
            </section>

            <section className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-cyan-700">
                  <Activity className="h-3.5 w-3.5" />
                  进化视图
                </div>
                <span className="rounded-md border border-cyan-300 bg-white px-2 py-0.5 text-xs text-cyan-700">
                  策略版本 v{decision.evolution.policyVersion}
                </span>
              </div>
              <div className="mt-2 text-sm font-semibold text-gray-950">
                {evolutionCopy(decision.evolution.signal.signalType)}
              </div>
              <div className="mt-1 text-xs leading-5 text-cyan-900">{toChineseText(decision.evolution.signal.reason)}</div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                <Metric label="策略" value={shortId(decision.evolution.signal.strategyId)} />
                <Metric label="变化" value={signed(decision.evolution.strategyDelta)} />
                <Metric label="结果" value={OUTCOME_LABELS[decision.evolution.finalOutcome]} />
              </div>
            </section>

            {companyRuntime ? (
              <section className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase text-indigo-700">
                    <Building2 className="h-3.5 w-3.5" />
                    公司看板
                  </div>
                  <span className="rounded-md border border-indigo-300 bg-white px-2 py-0.5 text-xs text-indigo-700">
                    {companyRuntime.ceoPlan.approved ? "首席决策已批准" : "等待首席决策"}
                  </span>
                </div>
                <div className="mt-2 text-sm font-semibold text-gray-950">{toChineseText(companyRuntime.company.name)}</div>
                <div className="mt-1 text-xs leading-5 text-indigo-900">{toChineseText(companyRuntime.company.strategy)}</div>

                <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                  <Metric label="预算" value={`${compactNumber(companyRuntime.company.budget)} 元`} />
                  <Metric label="部门" value={companyRuntime.company.departments.length} />
                  <Metric
                    label="智能体"
                    value={companyRuntime.company.departments.reduce((sum, department) => sum + department.agents.length, 0)}
                  />
                </div>

                <div className="mt-3 rounded-md border border-indigo-200 bg-white px-2 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-gray-950">{toChineseText(companyRuntime.productInitiative.name)}</div>
                    <span className="rounded-md bg-gray-950 px-2 py-0.5 text-xs text-white">
                      {departmentLabel(companyRuntime.productInitiative.priority as DepartmentType)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs leading-5 text-gray-600">{toChineseText(companyRuntime.productInitiative.goal)}</div>
                  <div className="mt-2 flex items-center gap-1 text-xs font-medium text-indigo-800">
                    <CircleDollarSign className="h-3.5 w-3.5" />
                    已分配 {compactNumber(companyRuntime.productInitiative.allocatedBudget)} 元
                  </div>
                </div>

                <div className="mt-3 space-y-1">
                  {companyRuntime.company.departments.map((department) => (
                    <div key={department.id} className="rounded-md bg-white px-2 py-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-gray-800">{departmentLabel(department.type)}</span>
                        <span className="text-indigo-700">{compactNumber(department.budgetAllocation)} 元</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-indigo-100">
                        <div
                          className="h-full rounded-full bg-indigo-500"
                          style={{
                            width: `${Math.max(
                              6,
                              Math.min(100, (department.budgetAllocation / companyRuntime.company.budget) * 100),
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="mt-1 truncate text-gray-500">{toChineseText(department.agents[0]?.name ?? "暂无智能体")}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                  <PlanMetric label="工程" value={`${companyRuntime.engineeringPlan.modules.length} 个模块`} />
                  <PlanMetric label="设计" value={`${companyRuntime.designPlan.uxFlows.length} 条流程`} />
                  <PlanMetric label="质检" value={riskLabel(companyRuntime.qaReport.riskLevel)} tone={companyRuntime.qaReport.riskLevel} />
                  <PlanMetric label="增长" value={`${companyRuntime.growthPlan.experiments.length} 个实验`} />
                </div>
              </section>
            ) : null}

            <section>
              <div className="text-xs font-semibold uppercase text-gray-500">策略列表</div>
              <div className="mt-2 space-y-2">
                {strategies.map((strategy) => (
                  <div
                    key={strategy.id}
                    className={[
                      "rounded-lg border px-3 py-2",
                      strategy.id === selectedId
                        ? "border-gray-950 bg-gray-950 text-white"
                        : "border-gray-200 bg-gray-50 text-gray-800",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold">{STRATEGY_LABELS[strategy.name]}</div>
                      <span className="rounded-md border border-current px-2 py-0.5 text-xs">
                        {IMPACT_LABELS[strategy.impact]}
                      </span>
                    </div>
                    <div className={strategy.id === selectedId ? "mt-1 text-xs leading-5 text-gray-200" : "mt-1 text-xs leading-5 text-gray-500"}>
                      {toChineseText(strategy.description)}
                    </div>
                    <div className="mt-2 text-xs">
                      {strategy.patchOperations.length} 项操作
                      {strategy.id === selectedId ? " · 已选中" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="text-xs font-semibold uppercase text-gray-500">评审委员会</div>
              <div className="mt-2 space-y-2">
                {decision.reviewBoard.reviews.map((review) => (
                  <div key={review.agentName} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-gray-950">{agentLabel(review.agentName)}</div>
                      <span className="text-xs text-gray-500">
                        倾向 {shortId(review.preferredStrategyId)}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1 text-center text-xs">
                      <Score label="易用" value={review.scores.usability} />
                      <Score label="可行" value={review.scores.feasibility} />
                      <Score label="风险" value={review.scores.risk} />
                      <Score label="业务" value={review.scores.businessValue} />
                    </div>
                    {review.objections[0] ? (
                      <div className="mt-2 text-xs leading-5 text-gray-500">{toChineseText(review.objections[0])}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-xs font-semibold uppercase text-gray-500">策略选择器</div>
              <div className="mt-2 text-sm font-semibold text-gray-950">
                {STRATEGY_LABELS[decision.selectedStrategy.name]}
              </div>
              <div className="mt-1 text-xs leading-5 text-gray-600">{toChineseText(decision.selection.reason)}</div>
            </section>

            <section className="rounded-lg border border-gray-950 bg-white px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase text-gray-500">零维补丁预览</div>
                <span className="rounded-md bg-gray-950 px-2 py-0.5 text-xs text-white">
                  {statusLabel(decision.previewSession.status)}
                </span>
              </div>
              <div className="mt-2 text-sm font-semibold text-gray-950">{toChineseText(decision.previewSession.message)}</div>
              <div className="mt-1 text-xs leading-5 text-gray-500">
                补丁记录 {shortId(decision.previewSession.patchRecordId)} · 预览 {shortId(decision.previewSession.id)}
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-2">
                  风险：{riskLabel(decision.previewSession.riskPanel?.level)}
                </div>
                <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-2">
                  影响域：{decision.patchDraft.targetDomains.map(domainLabel).join("、")}
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {(decision.previewSession.diff?.operations ?? decision.patchDraft.operations).map((operation, index) => (
                  <div key={`${operation.path}-${index}`} className="rounded-md border border-gray-200 px-2 py-2 text-xs">
                    <div className="font-semibold text-gray-950">{OPERATION_LABELS[operation.op]}</div>
                    <div className="mt-1 break-all text-gray-500">{operation.path}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase text-emerald-700">系统进化</div>
                <span className="rounded-md border border-emerald-300 bg-white px-2 py-0.5 text-xs text-emerald-700">
                  策略版本 v{decision.evolution.policyVersion}
                </span>
              </div>
              <div className="mt-2 text-sm font-semibold text-gray-950">
                {evolutionCopy(decision.evolution.signal.signalType)}
              </div>
              <div className="mt-1 text-xs leading-5 text-emerald-800">
                {toChineseText(decision.evolution.signal.reason)}
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <div className="rounded-md border border-emerald-200 bg-white px-2 py-2">
                  <div className="text-gray-500">策略</div>
                  <div className="mt-1 font-semibold text-gray-950">
                    {shortId(decision.evolution.signal.strategyId)} {signed(decision.evolution.strategyDelta)}
                  </div>
                </div>
                <div className="rounded-md border border-emerald-200 bg-white px-2 py-2">
                  <div className="text-gray-500">结果</div>
                  <div className="mt-1 font-semibold text-gray-950">
                    {OUTCOME_LABELS[decision.evolution.finalOutcome]} · {decision.evolution.metrics.executionTime} 毫秒
                  </div>
                </div>
              </div>
              <div className="mt-3 space-y-1">
                {Object.entries(decision.evolution.agentDeltas).map(([agent, delta]) => (
                  <div key={agent} className="flex items-center justify-between rounded-md bg-white px-2 py-1 text-xs">
                    <span className="text-gray-600">{agentLabel(agent)}</span>
                    <span className={delta >= 0 ? "font-semibold text-emerald-700" : "font-semibold text-red-600"}>
                      {signed(delta)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <div className="rounded-md border border-emerald-200 bg-white px-2 py-2">
                  风险规避 {decision.evolution.policy.decisionBias.riskAversion.toFixed(2)}
                </div>
                <div className="rounded-md border border-emerald-200 bg-white px-2 py-2">
                  创新倾向 {decision.evolution.policy.decisionBias.innovationBias.toFixed(2)}
                </div>
              </div>
              <div className="mt-3 text-xs font-medium text-emerald-800">系统正在学习...</div>
            </section>

            <section className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-sky-700">
                  <GitBranch className="h-3.5 w-3.5" />
                  系统看板
                </div>
                <span className="rounded-md border border-sky-300 bg-white px-2 py-0.5 text-xs text-sky-700">
                  图版本 v{graph?.version ?? 0}
                </span>
              </div>

              <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                <Metric label="智能体" value={agents.length} />
                <Metric label="流程边" value={edges.length} />
                <Metric label="追踪" value={shortId(decision.evolution.traceId)} />
              </div>

              {decision.selfGeneration ? (
                <>
                  <div className="mt-3 rounded-md border border-sky-200 bg-white px-2 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-gray-950">系统预览</div>
                      <span className={riskClass(decision.selfGeneration.proposal.riskLevel)}>
                        {riskLabel(decision.selfGeneration.proposal.riskLevel)}
                      </span>
                    </div>
                    <div className="mt-2 text-xs leading-5 text-gray-600">
                      {toChineseText(decision.selfGeneration.insight.opportunity)}
                    </div>
                    <div className="mt-2 text-xs text-gray-500">
                      提案 {shortId(decision.selfGeneration.proposal.id)} · {statusLabel(decision.selfGeneration.proposal.status)}
                    </div>
                  </div>

                  <div className="mt-2 space-y-1">
                    {decision.selfGeneration.proposal.mutations.map((mutation) => (
                      <div
                        key={mutation.id}
                        className="flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 text-xs"
                      >
                        <span className="min-w-0 truncate text-gray-700">
                          {MUTATION_LABELS[mutation.type]} · {targetLabel(mutation.target)}
                        </span>
                        <span className={riskTextClass(mutation.riskLevel)}>{riskLabel(mutation.riskLevel)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 space-y-1">
                    {decision.selfGeneration.proposal.impactAnalysis.slice(0, 3).map((item) => (
                      <div key={item} className="text-xs leading-5 text-sky-800">
                        {toChineseText(item)}
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-sky-800">
                      {decision.selfGeneration.applied ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          已应用到系统图
                        </>
                      ) : (
                        <>
                          <ShieldAlert className="h-3.5 w-3.5" />
                          等待预览门禁
                        </>
                      )}
                    </div>
                    {decision.selfGeneration.proposal.status === "preview" &&
                    decision.selfGeneration.proposal.riskLevel === "medium" ? (
                      <button
                        type="button"
                        disabled={applyingProposal}
                        onClick={() => onApplyProposal?.(decision.selfGeneration!.proposal.id)}
                        className="rounded-md bg-gray-950 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                      >
                        {applyingProposal ? "应用中" : "应用"}
                      </button>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="mt-3 rounded-md border border-dashed border-sky-200 bg-white px-2 py-4 text-center text-xs text-gray-500">
                  下一次编排后会显示自生成预览。
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </aside>
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
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-sky-700">
          <FileText className="h-4 w-4" />
          需求文档
        </div>
        <h2 className="mt-2 text-lg font-semibold leading-tight text-gray-950">{toChineseText(prdPreview.title)}</h2>
        <div className="mt-1 text-xs text-gray-500">{prdPreview.sections.length} 个章节</div>
      </div>
      {prdPreview.sections.map((section, index) => (
        <section key={`${section.title}-${index}`} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
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
      <EmptyPreview
        title="暂无原型"
        description="发送需求后，系统会生成一份 HTML 原型，并在这里直接预览。"
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-indigo-700">
          <Code2 className="h-4 w-4" />
          原型预览
        </div>
        <h2 className="mt-2 truncate text-lg font-semibold leading-tight text-gray-950">{toChineseText(prototypePreview.title)}</h2>
        <div className="mt-1 text-xs text-gray-500">{prototypePreview.entryFilePath ?? "index.html"}</div>
      </div>
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex h-8 items-center gap-2 border-b border-gray-200 bg-gray-50 px-3">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <span className="ml-2 truncate text-xs text-gray-500">网页原型</span>
        </div>
        <iframe
          title="原型预览"
          srcDoc={prototypePreview.html}
          sandbox="allow-scripts"
          className="h-[620px] w-full border-0 bg-white"
        />
      </div>
    </div>
  );
}

function EmptyPreview({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-12 text-center">
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
