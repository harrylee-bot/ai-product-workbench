import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { firstSentence, stableId } from "../ai-vibe.helpers";
import type {
  KnowledgeContext,
  ProductDesignDraft,
  ProductDesignState,
  RequirementAnalysis,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type ProductDesignerInput = {
  userInput: string;
  requirementAnalysis: RequirementAnalysis;
  knowledgeContext: KnowledgeContext;
  existingState?: ProductDesignState;
};

@Injectable()
export class ProductDesignerAgentService extends BaseAgentService<
  ProductDesignerInput,
  ProductDesignDraft
> {
  readonly agentName = AgentName.product_designer_agent;
  readonly taskType = ModelTaskType.product_design;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: ProductDesignerInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 Product Designer Agent。基于需求、知识和分析结果生成 ProductDesignDraft JSON，必须标记 assumptions。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: ProductDesignerInput): ProductDesignDraft {
    const title = firstSentence(input.userInput, "产品需求方案").replace(/^帮我|^请|需求和原型/g, "").slice(0, 60);
    const pageId = stableId("page", title || input.userInput);

    return {
      title: title || "产品需求方案",
      background: `用户提出“${input.userInput}”，需要沉淀为可评审的产品方案。`,
      businessGoal: "明确业务目标、页面范围、状态规则和验收标准，并生成 PRD 与演示原型。",
      targetUsers: [
        {
          id: "target_user_normal",
          name: "普通用户",
          description: "完成核心业务动作的一线使用者。",
          source: { type: "ai_assumption", confidence: 0.75 },
        },
        {
          id: "target_user_operator",
          name: "运营人员",
          description: "配置规则并检查活动效果的业务人员。",
          source: { type: "ai_assumption", confidence: 0.75 },
        },
        {
          id: "target_user_reviewer",
          name: "产品评审人员",
          description: "评审 PRD、原型和 QA 一致性的协作者。",
          source: { type: "system_default", confidence: 0.8 },
        },
      ],
      userScenarios: [
        {
          id: "scenario_core_action",
          title: "用户完成核心业务动作",
          description: "用户进入核心页面，按引导完成主要操作并获得结果反馈。",
          userId: "target_user_normal",
          source: { type: "ai_assumption", confidence: 0.75 },
        },
        {
          id: "scenario_config_review",
          title: "运营配置和检查活动规则",
          description: "运营人员配置基础规则，并检查配置是否影响前端展示和验收标准。",
          userId: "target_user_operator",
          source: { type: "ai_assumption", confidence: 0.75 },
        },
        {
          id: "scenario_consistency_review",
          title: "评审 PRD 与原型一致性",
          description: "评审人员查看 PRD、原型和 QA 报告是否围绕同一 ProductDesignState。",
          userId: "target_user_reviewer",
          source: { type: "system_default", confidence: 0.8 },
        },
      ],
      pages: [
        {
          id: pageId,
          name: title || "核心页面",
          type: "h5",
          priority: "must",
          purpose: "承载用户核心流程和关键状态展示",
          components: [],
          states: ["默认", "成功", "禁用", "异常"],
          interactions: ["点击主行动按钮完成核心操作"],
          sourceStateRef: "pages[0]",
          source: { type: "ai_assumption", confidence: 0.78 },
        },
      ],
      features: [
        {
          id: "feature_core_flow",
          name: "核心流程闭环",
          description: "覆盖入口、操作、结果反馈和异常提示。",
          source: { type: "ai_assumption", confidence: 0.8 },
        },
      ],
      backendConfigs: [
        {
          id: "config_basic_rules",
          name: "基础业务规则配置",
          type: "rule",
          required: true,
          description: "配置生效时间、展示文案、状态开关、奖励或结果规则。",
          validationRules: ["关键规则缺失时不允许发布"],
          affects: ["页面状态", "前端展示规则", "验收标准"],
          source: { type: "ai_assumption", confidence: 0.8 },
        },
      ],
      frontendRules: [
        {
          id: "frontend_state_feedback",
          title: "前端状态反馈",
          description: "前端需按业务状态展示可操作、不可操作、成功和异常反馈。",
          relatedPageIds: [pageId],
          source: { type: "ai_assumption", confidence: 0.82 },
        },
      ],
      businessRules: [
        {
          id: "rule_single_source",
          title: "单一事实源",
          description: "PRD、原型和 QA 使用同一套 ProductDesignState 规则。",
          priority: "must",
          relatedPageIds: [pageId],
          source: { type: "system_default", confidence: 1 },
        },
      ],
      stateRules: [
        {
          id: "state_default",
          name: "默认",
          description: "默认可操作状态。",
          allowedActions: ["执行核心操作"],
          source: { type: "ai_assumption", confidence: 0.8 },
        },
        {
          id: "state_success",
          name: "成功",
          description: "操作成功后展示结果反馈。",
          userVisibleText: "操作成功",
          source: { type: "ai_assumption", confidence: 0.8 },
        },
        {
          id: "state_disabled",
          name: "禁用",
          description: "未满足条件时置灰并说明原因。",
          disabledActions: ["执行核心操作"],
          source: { type: "ai_assumption", confidence: 0.8 },
        },
      ],
      exceptionScenarios: [
        {
          id: "exception_network",
          title: "网络或服务异常",
          trigger: "用户操作时服务不可用或网络超时",
          expectedBehavior: "展示失败提示和重试入口。",
          userMessage: "操作失败，请稍后重试",
          relatedPageIds: [pageId],
          source: { type: "ai_assumption", confidence: 0.8 },
        },
        {
          id: "exception_rule_conflict",
          title: "配置规则冲突",
          trigger: "运营配置存在互斥或关键字段缺失",
          expectedBehavior: "阻止发布并提示运营检查。",
          source: { type: "ai_assumption", confidence: 0.78 },
        },
      ],
      acceptanceCriteria: [
        {
          id: "ac_prd_prototype_consistency",
          title: "PRD 与原型一致",
          description: "PRD 页面范围和原型页面范围一致。",
          relatedPageIds: [pageId],
          source: { type: "system_default", confidence: 1 },
        },
        {
          id: "ac_state_coverage",
          title: "核心状态覆盖",
          description: "核心状态至少覆盖默认、成功、禁用和异常。",
          relatedPageIds: [pageId],
          source: { type: "ai_assumption", confidence: 0.85 },
        },
      ],
      assumptions: [
        {
          id: "assumption_best_practice",
          content: "未命中正式知识库强规则时，按通用产品最佳实践补齐页面、状态和异常场景。",
          relatedPath: "pages",
          confidence: 0.72,
          reason: "知识库没有覆盖完整页面、状态和异常策略。",
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        ...input.requirementAnalysis.inferredByAI.map((item, index) => ({
          id: `assumption_${index + 1}`,
          content: item,
          relatedPath: "businessRules",
          confidence: 0.68,
          reason: "Requirement Analyst Agent 识别为 AI 推断。",
          status: "pending",
          createdAt: new Date().toISOString(),
        })),
      ],
      knowledgeRefs: [
        ...input.knowledgeContext.strongRules,
        ...input.knowledgeContext.defaultRules,
        ...input.knowledgeContext.referenceCases,
      ],
      pendingQuestions: input.requirementAnalysis.clarificationQuestions,
      confirmedFacts: [],
      createdBy: "system",
      updatedBy: "system",
      projectId: "",
    };
  }
}
