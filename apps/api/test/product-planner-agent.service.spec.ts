import { AgentName, ModelTaskType, UserIntent } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ProductPlannerAgentService } from "../src/ai/agents/product-planner-agent.service";
import { ModelGatewayError } from "../src/model-gateway/model-gateway.error";

describe("ProductPlannerAgentService", () => {
  it("falls back to a formal ProductBuildPlan before ProductDesignState generation", async () => {
    const modelGateway = {
      generateJson: vi.fn().mockRejectedValue(
        new ModelGatewayError("MODEL_PROVIDER_NOT_FOUND", "no model configured"),
      ),
    };
    const service = new ProductPlannerAgentService(modelGateway as never);

    const result = await service.run({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      input: {
        userInput: "帮我做一个会员签到活动页，要有运营配置后台、未开始置灰、成功反馈和异常提示。",
        intent: UserIntent.new_requirement,
        requirementAnalysis: {
          completenessScore: 0.82,
          knownFromUser: ["用户希望生成签到活动页", "需要运营配置后台"],
          knownFromKnowledge: ["活动原型需覆盖关键状态"],
          inferredByAI: ["签到成功后应展示明确反馈"],
          missingCritical: [],
          missingOptional: ["数据统计口径"],
          conflicts: [],
          shouldAskUser: false,
          clarificationQuestions: [],
        },
        knowledgeContext: {
          query: "签到活动页",
          strongRules: [],
          defaultRules: [
            {
              id: "knowledge-1",
              title: "活动页面状态覆盖",
              content: "活动页必须覆盖默认、成功、禁用和异常状态。",
              sourceType: "knowledge_base",
            },
          ],
          referenceCases: [],
          designPatterns: [],
          prdWritingRules: [],
          prototypeRules: [],
          businessConcepts: [],
          agentSkills: [
            {
              id: "agent-skill:obsidian-bases",
              name: "obsidian-bases",
              description: "Create structured Obsidian Bases.",
              sourcePath: "/skills/obsidian-bases/SKILL.md",
              contentPreview: "Use views, filters, formulas, and summaries.",
              capabilities: ["Views", "Filters"],
              triggerHints: ["database", "table"],
            },
          ],
          skillRouting: [
            {
              skillId: "agent-skill:obsidian-bases",
              skillName: "obsidian-bases",
              sourcePath: "/skills/obsidian-bases/SKILL.md",
              appliesTo: [
                {
                  agentName: AgentName.product_designer_agent,
                  taskType: ModelTaskType.product_design,
                  handoffField: "ProductDesignState.knowledgeRefs",
                  usage: "把字段、状态、筛选条件写入 ProductDesignState。",
                },
              ],
            },
          ],
          conflicts: [],
          unknownAreas: [],
          summary: "命中默认规则",
        },
      },
    });

    expect(modelGateway.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: AgentName.product_planner_agent,
        taskType: ModelTaskType.product_planning,
      }),
    );
    const modelCall = modelGateway.generateJson.mock.calls[0][0];
    expect(modelCall.messages[0].content).toContain("正式需求唯一 plan agent");
    expect(modelCall.messages[0].content).toContain("局部修改的计划属于 Patch Agent");
    expect(modelCall.messages[0].content).toContain("Vibe Coding Skill 融合规则");
    expect(modelCall.messages[0].content).toContain("obsidian-bases");
    expect(result.data.requirementMode).toBe("formal_requirement");
    expect(result.data.summary).toContain("局部修改另走 PatchPlan");
    expect(result.data.sourceSummary.assumptions).toContain("本轮需按 Vibe Coding Skills 执行：obsidian-bases");
    expect(result.data.sourceSummary.assumptions).toContain("Skill 路由覆盖 Agent：product_designer_agent");
    expect(result.data.deliverables).toEqual({
      productDesignState: true,
      prd: true,
      prototypeSpec: true,
      htmlPrototype: true,
      qa: true,
      knowledgeCandidates: true,
    });
    expect(result.data.pagePlan.map((page) => page.name)).toContain("运营配置页");
    expect(result.data.statePlan.map((state) => state.coverage)).toEqual(
      expect.arrayContaining(["default", "success", "disabled", "error"]),
    );
    expect(result.data.agentSequence.map((item) => item.agentName)).toEqual([
      AgentName.product_planner_agent,
      AgentName.product_designer_agent,
      AgentName.prd_writer_agent,
      AgentName.prototype_designer_agent,
      AgentName.prototype_code_agent,
      AgentName.qa_agent,
      AgentName.knowledge_extractor_agent,
    ]);
    expect(result.data.agentSequence[1]).toEqual(
      expect.objectContaining({
        input: expect.arrayContaining(["ProductBuildPlan"]),
        output: "ProductDesignDraft",
      }),
    );
    expect(result.data.agentSequence[0].input).toContain("VibeCodingSkillInstructions");
    expect(result.data.agentSequence[0].input).toContain("KnowledgeContext.skillRouting");
    expect(result.data.qaFocus).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Vibe Coding Skills 是否保留 sourcePath/knowledgeId"),
      ]),
    );
    expect(result.data.agentSequence[0].gate).toContain("不规划局部 PatchPlan");
  });
});
