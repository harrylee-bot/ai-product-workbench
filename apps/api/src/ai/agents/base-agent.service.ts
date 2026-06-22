import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { ModelMessage } from "../../model-gateway/model-gateway.types";
import { decideAgentFallback } from "../agent-fallback-policy";
import type { AgentInvocation, AgentOutput } from "../ai-vibe.types";

export abstract class BaseAgentService<TInput, TOutput> {
  abstract readonly agentName: AgentName;
  abstract readonly taskType: ModelTaskType;

  constructor(protected readonly modelGateway: ModelGatewayService) {}

  async run(invocation: AgentInvocation<TInput, TOutput>): Promise<AgentOutput<TOutput>> {
    const messages = this.buildMessages(invocation.input);
    try {
      const result = await this.modelGateway.generateJson<TOutput>({
        taskType: this.taskType,
        agentName: this.agentName,
        runId: invocation.runId,
        traceId: invocation.traceId,
        userId: invocation.userId,
        messages,
        jsonSchema: this.jsonSchema(),
      });

      return {
        data: this.normalize(result.data, invocation.input),
        modelCallLogId: result.modelCallLogId,
      };
    } catch (error) {
      const fallbackDecision = this.fallbackDecision(error);
      if (fallbackDecision.allowed && fallbackDecision.metadata) {
        return {
          data: this.fallback(invocation.input),
          fallback: fallbackDecision.metadata,
        };
      }

      throw error;
    }
  }

  protected abstract buildMessages(input: TInput): ModelMessage[];

  protected abstract fallback(input: TInput): TOutput;

  protected normalize(output: TOutput, _input: TInput): TOutput {
    return output;
  }

  protected jsonSchema(): unknown {
    return {};
  }

  private fallbackDecision(error: unknown) {
    return decideAgentFallback({
      agentName: this.agentName,
      taskType: this.taskType,
      error,
      fallbackMode: process.env.AI_AGENT_FALLBACK_MODE,
    });
  }
}
