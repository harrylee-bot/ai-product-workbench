import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayError } from "../../model-gateway/model-gateway.error";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { ModelMessage } from "../../model-gateway/model-gateway.types";
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
      if (this.canFallback(error)) {
        return { data: this.fallback(invocation.input) };
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

  private canFallback(error: unknown) {
    if (!(error instanceof ModelGatewayError)) return false;
    return [
      "MODEL_TASK_PROFILE_NOT_FOUND",
      "MODEL_PROVIDER_NOT_FOUND",
      "MODEL_PROVIDER_DISABLED",
      "MODEL_CONFIG_NOT_FOUND",
      "MODEL_CONFIG_DISABLED",
      "MODEL_CALL_FAILED",
      "MODEL_CALL_TIMEOUT",
      "MODEL_API_KEY_INVALID",
      "MODEL_PROVIDER_UNAUTHORIZED",
      "MODEL_JSON_PARSE_FAILED",
    ].includes(error.code);
  }
}
