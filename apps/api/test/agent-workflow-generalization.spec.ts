import { KnowledgeType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type {
  ConversationDesignState,
  KnowledgeContext,
  PrototypeArtifact,
  PrototypeSpec,
  RequirementDocumentDraft,
} from "../src/ai/ai-vibe.types";
import { QaRuleCheckService } from "../src/ai/qa-rule-check.service";
import { formatRequirementDocumentDraft } from "../src/ai/requirement-document-format";

describe("agent workflow domain generalization", () => {
  const qa = new QaRuleCheckService();

  for (const scenario of scenarios()) {
    it(`generates a fixed-format PRD and knowledge-driven front/back prototype for ${scenario.name}`, () => {
      const draft: RequirementDocumentDraft = {
        conversationId: scenario.state.conversationId,
        title: scenario.state.title,
        sections: [],
        knowledgeRefs: [],
        assumptions: [],
        pendingQuestions: [],
        validationNotes: [],
      };
      const prd = formatRequirementDocumentDraft(draft, scenario.state, {
        author: "产品经理",
        date: "2026-07-10",
      });
      const prdText = prd.sections.map((section) => [
        section.title,
        section.content,
        ...(section.blocks ?? []).map((block) => `${block.title ?? ""}\n${block.content}`),
      ].join("\n")).join("\n");

      expect(prd.title).toBe(`${scenario.name}需求说明书`);
      expect(prd.sections.map((section) => section.title)).toEqual(expect.arrayContaining([
        "版 本 历 史",
        "目 录",
        "1 引言",
        "2 业务需求",
        "3 业务降级方案（必填）",
        "4 需求安全基线要求（必填）",
      ]));
      expect(prdText).toContain("产品流程图");
      expect(prdText).toContain("产品架构图");
      for (const label of scenario.requiredLabels) expect(prdText).toContain(label);
      for (const leaked of scenario.forbiddenLeaks) expect(prdText).not.toContain(leaked);
      expect(prdText).not.toContain("本需求涉及新增/修改的接口");

      const issues = qa.run({
        conversationDesignState: scenario.state,
        prototypeSpec: scenario.spec,
        prototypeArtifact: scenario.artifact,
        knowledgeContext: scenario.knowledge,
        checkTypes: ["prototype_completeness", "knowledge_rule_compliance"],
      });
      expect(issues).toEqual([]);
    });
  }
});

type Scenario = {
  name: string;
  state: ConversationDesignState;
  spec: PrototypeSpec;
  artifact: PrototypeArtifact;
  knowledge: KnowledgeContext;
  requiredLabels: string[];
  forbiddenLeaks: string[];
};

function scenarios(): Scenario[] {
  return [
    scenario({
      slug: "store-booking",
      name: "门店预约",
      goal: "提升到店预约转化并控制门店接待容量。",
      pages: ["门店配置页", "预约提交页"],
      feature: "提交预约",
      backendConfig: "预约容量",
      frontendRule: "提交反馈",
      businessRule: "容量限制",
      stateRule: "已预约",
      exception: "时段已满",
      acceptance: "容量校验",
      frameworkRows: [
        ["门店设置", "门店名称、营业时间、预约容量"],
        ["用户预约", "门店选择、预约日期、手机号"],
      ],
      extraHtml: "门店名称 营业时间 门店选择 预约日期 手机号",
      forbiddenLeaks: ["签到", "积分", "素材标签"],
    }),
    scenario({
      slug: "asset-review",
      name: "素材库审核",
      goal: "统一管理营销素材并确保前台使用的素材先审后发。",
      pages: ["素材管理页", "素材预览页"],
      feature: "上传素材",
      backendConfig: "标签管理",
      frontendRule: "素材预览",
      businessRule: "先审后发",
      stateRule: "待审核",
      exception: "格式不支持",
      acceptance: "审核流转",
      frameworkRows: [
        ["素材管理", "素材名称、素材标签、上传文件"],
        ["审核预览", "审核意见、预览区域、发布状态"],
      ],
      extraHtml: "素材名称 素材标签 上传文件 审核意见 预览区域 发布状态",
      forbiddenLeaks: ["签到", "积分", "预约容量"],
    }),
    scenario({
      slug: "coupon-redemption",
      name: "优惠券核销",
      goal: "完成优惠券配置、用户领取、门店核销和异常对账闭环。",
      pages: ["券配置页", "用户券包页"],
      feature: "领取优惠券",
      backendConfig: "库存上限",
      frontendRule: "核销结果",
      businessRule: "单用户限领",
      stateRule: "已核销",
      exception: "库存不足",
      acceptance: "重复领取限制",
      frameworkRows: [
        ["券配置", "券名称、有效期、库存上限"],
        ["用户券包", "领取按钮、核销码、核销结果"],
      ],
      extraHtml: "券名称 有效期 领取按钮 核销码",
      forbiddenLeaks: ["签到", "预约日期", "素材标签"],
    }),
  ];
}

function scenario(input: {
  slug: string;
  name: string;
  goal: string;
  pages: [string, string];
  feature: string;
  backendConfig: string;
  frontendRule: string;
  businessRule: string;
  stateRule: string;
  exception: string;
  acceptance: string;
  frameworkRows: Array<[string, string]>;
  extraHtml: string;
  forbiddenLeaks: string[];
}): Scenario {
  const conversationId = `conversation-${input.slug}`;
  const stateId = `state-${input.slug}`;
  const knowledgeId = `framework-${input.slug}`;
  const state: ConversationDesignState = {
    id: stateId,
    conversationId,
    version: 1,
    title: input.name,
    summary: input.goal,
    businessGoal: input.goal,
    targetUsers: [{ id: "target", name: "目标用户", description: "使用本业务能力的用户" }],
    userScenarios: [{ id: "scenario", title: "核心使用场景", description: input.goal }],
    pages: input.pages.map((name, index) => ({ id: `page-${index + 1}`, name, description: `${name}业务职责` })),
    features: [{ id: "feature", name: input.feature, description: `${input.feature}成功后生成业务记录` }],
    backendConfigs: [{ id: "config", name: input.backendConfig, description: `运营维护${input.backendConfig}` }],
    frontendRules: [{ id: "front-rule", title: input.frontendRule, description: `前台展示${input.frontendRule}` }],
    businessRules: [{ id: "business-rule", title: input.businessRule, description: `${input.businessRule}必须生效` }],
    stateRules: [{ id: "state-rule", name: input.stateRule, description: `业务状态为${input.stateRule}` }],
    exceptionScenarios: [{ id: "exception", title: input.exception, expectedBehavior: `明确提示${input.exception}` }],
    acceptanceCriteria: [{ id: "acceptance", title: input.acceptance, description: `${input.acceptance}可被测试验证` }],
    assumptions: [],
    knowledgeRefs: [{ knowledgeId, title: `${input.name}高保真框架` }],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "prototype_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
  const spec: PrototypeSpec = {
    id: `spec-${input.slug}`,
    conversationId,
    conversationDesignStateId: stateId,
    conversationDesignStateVersion: 1,
    title: `${input.name}原型`,
    targetDevice: "both",
    styleGuide: { tone: "business", layoutDensity: "compact", borderRadius: "small" },
    pages: input.pages.map((name, index) => ({
      id: `page-${index + 1}`,
      name,
      device: "responsive",
      layout: index === 0 ? "dashboard" : "mobile_page",
      components: [{
        id: `component-${index + 1}`,
        name: index === 0 ? input.backendConfig : input.feature,
        type: index === 0 ? "form" : "button",
        sourcePaths: [index === 0 ? "backendConfigs" : "features"],
      }],
      states: [{ id: `state-${index + 1}`, name: index === 0 ? input.stateRule : input.exception, description: "关键状态", sourcePaths: ["stateRules"] }],
      sourcePaths: ["pages"],
      order: index + 1,
    })),
    navigation: [],
    interactions: [],
    assumptions: [],
    knowledgeRefs: [{ knowledgeId, title: `${input.name}高保真框架` }],
  };
  const html = [
    "<!doctype html><html lang=\"zh-CN\"><head><style>",
    "*{box-sizing:border-box}body{font-family:sans-serif;margin:0}.layout{display:grid;grid-template-columns:220px 1fr}.panel{padding:16px;border:1px solid #ddd}table{width:100%}",
    "</style></head><body><div class=\"layout\"><aside>运营后台 管理导航</aside><main>",
    `<section class="panel"><h1>${input.pages[0]}</h1><form><label>${input.backendConfig}</label><input><select><option>${input.stateRule}</option></select><button>保存</button></form><div>${input.businessRule}</div></section>`,
    `<section class="panel"><h2>前台用户页面 ${input.pages[1]}</h2><button>${input.feature}</button><div>${input.frontendRule}</div><div>${input.exception}</div></section>`,
    `<section class="panel"><table><tr><th>数据明细</th></tr><tr><td>${input.acceptance}</td></tr></table>${input.extraHtml}</section>`,
    "</main></div></body></html>",
  ].join("");
  const artifact: PrototypeArtifact = {
    id: `artifact-${input.slug}`,
    conversationId,
    prototypeSpecId: spec.id,
    conversationDesignStateId: stateId,
    conversationDesignStateVersion: 1,
    title: spec.title,
    status: "ready",
    htmlContent: html,
    entryFilePath: "index.html",
    targetDevice: "both",
    pageCount: spec.pages.length,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    assets: [],
  };
  const knowledge: KnowledgeContext = {
    query: input.name,
    strongRules: [],
    defaultRules: [],
    referenceCases: [],
    designPatterns: [],
    prdWritingRules: [],
    prototypeRules: [{
      id: knowledgeId,
      knowledgeId,
      title: `${input.name}高保真框架`,
      content: [
        "| 分组 | 必须字段/控件 | 页面表现 |",
        "| --- | --- | --- |",
        ...input.frameworkRows.map(([group, fields]) => `| ${group} | ${fields} | 前后台页面联动 |`),
      ].join("\n"),
      sourceType: "knowledge_base",
      type: KnowledgeType.prototype_asset_ref,
    }],
    businessConcepts: [],
    conflicts: [],
    unknownAreas: [],
    summary: `${input.name}知识框架`,
  };
  return {
    name: input.name,
    state,
    spec,
    artifact,
    knowledge,
    requiredLabels: [input.pages[0], input.pages[1], input.feature, input.backendConfig, input.businessRule, input.stateRule, input.exception, input.acceptance],
    forbiddenLeaks: input.forbiddenLeaks,
  };
}
