import { describe, expect, it } from "vitest";
import type {
  ConversationDesignState,
  RequirementDocumentDraft,
} from "../src/ai/ai-vibe.types";
import { formatRequirementDocumentDraft } from "../src/ai/requirement-document-format";

describe("requirement document fixed-format evidence handling", () => {
  it("keeps one channel table and does not promote future channels or safety template text", () => {
    const state = designState({
      title: "签到领积分活动",
      pages: [
        { id: "page_config", name: "签到领积分活动配置", description: "后台配置活动规则、展示素材和异常话术" },
        { id: "page_user", name: "用户端展示页", description: "登录会员查看今日积分并签到" },
        { id: "page_publish", name: "审核发布与异常补偿", description: "审核通过后发布上线" },
        { id: "page_report", name: "数据报表", description: "展示访问人数、签到人数和发放失败数" },
      ],
      backendConfigs: [
        { id: "config_copy", name: "展示配置", description: "配置 banner、规则标题和异常话术" },
      ],
      assumptions: [{
        id: "assumption_channel",
        content: "默认投放端内渠道，WAP/H5 与小程序按实际投放配置扩展。",
        status: "confirmed",
      }],
      confirmedFacts: [{
        id: "fact_exclusions",
        content: "本期不采集身份证或银行卡信息；不跳转第三方应用；不与第三方公司接口对接。",
      }],
      knowledgeRefs: [{
        id: "security_template",
        title: "安全基线模板",
        content: "身份证、银行卡、生物识别、第三方页面跳转、第三方公司接口和 APP、小程序均为模板候选项。",
      }],
    });
    const formatted = formatRequirementDocumentDraft(draftWithExistingTemplates(state), state, {
      author: "产品经理",
      date: "2026-07-10",
    });
    const usage = sectionContent(formatted, "usage_scenarios");
    const safetyRows = tableRows(sectionContent(formatted, "safety_baseline"));

    expect(usage.match(/活动投放的可选渠道/g)).toHaveLength(1);
    expect(usage).toContain("| 1 | 端内渠道 | ☑是 □否 |");
    expect(usage).toContain("| 2 | WAP/H5端外渠道 | □是 ☑否 |");
    expect(usage).toContain("| 3 | 小程序 | □是 ☑否 |");
    expect(safetyRows).toHaveLength(21);
    expect(new Set(safetyRows.map((row) => row.status))).toEqual(new Set(["是", "不涉及"]));
    expect(statusOf(safetyRows, "1")).toBe("是");
    expect(statusOf(safetyRows, "2")).toBe("是");
    expect(statusOf(safetyRows, "12")).toBe("不涉及");
    expect(statusOf(safetyRows, "13")).toBe("不涉及");
    expect(statusOf(safetyRows, "14")).toBe("不涉及");
    expect(statusOf(safetyRows, "15")).toBe("不涉及");
    expect(statusOf(safetyRows, "16")).toBe("不涉及");
    expect(statusOf(safetyRows, "18")).toBe("不涉及");
    expect(statusOf(safetyRows, "19")).toBe("不涉及");

    const reformatted = formatRequirementDocumentDraft(formatted, state, {
      author: "产品经理",
      date: "2026-07-10",
    });
    expect(sectionContent(reformatted, "usage_scenarios").match(/活动投放的可选渠道/g)).toHaveLength(1);
    expect(tableRows(sectionContent(reformatted, "safety_baseline"))).toEqual(safetyRows);
  });

  it("does not promote pending assumptions into channel or sensitive safety facts", () => {
    const state = designState({
      pages: [{ id: "page_admin", name: "内部运营后台", description: "员工配置预约容量" }],
      frontendRules: [{ id: "rule_internal", name: "内部状态反馈", description: "员工查看保存结果" }],
      assumptions: [{
        id: "pending_scope",
        content: "默认投放小程序并采集身份证号码。",
        status: "pending",
      }],
    });
    const formatted = formatRequirementDocumentDraft(emptyDraft(state), state);
    const usage = sectionContent(formatted, "usage_scenarios");
    const safetyRows = tableRows(sectionContent(formatted, "safety_baseline"));

    expect(usage).toContain("本期未设计端内、WAP/H5 端外或小程序投放渠道。");
    expect(usage).toContain("| 3 | 小程序 | □是 ☑否 |");
    expect(statusOf(safetyRows, "2")).toBe("不涉及");
    expect(statusOf(safetyRows, "13")).toBe("不涉及");
  });

  it("marks channels and safety rows when design state contains explicit current requirements", () => {
    const state = designState({
      confirmedFacts: [{
        id: "fact_channels",
        content: "首期发布到 WAP/H5 端外渠道和小程序。",
      }],
      features: [
        { id: "feature_identity", name: "实名资料提交", description: "前台采集身份证号码并再次获取用户主动授权" },
        { id: "feature_jump", name: "合作服务入口", description: "用户点击入口后跳转第三方应用" },
        { id: "feature_api", name: "积分服务对接", description: "新增与第三方公司积分 API 接口对接并传输用户信息" },
      ],
    });
    const formatted = formatRequirementDocumentDraft(emptyDraft(state), state);
    const usage = sectionContent(formatted, "usage_scenarios");
    const coreRules = sectionContent(formatted, "core_rules");
    const safetyRows = tableRows(sectionContent(formatted, "safety_baseline"));

    expect(usage).toContain("| 1 | 端内渠道 | □是 ☑否 |");
    expect(usage).toContain("| 2 | WAP/H5端外渠道 | ☑是 □否 |");
    expect(usage).toContain("| 3 | 小程序 | ☑是 □否 |");
    for (const index of ["12", "13", "15", "16", "17", "18"]) {
      expect(statusOf(safetyRows, index)).toBe("是");
    }
    expect(coreRules).toContain("再次取得用户主动授权");
    expect(coreRules).toContain("第三方页面或应用跳转");
    expect(coreRules).toContain("第三方接口或数据交互");
  });

  it("honors explicit structured channel selections without treating option lists as selections", () => {
    const state = designState({
      backendConfigs: [{
        id: "channel_config",
        name: "渠道配置",
        app: true,
        h5: false,
        miniProgram: false,
        availableChannels: ["端内", "H5", "小程序"],
      }],
      confirmedFacts: [{
        id: "fact_negative_channels",
        content: "H5 暂不投放，小程序为后续候选渠道。",
      }],
    });
    const formatted = formatRequirementDocumentDraft(emptyDraft(state), state);
    const usage = sectionContent(formatted, "usage_scenarios");

    expect(usage).toContain("| 1 | 端内渠道 | ☑是 □否 |");
    expect(usage).toContain("| 2 | WAP/H5端外渠道 | □是 ☑否 |");
    expect(usage).toContain("| 3 | 小程序 | □是 ☑否 |");
  });
});

