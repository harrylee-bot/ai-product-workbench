"use client";

import { Activity, Building2, Check, CircleDollarSign, GitBranch, Scale, ShieldAlert } from "lucide-react";

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

const STRATEGY_LABELS: Record<Phase2Strategy["name"], string> = {
  conservative_fix: "保守修正",
  ux_improve: "UX 优化",
  structure_rewrite: "结构重写",
  full_regenerate: "完整重建",
  conservative: "保守策略",
  balanced: "平衡策略",
  aggressive: "进取策略",
  full_rewrite: "完整重写",
};

export function PreviewPanel({
  decision,
  applyingProposal,
  onApplyProposal,
}: {
  decision?: Phase2DecisionView | null;
  applyingProposal?: boolean;
  onApplyProposal?: (proposalId: string) => void;
}) {
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

  return (
    <aside className="flex min-h-0 flex-col bg-white">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="text-sm font-semibold text-gray-950">AI Product OS</div>
        <div className="text-xs text-gray-500">Constraint / Decision / Evolution / Company</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!decision ? (
          <div className="rounded-lg border border-dashed border-gray-200 px-3 py-10 text-center text-sm leading-6 text-gray-500">
            发送需求后，这里会展示不少于 3 个策略、5 个评审 Agent 的评分、0D Patch Preview 和 System Preview。
          </div>
        ) : (
          <div className="space-y-5">
            <section className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-amber-700">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Constraint View
                </div>
                <span className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs text-amber-700">
                  {constraintCount(constraintContext)} applied
                </span>
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-4">
                <Metric label="Must" value={constraintContext?.mustFollow.length ?? 0} />
                <Metric label="Prefer" value={constraintContext?.prefer.length ?? 0} />
                <Metric label="Avoid" value={constraintContext?.avoid.length ?? 0} />
                <Metric label="Warn" value={constraintContext?.warn.length ?? 0} />
              </div>
              <div className="mt-3 space-y-1">
                {firstConstraints(constraintContext).map((constraint) => (
                  <div key={constraint.id} className="rounded-md bg-white px-2 py-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-gray-800">{constraint.rule}</span>
                      <span className="text-amber-700">{constraint.scope}</span>
                    </div>
                    <div className="mt-1 leading-5 text-gray-600">{constraint.effect}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-orange-700">
                  <Scale className="h-3.5 w-3.5" />
                  Decision View
                </div>
                <span className="rounded-md border border-orange-300 bg-white px-2 py-0.5 text-xs text-orange-700">
                  {strategies.length} strategies
                </span>
              </div>
              <div className="mt-2 text-sm font-semibold text-gray-950">
                {STRATEGY_LABELS[decision.selectedStrategy.name]}
              </div>
              <div className="mt-1 text-xs leading-5 text-orange-900">
                {decision.decisionPlan.reasoning?.[0] ?? decision.selection.reason}
              </div>
              {selectedScore ? (
                <div className="mt-3 grid gap-2 text-xs md:grid-cols-5">
                  <Metric label="Use" value={selectedScore.usability} />
                  <Metric label="Feas" value={selectedScore.feasibility} />
                  <Metric label="Risk" value={selectedScore.risk} />
                  <Metric label="Biz" value={selectedScore.businessValue} />
                  <Metric label="Score" value={selectedScore.weightedScore.toFixed(2)} />
                </div>
              ) : null}
            </section>

            <section className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-cyan-700">
                  <Activity className="h-3.5 w-3.5" />
                  Evolution View
                </div>
                <span className="rounded-md border border-cyan-300 bg-white px-2 py-0.5 text-xs text-cyan-700">
                  Policy v{decision.evolution.policyVersion}
                </span>
              </div>
              <div className="mt-2 text-sm font-semibold text-gray-950">
                {evolutionCopy(decision.evolution.signal.signalType)}
              </div>
              <div className="mt-1 text-xs leading-5 text-cyan-900">{decision.evolution.signal.reason}</div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                <Metric label="Strategy" value={shortId(decision.evolution.signal.strategyId)} />
                <Metric label="Delta" value={signed(decision.evolution.strategyDelta)} />
                <Metric label="Outcome" value={decision.evolution.finalOutcome} />
              </div>
            </section>

            {companyRuntime ? (
              <section className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase text-indigo-700">
                    <Building2 className="h-3.5 w-3.5" />
                    Company Dashboard
                  </div>
                  <span className="rounded-md border border-indigo-300 bg-white px-2 py-0.5 text-xs text-indigo-700">
                    {companyRuntime.ceoPlan.approved ? "CEO approved" : "Pending CEO"}
                  </span>
                </div>
                <div className="mt-2 text-sm font-semibold text-gray-950">{companyRuntime.company.name}</div>
                <div className="mt-1 text-xs leading-5 text-indigo-900">{companyRuntime.company.strategy}</div>

                <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                  <Metric label="Budget" value={`$${compactNumber(companyRuntime.company.budget)}`} />
                  <Metric label="Departments" value={companyRuntime.company.departments.length} />
                  <Metric
                    label="Agents"
                    value={companyRuntime.company.departments.reduce((sum, department) => sum + department.agents.length, 0)}
                  />
                </div>

                <div className="mt-3 rounded-md border border-indigo-200 bg-white px-2 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-gray-950">{companyRuntime.productInitiative.name}</div>
                    <span className="rounded-md bg-gray-950 px-2 py-0.5 text-xs text-white">
                      {companyRuntime.productInitiative.priority}
                    </span>
                  </div>
                  <div className="mt-1 text-xs leading-5 text-gray-600">{companyRuntime.productInitiative.goal}</div>
                  <div className="mt-2 flex items-center gap-1 text-xs font-medium text-indigo-800">
                    <CircleDollarSign className="h-3.5 w-3.5" />
                    Allocated ${compactNumber(companyRuntime.productInitiative.allocatedBudget)}
                  </div>
                </div>

                <div className="mt-3 space-y-1">
                  {companyRuntime.company.departments.map((department) => (
                    <div key={department.id} className="rounded-md bg-white px-2 py-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-gray-800">{departmentLabel(department.type)}</span>
                        <span className="text-indigo-700">${compactNumber(department.budgetAllocation)}</span>
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
                      <div className="mt-1 truncate text-gray-500">{department.agents[0]?.name ?? "No agent"}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                  <PlanMetric label="Engineering" value={`${companyRuntime.engineeringPlan.modules.length} modules`} />
                  <PlanMetric label="Design" value={`${companyRuntime.designPlan.uxFlows.length} flows`} />
                  <PlanMetric label="QA" value={companyRuntime.qaReport.riskLevel} tone={companyRuntime.qaReport.riskLevel} />
                  <PlanMetric label="Growth" value={`${companyRuntime.growthPlan.experiments.length} experiments`} />
                </div>
              </section>
            ) : null}

            <section>
              <div className="text-xs font-semibold uppercase text-gray-500">Strategies</div>
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
                        {strategy.impact}
                      </span>
                    </div>
                    <div className={strategy.id === selectedId ? "mt-1 text-xs leading-5 text-gray-200" : "mt-1 text-xs leading-5 text-gray-500"}>
                      {strategy.description}
                    </div>
                    <div className="mt-2 text-xs">
                      {strategy.patchOperations.length} operations
                      {strategy.id === selectedId ? " · selected" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="text-xs font-semibold uppercase text-gray-500">Review Board</div>
              <div className="mt-2 space-y-2">
                {decision.reviewBoard.reviews.map((review) => (
                  <div key={review.agentName} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-gray-950">{review.agentName}</div>
                      <span className="text-xs text-gray-500">
                        prefers {shortId(review.preferredStrategyId)}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1 text-center text-xs">
                      <Score label="Use" value={review.scores.usability} />
                      <Score label="Feas" value={review.scores.feasibility} />
                      <Score label="Risk" value={review.scores.risk} />
                      <Score label="Biz" value={review.scores.businessValue} />
                    </div>
                    {review.objections[0] ? (
                      <div className="mt-2 text-xs leading-5 text-gray-500">{review.objections[0]}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-xs font-semibold uppercase text-gray-500">Strategy Selector</div>
              <div className="mt-2 text-sm font-semibold text-gray-950">
                {STRATEGY_LABELS[decision.selectedStrategy.name]}
              </div>
              <div className="mt-1 text-xs leading-5 text-gray-600">{decision.selection.reason}</div>
            </section>

            <section className="rounded-lg border border-gray-950 bg-white px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase text-gray-500">Patch Preview 0D</div>
                <span className="rounded-md bg-gray-950 px-2 py-0.5 text-xs text-white">
                  {decision.previewSession.status}
                </span>
              </div>
              <div className="mt-2 text-sm font-semibold text-gray-950">{decision.previewSession.message}</div>
              <div className="mt-1 text-xs leading-5 text-gray-500">
                PatchRecord {shortId(decision.previewSession.patchRecordId)} · Preview {shortId(decision.previewSession.id)}
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-2">
                  Risk: {decision.previewSession.riskPanel?.level ?? "low"}
                </div>
                <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-2">
                  Domains: {decision.patchDraft.targetDomains.join(", ")}
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {(decision.previewSession.diff?.operations ?? decision.patchDraft.operations).map((operation, index) => (
                  <div key={`${operation.path}-${index}`} className="rounded-md border border-gray-200 px-2 py-2 text-xs">
                    <div className="font-semibold text-gray-950">{operation.op}</div>
                    <div className="mt-1 break-all text-gray-500">{operation.path}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase text-emerald-700">System Evolution</div>
                <span className="rounded-md border border-emerald-300 bg-white px-2 py-0.5 text-xs text-emerald-700">
                  Policy v{decision.evolution.policyVersion}
                </span>
              </div>
              <div className="mt-2 text-sm font-semibold text-gray-950">
                {evolutionCopy(decision.evolution.signal.signalType)}
              </div>
              <div className="mt-1 text-xs leading-5 text-emerald-800">
                {decision.evolution.signal.reason}
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <div className="rounded-md border border-emerald-200 bg-white px-2 py-2">
                  <div className="text-gray-500">Strategy</div>
                  <div className="mt-1 font-semibold text-gray-950">
                    {shortId(decision.evolution.signal.strategyId)} {signed(decision.evolution.strategyDelta)}
                  </div>
                </div>
                <div className="rounded-md border border-emerald-200 bg-white px-2 py-2">
                  <div className="text-gray-500">Outcome</div>
                  <div className="mt-1 font-semibold text-gray-950">
                    {decision.evolution.finalOutcome} · {decision.evolution.metrics.executionTime}ms
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
                  Risk aversion {decision.evolution.policy.decisionBias.riskAversion.toFixed(2)}
                </div>
                <div className="rounded-md border border-emerald-200 bg-white px-2 py-2">
                  Innovation bias {decision.evolution.policy.decisionBias.innovationBias.toFixed(2)}
                </div>
              </div>
              <div className="mt-3 text-xs font-medium text-emerald-800">System is learning...</div>
            </section>

            <section className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-sky-700">
                  <GitBranch className="h-3.5 w-3.5" />
                  System Dashboard
                </div>
                <span className="rounded-md border border-sky-300 bg-white px-2 py-0.5 text-xs text-sky-700">
                  Graph v{graph?.version ?? 0}
                </span>
              </div>

              <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                <Metric label="Agents" value={agents.length} />
                <Metric label="Pipeline" value={edges.length} />
                <Metric label="Trace" value={shortId(decision.evolution.traceId)} />
              </div>

              {decision.selfGeneration ? (
                <>
                  <div className="mt-3 rounded-md border border-sky-200 bg-white px-2 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-gray-950">System Preview</div>
                      <span className={riskClass(decision.selfGeneration.proposal.riskLevel)}>
                        {decision.selfGeneration.proposal.riskLevel}
                      </span>
                    </div>
                    <div className="mt-2 text-xs leading-5 text-gray-600">
                      {decision.selfGeneration.insight.opportunity}
                    </div>
                    <div className="mt-2 text-xs text-gray-500">
                      Proposal {shortId(decision.selfGeneration.proposal.id)} · {decision.selfGeneration.proposal.status}
                    </div>
                  </div>

                  <div className="mt-2 space-y-1">
                    {decision.selfGeneration.proposal.mutations.map((mutation) => (
                      <div
                        key={mutation.id}
                        className="flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 text-xs"
                      >
                        <span className="min-w-0 truncate text-gray-700">
                          {mutation.type} · {mutation.target}
                        </span>
                        <span className={riskTextClass(mutation.riskLevel)}>{mutation.riskLevel}</span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 space-y-1">
                    {decision.selfGeneration.proposal.impactAnalysis.slice(0, 3).map((item) => (
                      <div key={item} className="text-xs leading-5 text-sky-800">
                        {item}
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-sky-800">
                      {decision.selfGeneration.applied ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          Applied to graph
                        </>
                      ) : (
                        <>
                          <ShieldAlert className="h-3.5 w-3.5" />
                          Waiting for preview gate
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
                        {applyingProposal ? "Applying" : "Apply"}
                      </button>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="mt-3 rounded-md border border-dashed border-sky-200 bg-white px-2 py-4 text-center text-xs text-gray-500">
                  Self-generation preview will appear after the next orchestration.
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </aside>
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
  return Intl.NumberFormat("en", {
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
  if (signalType === "promote") return "Strategy promoted";
  if (signalType === "demote") return "Strategy demoted";
  return "Strategy kept neutral";
}

function agentLabel(agent: string) {
  const labels: Record<string, string> = {
    productStrategist: "Product Strategist",
    uxExpert: "UX Expert",
    techArchitect: "Tech Architect",
    riskController: "Risk Controller",
    growthAnalyst: "Growth Analyst",
  };
  return labels[agent] ?? agent;
}

function departmentLabel(type: DepartmentType) {
  const labels: Record<DepartmentType, string> = {
    ceo: "CEO",
    product: "Product",
    engineering: "Engineering",
    design: "Design",
    qa: "QA",
    growth: "Growth",
    evolution: "Evolution",
  };
  return labels[type];
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
