import { AgentName, ModelTaskType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ModelGatewayError } from "../src/model-gateway/model-gateway.error";
import { PatchAgentService } from "../src/ai/agents/patch-agent.service";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";

describe("PatchAgentService", () => {
  it("falls back to a module-10 PatchPlan that only targets ProductDesignState", async () => {
    const modelGateway = {
      generateJson: vi.fn().mockRejectedValue(
        new ModelGatewayError("MODEL_PROVIDER_NOT_FOUND", "no model configured"),
      ),
    };
    const service = new PatchAgentService(modelGateway as never);

    const result = await service.run({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      input: {
        userInput: "这个按钮文案改成立即签到，未开始时置灰。",
        selectedRegion: {
          type: "prototype",
          targetId: "artifact-1",
          artifactId: "artifact-1",
          pageId: "page_home",
          componentId: "page_home_primary_action",
          label: "签到按钮",
          sourcePaths: ["frontendRules", "stateRules"],
        },
        productDesignState: baseState(),
      },
    });

    expect(modelGateway.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: AgentName.patch_agent,
        taskType: ModelTaskType.patch_planning,
      }),
    );
    expect(result.data).toEqual(
      expect.objectContaining({
        projectId: "project-1",
        intent: "copy_change",
        impactAnalysis: expect.objectContaining({
          affectedStatePaths: ["frontendRules", "stateRules"],
          requiresPrdRegeneration: true,
          requiresPrototypeRegeneration: true,
          requiresQaCheck: true,
        }),
        regenerationPlan: {
          prd: "full",
          prototypeSpec: "full",
          htmlPrototype: "full",
          qa: "basic",
        },
        needsUserConfirmation: false,
      }),
    );
    expect(result.data.operations).toHaveLength(1);
    expect(result.data.operations[0]).toEqual(
      expect.objectContaining({
        op: "add",
        path: "frontendRules",
      }),
    );
    expect(result.data.operations[0].path).not.toMatch(/prd|html|prototypeSpec/i);
  });
});

function baseState(overrides: Partial<ProductDesignState> = {}): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 1,
    title: "签到活动",
    summary: "让用户每天完成签到并领取积分奖励。",
    businessGoal: "提升用户活跃。",
    background: "运营活动背景。",
    targetUsers: [],
    userScenarios: [],
    pages: [{ id: "page_home", name: "签到页" }],
    features: [{ id: "feature_checkin", name: "签到" }],
    backendConfigs: [],
    frontendRules: [{ id: "front_initial", title: "默认按钮" }],
    businessRules: [{ id: "rule_daily_once", title: "每日一次" }],
    stateRules: [{ id: "state_default", name: "默认态" }],
    exceptionScenarios: [{ id: "exception_network", title: "网络异常" }],
    acceptanceCriteria: [],
    assumptions: [{ id: "assumption_reward", content: "默认奖励积分", status: "pending" }],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "prototype_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}
