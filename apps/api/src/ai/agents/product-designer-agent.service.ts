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
      targetUsers: ["普通用户", "运营人员", "产品评审人员"],
      userScenarios: ["用户完成核心业务动作", "运营配置和检查活动规则", "评审人员查看 PRD 与原型是否一致"],
      pages: [
        {
          id: pageId,
          name: title || "核心页面",
          purpose: "承载用户核心流程和关键状态展示",
          sourceStateRef: "pages[0]",
        },
      ],
      features: [
        {
          id: "feature_core_flow",
          name: "核心流程闭环",
          description: "覆盖入口、操作、结果反馈和异常提示。",
        },
      ],
      backendConfigs: [
        {
          id: "config_basic_rules",
          name: "基础业务规则配置",
          fields: ["生效时间", "展示文案", "状态开关", "奖励或结果配置"],
        },
      ],
      frontendRules: [
        {
          id: "frontend_state_feedback",
          description: "前端需按业务状态展示可操作、不可操作、成功和异常反馈。",
        },
      ],
      businessRules: [
        {
          id: "rule_single_source",
          description: "PRD、原型和 QA 使用同一套 ProductDesignState 规则。",
        },
      ],
      stateRules: [
        { id: "state_default", state: "default", description: "默认可操作状态。" },
        { id: "state_success", state: "success", description: "操作成功后展示结果反馈。" },
        { id: "state_disabled", state: "disabled", description: "未满足条件时置灰并说明原因。" },
      ],
      exceptionScenarios: [
        { id: "exception_network", description: "网络或服务异常时展示重试入口。" },
        { id: "exception_rule_conflict", description: "配置规则冲突时阻止发布并提示运营检查。" },
      ],
      acceptanceCriteria: [
        { id: "ac_prd_prototype_consistency", description: "PRD 页面范围和原型页面范围一致。" },
        { id: "ac_state_coverage", description: "核心状态至少覆盖默认、成功、禁用和异常。" },
      ],
      assumptions: [
        {
          id: "assumption_best_practice",
          content: "未命中正式知识库强规则时，按通用产品最佳实践补齐页面、状态和异常场景。",
          source: "ai",
        },
        ...input.requirementAnalysis.inferredByAI.map((item, index) => ({
          id: `assumption_${index + 1}`,
          content: item,
          source: "ai",
        })),
      ],
      knowledgeRefs: [
        ...input.knowledgeContext.strongRules,
        ...input.knowledgeContext.defaultRules,
        ...input.knowledgeContext.referenceCases,
      ],
      pendingQuestions: input.requirementAnalysis.clarificationQuestions,
    };
  }
}
