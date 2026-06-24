import { AgentName, ModelTaskType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { RequirementAnalystAgentService } from "../src/ai/agents/requirement-analyst-agent.service";
import type { KnowledgeContext } from "../src/ai/ai-vibe.types";

describe("RequirementAnalystAgentService", () => {
  it("normalizes non-standard model output before Product Planner consumes it", async () => {
    const modelGateway = {
      generateJson: vi.fn().mockResolvedValue({
        data: {
          completenessScore: 0.8,
          knownFromUser: [{ title: "用户要继续生成签到活动" }, "需要原型"],
          knownFromKnowledge: [{ content: "活动页必须覆盖异常态" }],
          inferredByAI: [{ reason: "需要成功反馈" }],
          missingCritical: [],
          missingOptional: [{ title: "统计口径" }],
          conflicts: [{ description: "无冲突" }],
          shouldAskUser: false,
          clarificationQuestions: [{ title: "目标用户", reason: "影响范围" }],
        },
        modelCallLogId: "call-1",
      }),
    };
    const service = new RequirementAnalystAgentService(modelGateway as never);

    const result = await service.run({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      input: {
        userInput: "继续生成签到活动 PRD 和原型",
        knowledgeContext: baseKnowledgeContext(),
        recentMessages: [],
      },
    });

    expect(modelGateway.generateJson).toHaveBeenCalledWith(expect.objectContaining({
      agentName: AgentName.requirement_analyst_agent,
      taskType: ModelTaskType.requirement_analysis,
    }));
    expect(result.data.knownFromUser).toEqual(["用户要继续生成签到活动", "需要原型"]);
    expect(result.data.knownFromKnowledge).toEqual(["活动页必须覆盖异常态"]);
    expect(result.data.inferredByAI).toEqual(["需要成功反馈"]);
    expect(result.data.missingOptional).toEqual(["统计口径"]);
    expect(result.data.conflicts).toEqual(["无冲突"]);
    expect(result.data.clarificationQuestions).toEqual([
      expect.objectContaining({
        title: "目标用户",
        reason: "影响范围",
      }),
    ]);
  });
});

function baseKnowledgeContext(): KnowledgeContext {
  return {
    query: "签到活动",
    strongRules: [],
    defaultRules: [],
    referenceCases: [],
    designPatterns: [],
    prdWritingRules: [],
    prototypeRules: [],
    businessConcepts: [],
    conflicts: [],
    unknownAreas: [],
    summary: "",
  };
}
