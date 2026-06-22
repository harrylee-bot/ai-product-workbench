import { AgentName, ModelTaskType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  agentSystemPrompt,
  VIBE_CODING_AGENT_CHARTERS,
  VIBE_CODING_AGENT_NAMES,
} from "../src/ai/agent-charter";

describe("Vibe Coding agent charter", () => {
  it("defines every runtime Vibe Coding agent once", () => {
    expect(VIBE_CODING_AGENT_NAMES).toEqual([
      AgentName.intent_agent,
      AgentName.knowledge_agent,
      AgentName.requirement_analyst_agent,
      AgentName.product_planner_agent,
      AgentName.product_designer_agent,
      AgentName.prd_writer_agent,
      AgentName.prototype_designer_agent,
      AgentName.prototype_code_agent,
      AgentName.patch_agent,
      AgentName.qa_agent,
      AgentName.knowledge_extractor_agent,
    ]);
    expect(Object.keys(VIBE_CODING_AGENT_CHARTERS)).toHaveLength(VIBE_CODING_AGENT_NAMES.length);
  });

  it("keeps the core ownership boundaries explicit", () => {
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.intent_agent].owns).toContain("理解");
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.knowledge_agent].owns).toContain("查知识");
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.product_planner_agent].owns).toContain("正式需求执行方案");
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.product_designer_agent].owns).toContain("产品状态");
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.prd_writer_agent].owns).toContain("PRD");
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.prototype_designer_agent].owns).toContain("原型结构");
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.prototype_code_agent].owns).toContain("HTML");
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.qa_agent].owns).toContain("只检查不能改");
    expect(VIBE_CODING_AGENT_CHARTERS[AgentName.knowledge_extractor_agent].owns).toContain("知识候选");
  });

  it("guards QA and knowledge extraction from write access", () => {
    const planner = VIBE_CODING_AGENT_CHARTERS[AgentName.product_planner_agent];
    expect(planner.taskType).toBe(ModelTaskType.product_planning);
    expect(planner.mutationAuthority).toBe("plan_draft");
    expect(planner.primaryOutputs).toContain("ProductBuildPlan");
    expect(planner.forbiddenActions.join(" ")).toContain("直接生成 ProductDesignState");

    const qa = VIBE_CODING_AGENT_CHARTERS[AgentName.qa_agent];
    expect(qa.taskType).toBe(ModelTaskType.qa_check);
    expect(qa.mutationAuthority).toBe("read_only");
    expect(qa.forbiddenActions.join(" ")).toContain("修改 ProductDesignState");
    expect(qa.forbiddenActions.join(" ")).toContain("重写 HTML");

    const extractor = VIBE_CODING_AGENT_CHARTERS[AgentName.knowledge_extractor_agent];
    expect(extractor.mutationAuthority).toBe("knowledge_candidate_draft");
    expect(extractor.forbiddenActions.join(" ")).toContain("直接写正式 KnowledgeItem");
  });

  it("injects the charter into agent system prompts", () => {
    const prompt = agentSystemPrompt(AgentName.prototype_code_agent, "你是 Prototype Code Agent。");
    expect(prompt).toContain("Vibe Coding Agent 职责定稿");
    expect(prompt).toContain("负责：生成 HTML");
    expect(prompt).toContain("禁止：调用真实接口");
    expect(prompt).toContain("写入权限：html_artifact_draft");
  });
});
