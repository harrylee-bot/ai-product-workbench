import { AgentName, KnowledgeType, UserIntent } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeAgentService } from "../src/ai/agents/knowledge-agent.service";

describe("KnowledgeAgentService", () => {
  it("uses the retrieval service and groups module-11 knowledge references", async () => {
    const modelGateway = { generateJson: vi.fn() };
    const retrieval = {
      search: vi.fn().mockResolvedValue({
        results: [],
        references: [
          {
            id: "ref-1",
            knowledgeId: "knowledge-1",
            title: "每日签到强规则",
            snippet: "每日只能签到一次。",
            content: "每日只能签到一次。",
            type: KnowledgeType.strong_rule,
            sourceType: "knowledge_base",
            sourceId: "knowledge-1",
          },
          {
            id: "ref-2",
            knowledgeId: "knowledge-2",
            title: "原型规范",
            snippet: "原型需覆盖异常态。",
            content: "原型需覆盖异常态。",
            type: KnowledgeType.prototype_rule,
            sourceType: "knowledge_base",
            sourceId: "knowledge-2",
          },
        ],
      }),
    };
    const service = new KnowledgeAgentService(modelGateway as never, retrieval as never);

    const result = await service.run({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      input: {
        userInput: "做一个签到活动 PRD 和原型",
        intent: UserIntent.generate_prototype,
        attachments: [],
      },
    });

    expect(retrieval.search).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        runId: "run-1",
        agentName: AgentName.knowledge_agent,
        preferredTypes: expect.arrayContaining([KnowledgeType.prototype_rule]),
      }),
    );
    expect(result.data.strongRules[0].knowledgeId).toBe("knowledge-1");
    expect(result.data.prototypeRules[0].knowledgeId).toBe("knowledge-2");
    expect(result.data.summary).toContain("命中 2 条");
  });
});
