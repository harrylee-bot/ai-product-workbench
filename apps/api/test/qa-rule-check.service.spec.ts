import { describe, expect, it } from "vitest";
import type { KnowledgeContext, ConversationDesignState, PrototypeArtifact, PrototypeSpec, RequirementDocument } from "../src/ai/ai-vibe.types";
import { QaRuleCheckService } from "../src/ai/qa-rule-check.service";

describe("QaRuleCheckService", () => {
  const service = new QaRuleCheckService();

  it("reports blocking state, PRD, and prototype gaps independently", () => {
    const issues = service.run({
      conversationDesignState: baseState({ pages: [] }),
      prdDocument: { ...basePrd(), sections: [] },
      prototypeSpec: { ...baseSpec(), pages: [] },
      prototypeArtifact: { ...baseArtifact(), status: "failed", errorMessage: "生成失败" },
      knowledgeContext: emptyKnowledgeContext(),
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qa_state_pages_empty", checkType: "state_schema", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prd_sections_empty", checkType: "prd_completeness", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prototype_not_ready", checkType: "prototype_completeness", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prototype_spec_pages_empty", checkType: "prototype_completeness", severity: "blocking" }),
    ]));
  });

  it("detects state to PRD and state to prototype page drift", () => {
    const state = baseState({
      pages: [
        { id: "page_home", name: "签到页" },
        { id: "page_rewards", name: "奖励明细页" },
      ],
    });
    const issues = service.run({
      conversationDesignState: state,
      prdDocument: basePrd({ sections: [section({ title: "签到页", content: "签到页规则" })] }),
      prototypeSpec: baseSpec({ pages: [page({ id: "page_home", name: "签到页" })] }),
      prototypeArtifact: baseArtifact(),
      knowledgeContext: emptyKnowledgeContext(),
      checkTypes: ["state_prd_consistency", "state_prototype_consistency"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "qa_state_prd_missing_pages",
        relatedStatePaths: ["pages.page_rewards"],
      }),
      expect.objectContaining({
        id: "qa_state_prototype_missing_pages",
        relatedStatePaths: ["pages.page_rewards"],
      }),
    ]));
  });

  it("checks strong knowledge rules against current artifacts only when enabled", () => {
    const knowledgeContext: KnowledgeContext = {
      ...emptyKnowledgeContext(),
      strongRules: [
        {
          id: "rule-1",
          knowledgeId: "knowledge-1",
          title: "积分强规则",
          content: "积分奖励必须可审计且不可重复发放",
          sourceType: "knowledge_base",
        },
      ],
    };

    const issues = service.run({
      conversationDesignState: baseState(),
      prdDocument: basePrd(),
      prototypeSpec: baseSpec(),
      prototypeArtifact: baseArtifact(),
      knowledgeContext,
      checkTypes: ["knowledge_rule_compliance"],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        id: "qa_strong_rule_knowledge-1",
        checkType: "knowledge_rule_compliance",
        severity: "major",
        relatedKnowledgeIds: ["knowledge-1"],
      }),
    ]);
  });

  it("does not emit assumption risk when questions and assumptions are resolved", () => {
    const issues = service.run({
      conversationDesignState: baseState({
        pendingQuestions: [{ id: "q1", status: "answered", question: "奖励上限？" }],
        assumptions: [{ id: "a1", status: "confirmed", content: "每日一次" }],
      }),
      checkTypes: ["assumption_risk"],
    });

    expect(issues).toEqual([]);
  });
});

function baseState(overrides: Partial<ConversationDesignState> = {}): ConversationDesignState {
  return {
    id: "state-1",
    conversationId: "conversation-1",
    version: 2,
    title: "签到活动",
    summary: "签到活动需求",
    businessGoal: "提升活跃",
    targetUsers: [],
    userScenarios: [],
    pages: [{ id: "page_home", name: "签到页" }],
    features: [],
    backendConfigs: [],
    frontendRules: [],
    businessRules: [{ id: "rule_daily_once", title: "每日一次" }],
    stateRules: [],
    exceptionScenarios: [],
    acceptanceCriteria: [],
    assumptions: [{ id: "assumption_1", content: "默认积分奖励", status: "pending" }],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "prototype_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-21T08:00:00.000Z",
    updatedAt: "2026-06-21T08:00:00.000Z",
    ...overrides,
  };
}

function basePrd(overrides: Partial<RequirementDocument> = {}): RequirementDocument {
  return {
    id: "prd-1",
    conversationId: "conversation-1",
    conversationDesignStateId: "state-1",
    conversationDesignStateVersion: 2,
    title: "签到活动 PRD",
    status: "ready",
    sections: [section()],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-21T08:00:00.000Z",
    updatedAt: "2026-06-21T08:00:00.000Z",
    ...overrides,
  };
}

function section(overrides: Partial<RequirementDocument["sections"][number]> = {}): RequirementDocument["sections"][number] {
  return {
    id: "section-page-home",
    title: "签到页",
    type: "page_requirements",
    level: 1,
    order: 1,
    content: "签到页规则",
    sourcePaths: ["pages"],
    ...overrides,
  };
}

function baseSpec(overrides: Partial<PrototypeSpec> = {}): PrototypeSpec {
  return {
    id: "spec-1",
    conversationId: "conversation-1",
    conversationDesignStateId: "state-1",
    conversationDesignStateVersion: 2,
    title: "签到活动原型",
    targetDevice: "both",
    styleGuide: { tone: "clean", layoutDensity: "comfortable", borderRadius: "small" },
    pages: [page()],
    navigation: [],
    interactions: [],
    assumptions: [],
    knowledgeRefs: [],
    ...overrides,
  };
}

function page(overrides: Partial<PrototypeSpec["pages"][number]> = {}): PrototypeSpec["pages"][number] {
  return {
    id: "page_home",
    name: "签到页",
    device: "responsive",
    layout: "dashboard",
    components: [],
    sourcePaths: ["pages[0]"],
    order: 1,
    ...overrides,
  };
}

function baseArtifact(overrides: Partial<PrototypeArtifact> = {}): PrototypeArtifact {
  return {
    id: "artifact-1",
    conversationId: "conversation-1",
    prototypeSpecId: "spec-1",
    conversationDesignStateId: "state-1",
    conversationDesignStateVersion: 2,
    title: "签到活动原型",
    status: "ready",
    htmlContent: "<main>签到页</main>",
    entryFilePath: "index.html",
    targetDevice: "both",
    pageCount: 1,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-21T08:00:00.000Z",
    updatedAt: "2026-06-21T08:00:00.000Z",
    assets: [],
    ...overrides,
  };
}

function emptyKnowledgeContext(): KnowledgeContext {
  return {
    query: "",
    strongRules: [],
    defaultRules: [],
    referenceCases: [],
    designPatterns: [],
    prdWritingRules: [],
    prototypeRules: [],
    businessConcepts: [],
    conflicts: [],
    unknownAreas: [],
    summary: "无知识命中",
  };
}
