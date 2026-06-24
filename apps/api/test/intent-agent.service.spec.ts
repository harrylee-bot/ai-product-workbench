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

  it("falls back to local intent detection without agent-level retry amplification", async () => {
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

    expect(modelGateway.generateJson).toHaveBeenCalledTimes(1);
    expect(result.data.intent).toBe(UserIntent.generate_prototype);
    expect(result.fallback).toEqual(expect.objectContaining({
      used: true,
      agentName: AgentName.intent_agent,
      taskType: ModelTaskType.intent_detection,
      fallbackMode: "heuristic_intent_detection",
      errorCode: "MODEL_PROVIDER_NOT_FOUND",
      canContinue: true,
    }));
  });
});
