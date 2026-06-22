import { AgentName, KnowledgeType, ModelTaskType, UserIntent } from "@prisma/client";
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
    const skillRegistry = {
      getVibeCodingSkills: vi.fn().mockResolvedValue([
        {
          id: "agent-skill:obsidian-markdown",
          name: "obsidian-markdown",
          description: "Create and edit Obsidian Flavored Markdown.",
          sourcePath: "/skills/obsidian-markdown/SKILL.md",
          contentPreview: "Use wikilinks and callouts.",
          capabilities: ["Internal Links"],
          triggerHints: ["wikilinks"],
        },
      ]),
      toKnowledgeReferences: vi.fn().mockReturnValue([
        {
          id: "agent_skill_obsidian-markdown",
          knowledgeId: "agent-skill:obsidian-markdown",
          title: "Vibe Coding 可用技能：obsidian-markdown",
          content: "Use wikilinks and callouts.",
          type: KnowledgeType.prototype_rule,
          sourceType: "knowledge_base",
          sourceId: "agent-skill:obsidian-markdown",
        },
      ]),
    };
    const service = new KnowledgeAgentService(modelGateway as never, retrieval as never, skillRegistry as never);

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
    expect(result.data.prototypeRules[1].knowledgeId).toBe("agent-skill:obsidian-markdown");
    expect(result.data.agentSkills?.[0].name).toBe("obsidian-markdown");
    expect(result.data.summary).toContain("命中 2 条");
    expect(result.data.summary).toContain("已加载 1 个");
  });

  it("uses product planning knowledge profile for formal requirements", async () => {
    const modelGateway = { generateJson: vi.fn() };
    const retrieval = {
      search: vi.fn().mockResolvedValue({ results: [], references: [] }),
    };
    const skillRegistry = {
      getVibeCodingSkills: vi.fn().mockResolvedValue([]),
      toKnowledgeReferences: vi.fn().mockReturnValue([]),
    };
    const service = new KnowledgeAgentService(modelGateway as never, retrieval as never, skillRegistry as never);

    await service.run({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      input: {
        userInput: "帮我做一个会员活动正式需求",
        intent: UserIntent.new_requirement,
        attachments: [],
      },
    });

    expect(retrieval.search).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: ModelTaskType.product_planning,
        preferredTypes: expect.arrayContaining([
          KnowledgeType.strong_rule,
          KnowledgeType.prd_writing_rule,
          KnowledgeType.prototype_rule,
        ]),
      }),
    );
  });
});