function designState(overrides: Partial<ConversationDesignState> = {}): ConversationDesignState {
  return {
    id: "state-1",
    conversationId: "conversation-1",
    version: 1,
    title: "活动需求",
    summary: "运营配置活动，用户参与后获得结果反馈。",
    businessGoal: "形成活动配置、参与和复盘闭环。",
    targetUsers: [{ id: "target_user", name: "活动用户", description: "参与活动的用户" }],
    userScenarios: [{ id: "scenario", name: "参与活动", description: "用户进入活动页完成操作" }],
    pages: [{ id: "page", name: "用户端活动页", description: "面向会员展示活动和操作结果" }],
    features: [{ id: "feature", name: "参与活动", description: "提交操作并展示结果" }],
    backendConfigs: [],
    frontendRules: [{ id: "frontend_rule", name: "结果反馈", description: "成功或失败均展示明确反馈" }],
    businessRules: [{ id: "business_rule", name: "参与限制", description: "按活动规则校验参与资格" }],
    stateRules: [{ id: "state_rule", name: "已完成", description: "操作成功后的状态" }],
    exceptionScenarios: [{ id: "exception", name: "提交失败", description: "保留失败原因并允许重试" }],
    acceptanceCriteria: [{ id: "acceptance", name: "结果校验", description: "页面结果和业务记录一致" }],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "prd_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function emptyDraft(state: ConversationDesignState): RequirementDocumentDraft {
  return {
    conversationId: state.conversationId,
    title: state.title,
    sections: [],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
  };
}

function draftWithExistingTemplates(state: ConversationDesignState): RequirementDocumentDraft {
  return {
    ...emptyDraft(state),
    sections: [
      {
        id: "source_scenarios",
        title: "使用场景",
        type: "user_scenarios",
        level: 2,
        order: 1,
        content: [
          "运营配置活动并审核发布，用户从端内活动页进入并完成签到。",
          "",
          "| 序号 | 活动投放的可选渠道 | 是否投放 |",
          "| --- | --- | --- |",
          "| 1 | 端内渠道 | ☑是 □否 |",
          "| 2 | WAP/H5端外渠道 | □是 ☑否 |",
          "| 3 | 小程序 | □是 ☑否 |",
          "",
          "| 序号 | 活动投放的可选渠道 | 是否投放 |",
          "| --- | --- | --- |",
          "| 1 | 端内渠道 | ☑是 □否 |",
          "| 2 | WAP/H5端外渠道 | ☑是 □否 |",
          "| 3 | 小程序 | ☑是 □否 |",
        ].join("\n"),
        sourcePaths: ["userScenarios"],
      },
      {
        id: "source_rules",
        title: "核心业务规则",
        type: "business_rules",
        level: 2,
        order: 2,
        content: [
          "活动按配置时间和用户资格执行。",
          "",
          "| 序号 | 需求安全基线内容 | 范围 | 是否涉及 |",
          "| --- | --- | --- | --- |",
          "| 12 | 如涉及加载到APP或小程序，应实现双清单功能 | 前端 | 是 |",
          "| 13 | 采集身份证号码、银行卡信息和生物识别时再次授权 | 前端 | 是 |",
          "| 15 | 跳转第三方页面或应用时弹窗提示 | 前端 | 是 |",
          "| 16 | 与第三方公司接口对接进行数据交互 | 前后台 | 是 |",
        ].join("\n"),
        sourcePaths: ["businessRules"],
      },
      {
        id: "old_safety_baseline",
        title: "需求安全基线要求",
        type: "appendix",
        level: 1,
        order: 3,
        content: "身份证、银行卡、生物识别、第三方页面、第三方接口、APP 和小程序。",
        sourcePaths: ["safetyBaseline"],
      },
    ],
  };
}

function sectionContent(draft: RequirementDocumentDraft, id: string) {
  return draft.sections.find((section) => section.id === id)?.content ?? "";
}

function tableRows(content: string) {
  return content.split("\n").flatMap((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!/^\d+$/.test(cells[0] ?? "") || cells.length !== 4) return [];
    return [{ index: cells[0], status: cells[3] }];
  });
}

function statusOf(rows: Array<{ index: string; status: string }>, index: string) {
  return rows.find((row) => row.index === index)?.status;
}
