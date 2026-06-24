import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { ModelMessage } from "../../model-gateway/model-gateway.types";
import type { AgentFallbackMetadata } from "../agent-fallback-policy";
import type { AgentInvocation, AgentOutput } from "../ai-vibe.types";

const DEFAULT_AGENT_RETRY_COUNT = 0;

export abstract class BaseAgentService<TInput, TOutput> {
  abstract readonly agentName: AgentName;
  abstract readonly taskType: ModelTaskType;

  constructor(protected readonly modelGateway: ModelGatewayService) {}

  async run(invocation: AgentInvocation<TInput, TOutput>): Promise<AgentOutput<TOutput>> {
    const messages = this.buildMessages(invocation.input);
    try {
      return await this.runWithRetries(async () => {
        const result = await this.modelGateway.generateJson<TOutput>({
          taskType: this.taskType,
          agentName: this.agentName,
          runId: invocation.runId,
          traceId: invocation.traceId,
          userId: invocation.userId,
          messages,
          jsonSchema: this.jsonSchema(),
          timeoutMs: this.modelTimeoutMs(invocation.input),
          retryCount: this.modelRetryCount(invocation.input),
          jsonParseRetryCount: this.jsonParseRetryCount(invocation.input),
          temperature: this.modelTemperature(invocation.input),
          maxTokens: this.modelMaxTokens(invocation.input),
        });

        return {
          data: this.normalize(result.data, invocation.input),
          modelCallLogId: result.modelCallLogId,
        };
      }, this.agentRetryCount(invocation.input));
    } catch (error) {
      const fallback = this.fallbackOnError(error, invocation.input);
      if (fallback) {
        return {
          data: this.normalize(this.fallback(invocation.input), invocation.input),
          fallback,
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

  protected agentRetryCount(_input: TInput) {
    return DEFAULT_AGENT_RETRY_COUNT;
  }

  protected modelRetryCount(_input: TInput): number | undefined {
    return undefined;
  }

  protected jsonParseRetryCount(_input: TInput): number | undefined {
    return undefined;
  }

  protected modelTimeoutMs(_input: TInput): number | undefined {
    return undefined;
  }

  protected modelTemperature(_input: TInput): number | undefined {
    return undefined;
  }

  protected modelMaxTokens(_input: TInput): number | undefined {
    return undefined;
  }

  protected fallbackOnError(_error: unknown, _input: TInput): AgentFallbackMetadata | undefined {
    return undefined;
  }

  private async runWithRetries(
    runOnce: () => Promise<AgentOutput<TOutput>>,
    retryCount: number,
  ) {
    let lastError: unknown;
    for (let retry = 0; retry <= retryCount; retry += 1) {
      try {
        return await runOnce();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("Agent 执行失败");
  }
}
