import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { ModelMessage } from "../../model-gateway/model-gateway.types";
import type { AgentInvocation, AgentOutput } from "../ai-vibe.types";

const AGENT_RETRY_COUNT = 5;

export abstract class BaseAgentService<TInput, TOutput> {
  abstract readonly agentName: AgentName;
  abstract readonly taskType: ModelTaskType;

  constructor(protected readonly modelGateway: ModelGatewayService) {}

  async run(invocation: AgentInvocation<TInput, TOutput>): Promise<AgentOutput<TOutput>> {
    const messages = this.buildMessages(invocation.input);
    return this.runWithRetries(async () => {
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
    });
  }

  protected abstract buildMessages(input: TInput): ModelMessage[];

  protected abstract fallback(input: TInput): TOutput;

  protected normalize(output: TOutput, _input: TInput): TOutput {
    return output;
  }

  protected jsonSchema(): unknown {
    return {};
  }

  private async runWithRetries(runOnce: () => Promise<AgentOutput<TOutput>>) {
    let lastError: unknown;
    for (let retry = 0; retry <= AGENT_RETRY_COUNT; retry += 1) {
      try {
        return await runOnce();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("Agent 执行失败");
  }
}
