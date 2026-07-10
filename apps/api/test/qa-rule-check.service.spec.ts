import { describe, expect, it } from "vitest";
import { KnowledgeType } from "@prisma/client";
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
        id: "qa_state_prd_incomplete_coverage",
        relatedStatePaths: expect.arrayContaining(["pages.奖励明细页"]),
      }),
      expect.objectContaining({
        id: "qa_state_prototype_incomplete_coverage",
        relatedStatePaths: expect.arrayContaining(["pages.奖励明细页"]),
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

  it("blocks PRD content that misses required diagrams or contains forbidden interface sections", () => {
    const issues = service.run({
      prdDocument: basePrd({
        sections: [
          section({
            id: "intro",
            title: "1 引言",
            type: "overview",
            content: "签到活动背景。",
          }),
          section({
            id: "interfaces",
            title: "2.4 本需求涉及新增/修改的接口",
            type: "appendix",
            content: "接口清单。",
          }),
        ],
      }),
      checkTypes: ["prd_completeness"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qa_prd_standard_sections_missing", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prd_forbidden_interface_section", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prd_required_diagrams_missing", severity: "blocking" }),
    ]));
  });

  it("accepts the standard PRD structure with flow and architecture diagrams", () => {
    const issues = service.run({
      prdDocument: basePrd({
        sections: standardPrdSections(),
      }),
      checkTypes: ["prd_completeness"],
    });

    expect(issues).toEqual([]);
  });

  it("rejects prototype traces and incomplete design-state coverage without domain hardcoding", () => {
    const issues = service.run({
      conversationDesignState: baseState({
        title: "签到领积分活动",
        summary: "用户每日签到领取积分奖励。",
      }),
      prototypeSpec: baseSpec({
        pages: [page({ name: "签到页" })],
      }),
      prototypeArtifact: baseArtifact({
        htmlContent: [
          "<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body>",
          "<main>知识库打底：签到页</main>",
          "<section>业务覆盖：当前原型用于评审后台配置和前台预览。</section>",
          "</body></html>",
        ].join(""),
      }),
      knowledgeContext: {
        ...emptyKnowledgeContext(),
        prototypeRules: [
          {
            id: "knowledge-prototype",
            knowledgeId: "knowledge-prototype",
            title: "签到活动高保真HTML原型框架",
            content: "签到领积分活动原型必须复用 Axure HTML 原型的信息架构。",
            sourceType: "knowledge_base",
            type: KnowledgeType.prototype_asset_ref,
          },
        ],
      },
      checkTypes: ["prototype_completeness", "knowledge_rule_compliance"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qa_prototype_contains_generation_trace", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prototype_contains_review_scaffold", severity: "major" }),
      expect.objectContaining({ id: "qa_prototype_lacks_interactive_controls", severity: "major" }),
      expect.objectContaining({ id: "qa_prototype_html_incomplete_state_coverage", severity: "major" }),
      expect.objectContaining({ id: "qa_prototype_asset_ref_not_used", severity: "major" }),
    ]));
  });

  it("derives prototype framework checks from non-sign-in knowledge tables", () => {
    const issues = service.run({
      conversationDesignState: baseState({
        title: "门店预约",
        summary: "用户选择门店并提交预约。",
        pages: [{ id: "admin", name: "门店配置页" }, { id: "user", name: "预约提交页" }],
        businessRules: [{ id: "rule_capacity", title: "预约容量限制" }],
      }),
      prototypeSpec: baseSpec({
        title: "门店预约原型",
        pages: [page({ id: "admin", name: "门店配置页" }), page({ id: "user", name: "预约提交页" })],
        knowledgeRefs: [{ knowledgeId: "store-framework", title: "门店预约高保真框架" }],
      }),
      prototypeArtifact: baseArtifact({
        title: "门店预约原型",
        htmlContent: "<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body><main>后台门店配置页</main><section>前台预约提交页</section><button>提交预约</button></body></html>",
      }),
      knowledgeContext: {
        ...emptyKnowledgeContext(),
        prototypeRules: [{
          id: "store-framework",
          knowledgeId: "store-framework",
          title: "门店预约高保真框架",
          content: [
            "| 分组 | 必须字段/控件 | 页面表现 |",
            "| --- | --- | --- |",
            "| 门店设置 | 门店名称、营业时间、预约容量 | 后台表单 |",
            "| 用户预约 | 门店选择、预约日期、手机号 | 前台表单 |",
          ].join("\n"),
          sourceType: "knowledge_base",
          type: KnowledgeType.prototype_asset_ref,
        }],
      },
      checkTypes: ["prototype_completeness", "knowledge_rule_compliance"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "qa_prototype_knowledge_framework_incomplete",
        description: expect.stringContaining("门店设置"),
      }),
    ]));
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

function standardPrdSections(): RequirementDocument["sections"] {
  const titles = [
    ["intro", "1 引言", "本章说明项目背景、文档范围和使用场景。"],
    ["background", "1.1 项目背景", "签到活动用于提升用户每日活跃。"],
    ["scope", "1.2 文档范围", "覆盖后台配置、前台签到、积分发放、异常补偿和数据报表。"],
    ["usage", "1.3 使用场景（必填）", "用户通过端内渠道参与签到，运营在后台配置活动。"],
    ["business", "2 业务需求", "总体目标：通过签到领积分提升用户连续访问。"],
    ["links", "2.1 页面链接", "后台入口和前台入口均需覆盖。"],
    ["rules", "2.2 核心业务规则/功能说明", "同一用户同一自然日只能签到一次。"],
    ["flow", "2.3 核心流程/状态/页面要求", "流程覆盖运营配置、审核发布、前台签到和报表。"],
    ["acceptance", "2.4 验收标准", "重复签到不重复发积分。"],
    ["degradation", "3 业务降级方案（必填）", "积分发放失败进入补偿队列，后台支持重试。"],
    ["safety", "4 需求安全基线要求（必填）", "保留 21 行安全基线表。"],
  ] as const;
  return titles.map(([id, title, content], index) => section({
    id,
    title,
    content,
    order: index + 1,
    type: id === "flow" ? "state_rules" : "overview",
    blocks: id === "flow"
      ? [
          { id: "flow_diagram", type: "diagram", title: "产品流程图", diagramSyntax: "mermaid", content: "flowchart TD\nA[配置] --> B[签到]", sourcePaths: [] },
          { id: "arch_diagram", type: "diagram", title: "产品架构图", diagramSyntax: "mermaid", content: "flowchart LR\nA[后台] --> B[前台]", sourcePaths: [] },
        ]
      : undefined,
  }));
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
