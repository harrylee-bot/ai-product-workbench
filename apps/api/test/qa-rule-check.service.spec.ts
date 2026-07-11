import { describe, expect, it } from "vitest";
import { KnowledgeType } from "@prisma/client";
import type { KnowledgeContext, ConversationDesignState, PrototypeArtifact, PrototypeSpec, RequirementDocument } from "../src/ai/ai-vibe.types";
import { extractKnowledgeFrameworkRequirements } from "../src/ai/knowledge-framework-checklist";
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

  it("accepts semantically aligned evidence without requiring identical entity labels", () => {
    const state = baseState({
      pages: [{ name: "签到活动配置页", description: "配置活动规则和页面素材。" }],
      features: [{ name: "页面展示配置", description: "配置 banner、背景色和规则入口。" }],
      backendConfigs: [{ name: "积分权益", fields: "单次积分、每日额度、总额度。" }],
      businessRules: [{ name: "自然日规则", rule: "按北京时间自然日统计，每日一次。" }],
      exceptionScenarios: [{ name: "积分账本超时", handling: "进入补偿中并支持重试。" }],
      acceptanceCriteria: [{ name: "签到幂等验收", criteria: "重复点击只发放一次积分。" }],
    });
    const prd = basePrd({
      sections: [section({
        title: "业务方案",
        content: "后台活动配置包含 Banner、背景色和规则入口，支持单次积分、每日额度和总额度。按北京时间每日限领一次；积分发放超时进入补偿队列并可重试，重复点击只产生一次积分发放。",
      })],
    });
    const spec = baseSpec({
      pages: [page({
        name: "活动配置工作台",
        components: [
          { id: "display", name: "展示素材配置", type: "form_group", sourcePaths: [] },
          { id: "points", name: "北京时间每日签到规则与积分额度表", type: "editable_table", sourcePaths: [] },
          { id: "retry", name: "发放失败补偿队列", type: "data_table", sourcePaths: [] },
        ],
        states: [{ id: "timeout", name: "超时重试", description: "发放失败后进入补偿中并支持重试。", sourcePaths: [] }],
      })],
    });

    const issues = service.run({
      conversationDesignState: state,
      prdDocument: prd,
      prototypeSpec: spec,
      checkTypes: ["state_prd_consistency", "state_prototype_consistency"],
    });

    expect(issues).toEqual([]);
  });

  it("matches PrototypeSpec against visible semantic evidence while retaining the coverage threshold", () => {
    const issues = service.run({
      conversationDesignState: baseState({ pages: [{ name: "活动配置工作台" }] }),
      prototypeSpec: baseSpec({
        pages: [page({
          name: "活动配置工作台",
          components: [
            { id: "nav", name: "侧边导航", type: "navigation", sourcePaths: [] },
            { id: "display", name: "展示配置上传位", type: "upload_panel", sourcePaths: [] },
            { id: "filter", name: "报表筛选", type: "filter_form", sourcePaths: [] },
            { id: "metrics", name: "指标卡", type: "metric_cards", sourcePaths: [] },
          ],
        })],
      }),
      prototypeArtifact: baseArtifact({
        htmlContent: [
          "<!doctype html><html><head><style>body{font-family:sans-serif}button,select{font-size:14px}</style></head><body>",
          "<nav>活动工作台</nav><main><h1>后台活动配置</h1>",
          "<section>页面展示素材 <button>上传 Banner</button></section>",
          "<section>数据报表筛选条件 <select><option>全部</option></select><b>核心指标：访问人数</b></section>",
          "<section>前台用户页面 <button>立即签到</button></section></main></body></html>",
        ].join(""),
      }),
      knowledgeContext: emptyKnowledgeContext(),
      checkTypes: ["prototype_completeness"],
    });

    expect(issues.map((item) => item.id)).not.toContain("qa_prototype_html_incomplete_spec_coverage");
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

  it("rejects duplicate or semantically unsupported channel selections and unsupported safety claims", () => {
    const sections = standardPrdSections();
    const usage = sections.find((item) => item.id === "usage");
    const safety = sections.find((item) => item.id === "safety");
    if (!usage || !safety) throw new Error("standard PRD fixtures are incomplete");
    usage.content = [
      usage.content.replace("| 2 | WAP/H5端外渠道 | □是 ☑否 |", "| 2 | WAP/H5端外渠道 | ☑是 □否 |"),
      channelTable({ endpoint: true, h5: true, miniProgram: true }),
    ].join("\n\n");
    safety.content = safety.content.replace(
      /\| 13 \| (前台页面采集身份证号码、身份证照片、生物识别或银行卡信息) \| ([^|]+) \| 不涉及 \|/,
      "| 13 | $1 | $2 | 是 |",
    );

    const issues = service.run({
      prdDocument: basePrd({ sections }),
      checkTypes: ["prd_completeness"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qa_prd_channel_table_invalid", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prd_channel_scope_conflict", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prd_safety_evidence_conflict", severity: "blocking" }),
    ]));
  });

  it("rejects sensitive behavior that the safety table marks as not applicable", () => {
    const sections = standardPrdSections();
    const rules = sections.find((item) => item.id === "rules");
    if (!rules) throw new Error("rules fixture is missing");
    rules.content += "\n前台页面采集身份证号码，并在用户主动授权后提交。";

    const issues = service.run({
      prdDocument: basePrd({ sections }),
      checkTypes: ["prd_completeness"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qa_prd_safety_evidence_conflict", severity: "blocking" }),
    ]));
  });

  it("evaluates channel evidence per clause instead of letting another channel's negative text win", () => {
    const sections = standardPrdSections();
    const usage = sections.find((item) => item.id === "usage");
    if (!usage) throw new Error("usage fixture is missing");
    usage.content = [
      "端内渠道支持本期投放，H5 和小程序不支持。",
      channelTable({ endpoint: true, h5: false, miniProgram: false }),
    ].join("\n\n");

    const issues = service.run({
      prdDocument: basePrd({ sections }),
      checkTypes: ["prd_completeness"],
    });

    expect(issues.map((item) => item.id)).not.toContain("qa_prd_channel_scope_conflict");
  });

  it("rejects a 21-row table whose row meanings do not match the canonical baseline", () => {
    const sections = standardPrdSections();
    const safety = sections.find((item) => item.id === "safety");
    if (!safety) throw new Error("safety fixture is missing");
    safety.content = safety.content.replace(
      "| 8 | 未接入4A时满足安全要求 | 信息系统 | 不涉及 |",
      "| 8 | 任意占位安全条目 | 信息系统 | 不涉及 |",
    );

    const issues = service.run({
      prdDocument: basePrd({ sections }),
      checkTypes: ["prd_completeness"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qa_prd_safety_baseline_invalid", severity: "blocking" }),
    ]));
  });

  it("requires all 21 safety rows in sequence", () => {
    const sections = standardPrdSections();
    const safety = sections.find((item) => item.id === "safety");
    if (!safety) throw new Error("safety fixture is missing");
    safety.content = safety.content.replace(/\n\| 21 \|[^\n]+$/, "");

    const issues = service.run({
      prdDocument: basePrd({ sections }),
      checkTypes: ["prd_completeness"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qa_prd_safety_baseline_invalid", severity: "blocking" }),
    ]));
  });

  it("rejects a selected channel when the non-table PRD body has no design evidence", () => {
    const sections = standardPrdSections();
    const usage = sections.find((item) => item.id === "usage");
    if (!usage) throw new Error("usage fixture is missing");
    usage.content = usage.content.replace(
      "| 2 | WAP/H5端外渠道 | □是 ☑否 |",
      "| 2 | WAP/H5端外渠道 | ☑是 □否 |",
    );

    const issues = service.run({
      prdDocument: basePrd({ sections }),
      checkTypes: ["prd_completeness"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "qa_prd_channel_scope_conflict",
        severity: "blocking",
        description: expect.stringContaining("WAP/H5端外渠道"),
      }),
    ]));
    expect(issues.map((item) => item.id)).not.toContain("qa_prd_channel_table_invalid");
  });

  it("blocks standalone-looking prototypes that have no mobile or interaction contract", () => {
    const issues = service.run({
      conversationDesignState: baseState(),
      prototypeSpec: baseSpec(),
      prototypeArtifact: baseArtifact({
        htmlContent: "<!doctype html><html><head><meta name=\"viewport\"><style>body{display:grid}</style></head><body><main>后台签到页</main><section>前台用户页面</section><button>立即签到</button></body></html>",
      }),
      knowledgeContext: emptyKnowledgeContext(),
      checkTypes: ["prototype_completeness"],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qa_prototype_invalid_viewport", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prototype_mobile_css_missing", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prototype_horizontal_overflow_unprotected", severity: "blocking" }),
      expect.objectContaining({ id: "qa_prototype_key_actions_not_interactive", severity: "blocking" }),
    ]));
  });

  it("accepts valid viewport, mobile overflow guards, and script-backed key actions", () => {
    const issues = service.run({
      conversationDesignState: baseState(),
      prototypeSpec: baseSpec(),
      prototypeArtifact: baseArtifact({ htmlContent: responsiveInteractivePrototypeHtml() }),
      knowledgeContext: emptyKnowledgeContext(),
      checkTypes: ["prototype_completeness"],
    });
    const issueIds = issues.map((item) => item.id);

    expect(issueIds).not.toContain("qa_prototype_invalid_viewport");
    expect(issueIds).not.toContain("qa_prototype_mobile_css_missing");
    expect(issueIds).not.toContain("qa_prototype_horizontal_overflow_unprotected");
    expect(issueIds).not.toContain("qa_prototype_key_actions_not_interactive");
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
  it("extracts core framework tables and ignores explicitly optional tables", () => {
    expect(extractKnowledgeFrameworkRequirements([
      "| 分组 | 必须字段/控件 | 页面表现 |",
      "| --- | --- | --- |",
      "| 活动设置 | 活动名称、活动时间 | 后台表单 |",
      "",
      "| 按需分组 | 按需字段/控件 | 适用条件 |",
      "| --- | --- | --- |",
      "| 跳转设置 | 第三方链接、小程序 | 配置跳转时 |",
    ].join("\n"))).toEqual([
      { group: "活动设置", terms: ["活动名称", "活动时间"] },
    ]);
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
    ["usage", "1.3 使用场景（必填）", `用户通过端内渠道参与签到，运营在后台配置活动。\n\n${channelTable({ endpoint: true, h5: false, miniProgram: false })}`],
    ["business", "2 业务需求", "总体目标：通过签到领积分提升用户连续访问。"],
    ["links", "2.1 页面链接", "后台入口和前台入口均需覆盖。"],
    ["rules", "2.2 核心业务规则/功能说明", "同一用户同一自然日只能签到一次。"],
    ["flow", "2.3 核心流程/状态/页面要求", "流程覆盖运营配置、审核发布、前台签到和报表。"],
    ["acceptance", "2.4 验收标准", "重复签到不重复发积分。"],
    ["degradation", "3 业务降级方案（必填）", "积分发放失败进入补偿队列，后台支持重试。"],
    ["safety", "4 需求安全基线要求（必填）", safetyBaselineTable()],
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

function channelTable(input: { endpoint: boolean; h5: boolean; miniProgram: boolean }) {
  const selection = (selected: boolean) => selected ? "☑是 □否" : "□是 ☑否";
  return [
    "| 序号 | 活动投放的可选渠道 | 是否投放 |",
    "| --- | --- | --- |",
    `| 1 | 端内渠道 | ${selection(input.endpoint)} |`,
    `| 2 | WAP/H5端外渠道 | ${selection(input.h5)} |`,
    `| 3 | 小程序 | ${selection(input.miniProgram)} |`,
  ].join("\n");
}

function safetyBaselineTable() {
  const labels = [
    "新开发功能接口或现有功能接口逻辑变动",
    "业务功能面向公众用户",
    "新开通公网暴露面",
    "管理后台个人信息脱敏展示",
    "管理后台水印功能",
    "管理后台查询条件限制",
    "管理后台接入4A统一管理",
    "未接入4A时满足安全要求",
    "后台配置内容敏感词过滤",
    "前台展示内容先审后发",
    "展示隐私政策并获取用户同意",
    "APP或小程序双清单",
    "前台页面采集身份证号码、身份证照片、生物识别或银行卡信息",
    "免密登录需用户同意隐私政策",
    "跳转第三方页面或应用",
    "与第三方公司接口对接进行数据交互",
    "新增API接口台账填报",
    "用户敏感信息或跨系统API加密传输",
    "用户信息或重要数据加密存储",
    "数据采集规范",
    "采集数据完整性和一致性校验",
  ];
  return [
    "安全基线自查如下。",
    "",
    "| 序号 | 需求安全基线内容 | 范围 | 是否涉及 |",
    "| --- | --- | --- | --- |",
    ...labels.map((label, index) => `| ${index + 1} | ${label} | 信息系统 | ${index < 2 ? "是" : "不涉及"} |`),
  ].join("\n");
}

function responsiveInteractivePrototypeHtml() {
  return [
    "<!doctype html><html><head>",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<style>html,body{overflow-x:hidden}.table-wrap{max-width:100%;overflow-x:auto}.app{display:grid}@media(max-width:768px){.app{display:block}}</style>",
    "</head><body><main class=\"app\"><section>后台签到页 每日一次</section><section>前台用户页面</section>",
    "<div class=\"table-wrap\"><table><tr><td>签到记录</td></tr></table></div><button>立即签到</button></main>",
    "<script>document.querySelectorAll(\"button\").forEach((button)=>button.addEventListener(\"click\",()=>{button.textContent=\"今日已签到\";}));</script>",
    "</body></html>",
  ].join("");
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
