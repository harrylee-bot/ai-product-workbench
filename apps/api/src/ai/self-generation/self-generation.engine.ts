import { Injectable } from "@nestjs/common";
import { AgentFactory } from "./agent.factory";
import { MutationEngine, type SystemMutation } from "./mutation.engine";
import { SystemPreviewService } from "./system.preview.service";

export type SystemInsight = {
  bottleneck: string;
  weakness: string;
  opportunity: string;
};

@Injectable()
export class SelfGenerationEngine {
  constructor(
    private readonly agentFactory: AgentFactory,
    private readonly previews: SystemPreviewService,
    private readonly mutations: MutationEngine,
  ) {}

  async run(input: {
    projectId: string;
    createdBy: string;
    traceId: string;
    finalOutcome: "success" | "failure" | "partial";
    riskLevel?: string;
  }) {
    const insight = this.inspect(input.finalOutcome, input.riskLevel);
    const mutations = this.generateMutations(insight, input.finalOutcome);
    const proposal = await this.previews.createPreview({
      projectId: input.projectId,
      createdBy: input.createdBy,
      mutations,
      sourceTraceId: input.traceId,
    });
    const applied =
      proposal.riskLevel === "low"
        ? await this.mutations.applyProposal({
            projectId: input.projectId,
            proposalId: proposal.id,
            confirm: true,
            createdBy: input.createdBy,
          })
        : null;

    return {
      insight,
      proposal,
      applied,
      executionPlan: proposal.previewGraph,
    };
  }

  async proposeManual(input: {
    projectId: string;
    createdBy: string;
    instruction: string;
  }) {
    const agent = this.agentFactory.createFlowOptimizationAgent(input.instruction);
    const proposal = await this.previews.createPreview({
      projectId: input.projectId,
      createdBy: input.createdBy,
      mutations: [
        {
          id: `mutation_${agent.id}`,
          type: "add_agent",
          target: agent.id,
          payload: this.agentFactory.toNode(agent),
          reason: input.instruction,
          riskLevel: "medium",
        },
        {
          id: `mutation_pipeline_${agent.id}`,
          type: "add_step",
          target: "pipeline",
          payload: {
            from: "evolution_engine",
            to: agent.id,
            relation: "feeds",
          },
          reason: "将新智能体注册为进化后的观察节点。",
          riskLevel: "medium",
        },
      ],
    });
    return { insight: this.inspect("partial"), proposal, applied: null, executionPlan: proposal.previewGraph };
  }

  private inspect(outcome: "success" | "failure" | "partial", riskLevel?: string): SystemInsight {
    if (outcome === "failure") {
      return {
        bottleneck: "策略选择后反复出现执行失败。",
        weakness: "当前系统图缺少面向流程的诊断智能体。",
        opportunity: "在进化引擎之后新增实验性的流程优化智能体。",
      };
    }
    if (riskLevel === "medium" || outcome === "partial") {
      return {
        bottleneck: "补丁预览需要额外的依赖检查器。",
        weakness: "流程可以暴露风险，但系统图层面的检查仍有限。",
        opportunity: "为后续提案插入一个低风险系统图检查步骤。",
      };
    }
    return {
      bottleneck: "未发现关键瓶颈。",
      weakness: "系统图可观测性仍可提升。",
      opportunity: "注册低风险自生成观察节点。",
    };
  }

  private generateMutations(insight: SystemInsight, outcome: "success" | "failure" | "partial"): SystemMutation[] {
    if (outcome === "failure") {
      const agent = this.agentFactory.createFlowOptimizationAgent(insight.opportunity);
      return [
        {
          id: `mutation_${agent.id}`,
          type: "add_agent",
          target: agent.id,
          payload: this.agentFactory.toNode(agent),
          reason: insight.opportunity,
          riskLevel: "medium",
        },
      ];
    }

    return [
      {
        id: "mutation_self_generation_observer",
        type: "add_agent",
        target: "agent_self_generation_observer",
        payload: {
          id: "agent_self_generation_observer",
          type: "agent",
          name: "自生成观察智能体",
          status: "experimental",
          config: {
            role: "观察系统图健康度，只推荐变更预览。",
            prompt: "不得直接应用变更，只返回结构化系统变更提案。",
          },
        },
        reason: insight.opportunity,
        riskLevel: "low",
      },
      {
        id: "mutation_self_generation_edge",
        type: "add_step",
        target: "pipeline",
        payload: {
          from: "system_policy",
          to: "agent_self_generation_observer",
          relation: "feeds",
        },
        reason: "将策略变化输入自生成观察环节。",
        riskLevel: "low",
      },
    ];
  }
}
