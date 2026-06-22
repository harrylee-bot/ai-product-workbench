import { AgentName, ModelTaskType, UserIntent } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { IntentAgentService } from "../src/ai/agents/intent-agent.service";
import { ModelGatewayError } from "../src/model-gateway/model-gateway.error";

describe("IntentAgentService", () => {
  it("treats pure greetings as general questions even when the model misclassifies them", async () => {
    const modelGateway = {
      generateJson: vi.fn().mockResolvedValue({
        data: {
          intent: UserIntent.new_requirement,
          confidence: 0.9,
          reason: "模型误判为新需求",
          requiresSelection: false,
          isAmbiguous: false,
        },
        modelCallLogId: "call-1",
      }),
    };
    const service = new IntentAgentService(modelGateway as never);

    const result = await service.run({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      input: {
        userInput: "你好",
        recentMessages: [],
      },
    });

    expect(modelGateway.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: AgentName.intent_agent,
        taskType: ModelTaskType.intent_detection,
      }),
    );
    expect(result.data.intent).toBe(UserIntent.general_question);
    expect(result.data.reason).toContain("不应触发需求生成链路");
  });

  it("does not block a greeting that includes a concrete product request", async () => {
    const modelGateway = {
      generateJson: vi.fn().mockRejectedValue(
        new ModelGatewayError("MODEL_PROVIDER_NOT_FOUND", "no model configured"),
      ),
    };
    const service = new IntentAgentService(modelGateway as never);

    const result = await service.run({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      input: {
        userInput: "你好，帮我做一个签到活动页面",
        recentMessages: [],
      },
    });

    expect(result.data.intent).toBe(UserIntent.generate_prototype);
    expect(result.data.reason).toBe("用户希望生成或刷新原型。");
    expect(result.fallback).toEqual(
      expect.objectContaining({
        level: "degraded_preview",
        action: "review_required",
        agentName: AgentName.intent_agent,
        taskType: ModelTaskType.intent_detection,
      }),
    );
  });
});
