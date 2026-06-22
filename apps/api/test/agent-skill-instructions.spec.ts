import { AgentName, KnowledgeType, ModelTaskType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  agentSkillSystemPrompt,
  agentSkillSystemPromptFromKnowledgeRefs,
  collectKnowledgeReferences,
} from "../src/ai/agent-skill-instructions";
import type { KnowledgeContext } from "../src/ai/ai-vibe.types";

describe("agent skill instructions", () => {
  it("turns Vibe Coding skills into task-specific execution instructions", () => {
    const context = knowledgeContext({
      agentSkills: [
        {
          id: "agent-skill:obsidian-bases",
          name: "obsidian-bases",
          description: "Create and edit Obsidian Bases.",
          sourcePath: "/skills/obsidian-bases/SKILL.md",
          contentPreview: "Use views, filters, formulas, and summaries.",
          capabilities: ["Views", "Filters"],
          triggerHints: ["database", "table"],
        },
      ],
    });

    const prompt = agentSkillSystemPrompt(
      AgentName.product_designer_agent,
      ModelTaskType.product_design,
      context,
    );

    expect(prompt).toContain("Vibe Coding Skill 融合规则");
    expect(prompt).toContain("执行约束");
    expect(prompt).toContain("obsidian-bases");
    expect(prompt).toContain("字段、状态、筛选条件");
    expect(prompt).toContain("/skills/obsidian-bases/SKILL.md");
  });

  it("rebuilds skill instructions from ProductDesignState knowledgeRefs", () => {
    const prompt = agentSkillSystemPromptFromKnowledgeRefs(
      AgentName.prd_writer_agent,
      ModelTaskType.prd_generation,
      [
        {
          id: "agent_skill_obsidian-markdown",
          knowledgeId: "agent-skill:obsidian-markdown",
          title: "Vibe Coding 可用技能：obsidian-markdown",
          content: "核心能力：Internal Links；Callouts\n触发线索：wikilinks",
          relatedPath: "/skills/obsidian-markdown/SKILL.md",
        },
      ],
    );

    expect(prompt).toContain("obsidian-markdown");
    expect(prompt).toContain("Markdown/Vault");
    expect(prompt).toContain("Internal Links");
  });

  it("collects agent skills as deduplicated knowledge references", () => {
    const context = knowledgeContext({
      prototypeRules: [
        {
          id: "agent_skill_obsidian-markdown",
          knowledgeId: "agent-skill:obsidian-markdown",
          title: "Vibe Coding 可用技能：obsidian-markdown",
          content: "Use wikilinks.",
          type: KnowledgeType.prototype_rule,
          sourceType: "knowledge_base",
        },
      ],
      agentSkills: [
        {
          id: "agent-skill:obsidian-markdown",
          name: "obsidian-markdown",
          description: "Create and edit Obsidian Flavored Markdown.",
          sourcePath: "/skills/obsidian-markdown/SKILL.md",
          contentPreview: "Use wikilinks.",
          capabilities: ["Internal Links"],
          triggerHints: ["wikilinks"],
        },
        {
          id: "agent-skill:json-canvas",
          name: "json-canvas",
          description: "Create JSON Canvas diagrams.",
          sourcePath: "/skills/json-canvas/SKILL.md",
          contentPreview: "Use nodes and edges.",
          capabilities: ["Nodes", "Edges"],
          triggerHints: ["canvas"],
        },
      ],
    });

    const refs = collectKnowledgeReferences(context);

    expect(refs.map((ref) => ref.knowledgeId)).toEqual([
      "agent-skill:obsidian-markdown",
      "agent-skill:json-canvas",
    ]);
  });
});

function knowledgeContext(partial: Partial<KnowledgeContext>): KnowledgeContext {
  return {
    query: "test",
    strongRules: [],
    defaultRules: [],
    referenceCases: [],
    designPatterns: [],
    prdWritingRules: [],
    prototypeRules: [],
    businessConcepts: [],
    agentSkills: [],
    conflicts: [],
    unknownAreas: [],
    summary: "",
    ...partial,
  };
}
