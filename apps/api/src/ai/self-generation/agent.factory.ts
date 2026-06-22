import { Injectable } from "@nestjs/common";

export type DynamicAgent = {
  id: string;
  name: string;
  role: string;
  prompt: string;
  inputSchema: unknown;
  outputSchema: unknown;
};

@Injectable()
export class AgentFactory {
  createFlowOptimizationAgent(reason: string): DynamicAgent {
    return {
      id: "agent_flow_optimization",
      name: "Flow Optimization Agent",
      role: "Find workflow bottlenecks and suggest safer pipeline changes.",
      prompt:
        "Analyze DecisionTrace, PatchPreview, QA, and feedback signals. " +
        "Return only structured observations and never mutate system state directly.",
      inputSchema: {
        type: "object",
        required: ["decisionTrace", "systemGraph"],
        properties: {
          decisionTrace: { type: "object" },
          systemGraph: { type: "object" },
        },
      },
      outputSchema: {
        type: "object",
        required: ["bottleneck", "recommendedMutation"],
        properties: {
          bottleneck: { type: "string" },
          recommendedMutation: { type: "object" },
        },
      },
    };
  }

  toNode(agent: DynamicAgent) {
    return {
      id: agent.id,
      type: "agent" as const,
      name: agent.name,
      status: "experimental" as const,
      config: {
        role: agent.role,
        prompt: agent.prompt,
        inputSchema: agent.inputSchema,
        outputSchema: agent.outputSchema,
      },
    };
  }
}
