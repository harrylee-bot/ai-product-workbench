import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { firstSentence, stableId } from "../ai-vibe.helpers";
import { agentSystemPrompt } from "../agent-charter";
import { agentSkillSystemPrompt, collectKnowledgeReferences } from "../agent-skill-instructions";
import type {
  KnowledgeContext,
  ProductBuildPlan,
  ProductDesignDraft,
  ProductDesignState,
  RequirementAnalysis,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type ProductDesignerInput = {
  userInput: string;
  requirementAnalysis: RequirementAnalysis;
  knowledgeContext: KnowledgeContext;
  productBuildPlan?: ProductBuildPlan;
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
        content: [
          agentSystemPrompt(
            this.agentName,
            "你是 Product Designer Agent。优先执行 ProductBuildPlan，把正式需求落到 ProductDesignDraft JSON，必须标记 assumptions。",
          ),
          agentSkillSystemPrompt(this.agentName, this.taskType, input.knowledgeContext),
        ].filter(Boolean).join("\n\n"),
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: ProductDesignerInput): ProductDesignDraft {
    const plan = input.productBuildPlan;
    const title = (plan?.title || firstSentence(input.userInput, "产品需求方案"))
      .replace(/^帮我|^请|需求和原型/g, "")
      .slice(0, 60);
    const pagePlan = plan?.pagePlan?.length
      ? plan.pagePlan
      : [
          {
            id: stableId("page", title || input.userInput),
            name: title || "核心页面",
            purpose: "承载用户核心流程和关键状态展示",
            priority: "must" as const,
            sourcePaths: ["pages"],
          },
        ];
    const pageId = pagePlan[0]?.id ?? stableId("page", title || input.userInput);
    const targetUsers = planToTargetUsers(plan) ?? [
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
    ];
    const userScenarios = planToScenarios(plan) ?? [
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
    ];

    return {
      title: title || "产品需求方案",
      background: plan
        ? `Product Planner Agent 已规划“${plan.title}”：${plan.summary}`
        : `用户提出“${input.userInput}”，需要沉淀为可评审的产品方案。`,
      businessGoal: plan?.goal || "明确业务目标、页面范围、状态规则和验收标准，并生成 PRD 与演示原型。",
      targetUsers,
      userScenarios,
      pages: pagePlan.map((page, index) => ({
        id: page.id,
        name: page.name,
        type: "h5",
        priority: page.priority,
        purpose: page.purpose,
        components: [],
        states: (plan?.statePlan?.length ? plan.statePlan.map((state) => state.name) : ["默认", "成功", "禁用", "异常"]),
        interactions: ["点击主行动按钮完成核心操作"],
        sourceStateRef: `pages[${index}]`,
        sourcePaths: page.sourcePaths,
        source: { type: "ai_assumption", confidence: 0.82 },
      })),
      features: [
        {
          id: "feature_core_flow",
          name: "核心流程闭环",
          description: plan?.scope.inScope.join("；") || "覆盖入口、操作、结果反馈和异常提示。",
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
        ...(planToStateRules(plan) ?? [
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
        ]),
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
        ...planQaFocusToAcceptance(plan, pageId),
      ],
      assumptions: [
        {
          id: "assumption_best_practice",
          content: plan
            ? "ProductBuildPlan 中未被用户直接确认的范围、状态和 QA 焦点按 AI 推断进入 ProductDesignState。"
            : "未命中正式知识库强规则时，按通用产品最佳实践补齐页面、状态和异常场景。",
          relatedPath: "pages",
          confidence: 0.72,
          reason: plan ? "正式需求计划包含 AI 推断项，需要后续评审确认。" : "知识库没有覆盖完整页面、状态和异常策略。",
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        ...planAssumptions(plan),
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
      knowledgeRefs: collectKnowledgeReferences(input.knowledgeContext),
      pendingQuestions: input.requirementAnalysis.clarificationQuestions,
      confirmedFacts: [],
      createdBy: "system",
      updatedBy: "system",
      projectId: "",
    };
  }

  protected fallbackMode() {
    return "deterministic_product_design_draft";
  }

  protected fallbackUserMessage() {
    return "Product Designer 模型暂时不可用，已按 ProductBuildPlan 生成规则兜底产品状态。";
  }
}

function planToTargetUsers(plan?: ProductBuildPlan) {
  if (!plan?.scope.targetUsers.length) return undefined;
  return plan.scope.targetUsers.map((name, index) => ({
    id: stableId("target_user", name),
    name,
    description: index === 0 ? "正式需求计划中的主要使用者。" : "正式需求计划中的协作或评审角色。",
    source: { type: "ai_assumption", confidence: 0.82 },
  }));
}

function planToScenarios(plan?: ProductBuildPlan) {
  if (!plan?.scope.coreScenarios.length) return undefined;
  return plan.scope.coreScenarios.map((scenario, index) => ({
    id: stableId("scenario", scenario),
    title: scenario,
    description: scenario,
    userId: index === 0 && plan.scope.targetUsers[0]
      ? stableId("target_user", plan.scope.targetUsers[0])
      : "target_user_reviewer",
    source: { type: "ai_assumption", confidence: 0.82 },
  }));
}

function planToStateRules(plan?: ProductBuildPlan) {
  if (!plan?.statePlan.length) return undefined;
  return plan.statePlan.map((state) => ({
    id: state.id,
    name: state.name,
    description: `${state.name}覆盖 ${state.coverage} 场景，${state.required ? "必须纳入 PRD、原型和 QA" : "可作为扩展状态"}。`,
    allowedActions: state.coverage === "default" || state.coverage === "success" ? ["执行核心操作"] : undefined,
    disabledActions: state.coverage === "disabled" || state.coverage === "error" ? ["执行核心操作"] : undefined,
    sourcePaths: state.sourcePaths,
    source: { type: "ai_assumption", confidence: 0.82 },
  }));
}

function planQaFocusToAcceptance(plan: ProductBuildPlan | undefined, pageId: string) {
  if (!plan?.qaFocus.length) return [];
  return plan.qaFocus.map((focus, index) => ({
    id: stableId("ac_plan_qa", `${index + 1}_${focus}`),
    title: `QA 焦点：${focus.slice(0, 24)}`,
    description: focus,
    relatedPageIds: [pageId],
    source: { type: "ai_assumption", confidence: 0.82 },
  }));
}

function planAssumptions(plan?: ProductBuildPlan) {
  if (!plan) return [];
  const assumptions = [
    ...plan.assumptions,
    ...plan.sourceSummary.assumptions,
    ...plan.sourceSummary.openQuestions.map((item) => `待确认：${item}`),
  ];
  return [...new Set(assumptions.filter(Boolean))].map((content, index) => ({
    id: `assumption_plan_${index + 1}`,
    content,
    relatedPath: "productBuildPlan",
    confidence: 0.72,
    reason: "Product Planner Agent 的计划输入尚未被用户逐条确认。",
    status: "pending",
    createdAt: new Date().toISOString(),
  }));
}
