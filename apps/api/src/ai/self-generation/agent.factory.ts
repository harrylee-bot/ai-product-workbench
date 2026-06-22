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
      name: "流程优化智能体",
      role: "发现工作流瓶颈，并提出更安全的流程变更建议。",
      prompt:
        "分析决策追踪、补丁预览、质检和反馈信号。" +
        "只返回结构化观察，不得直接修改系统状态。",
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
