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
          reason: "Register new agent as a post-evolution observer.",
          riskLevel: "medium",
        },
      ],
    });
    return { insight: this.inspect("partial"), proposal, applied: null, executionPlan: proposal.previewGraph };
  }

  private inspect(outcome: "success" | "failure" | "partial", riskLevel?: string): SystemInsight {
    if (outcome === "failure") {
      return {
        bottleneck: "Repeated execution failure after decision selection.",
        weakness: "Current graph lacks a flow-specific diagnostic agent.",
        opportunity: "Add an experimental Flow Optimization Agent behind Evolution Engine.",
      };
    }
    if (riskLevel === "medium" || outcome === "partial") {
      return {
        bottleneck: "Patch Preview needs an additional dependency checker.",
        weakness: "Pipeline can surface risks but has limited graph-level checking.",
        opportunity: "Insert a low-risk graph checker step for future proposals.",
      };
    }
    return {
      bottleneck: "No critical bottleneck detected.",
      weakness: "Graph observability can be improved.",
      opportunity: "Register a low-risk self-generation observer node.",
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
          name: "Self-Generation Observer",
          status: "experimental",
          config: {
            role: "Observe graph health and recommend mutation previews only.",
            prompt: "Never apply mutations directly. Return structured SystemMutation proposals.",
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
        reason: "Feed policy changes into self-generation observation.",
        riskLevel: "low",
      },
    ];
  }
}
