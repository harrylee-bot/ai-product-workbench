import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType, UserIntent } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { firstSentence, stableId } from "../ai-vibe.helpers";
import { agentSystemPrompt } from "../agent-charter";
import { agentSkillSystemPrompt, collectKnowledgeReferences } from "../agent-skill-instructions";
import type {
  KnowledgeContext,
  ProductBuildPlan,
  ProductBuildPlanPriority,
  ProductBuildPlanStateCoverage,
  ProductDesignState,
  RequirementAnalysis,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type ProductPlannerInput = {
  userInput: string;
  intent: UserIntent;
  requirementAnalysis: RequirementAnalysis;
  knowledgeContext: KnowledgeContext;
  existingState?: ProductDesignState;
};

@Injectable()
export class ProductPlannerAgentService extends BaseAgentService<
  ProductPlannerInput,
  ProductBuildPlan
> {
  readonly agentName = AgentName.product_planner_agent;
  readonly taskType = ModelTaskType.product_planning;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: ProductPlannerInput) {
    return [
      {
        role: "system" as const,
        content: [
          agentSystemPrompt(
            this.agentName,
            "你是 Product Planner Agent。你是正式需求唯一 plan agent，只为正式需求输出 ProductBuildPlan JSON。局部修改的计划属于 Patch Agent 的 PatchPlan；你不得生成 PRD、HTML，也不得直接修改 ProductDesignState。",
          ),
          agentSkillSystemPrompt(this.agentName, this.taskType, input.knowledgeContext),
        ].filter(Boolean).join("\n\n"),
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: ProductPlannerInput): ProductBuildPlan {
    const title = normalizeTitle(input);
    const pagePlan = inferPagePlan(input, title);
    const statePlan = inferStatePlan();
    const userFacts = unique([
      ...input.requirementAnalysis.knownFromUser,
      input.userInput.length ? `用户原始需求：${input.userInput}` : "",
    ]);
    const knowledgeFacts = unique([
      ...input.requirementAnalysis.knownFromKnowledge,
      ...knowledgeReferences(input.knowledgeContext).map((item) => item.title),
    ]);
    const skillNames = input.knowledgeContext.agentSkills?.map((skill) => skill.name) ?? [];
    const skillInputs = skillNames.length ? ["VibeCodingSkillInstructions"] : [];
    const assumptions = unique([
      ...input.requirementAnalysis.inferredByAI,
      "正式需求先落 ProductBuildPlan，再落 ProductDesignState，PRD、原型和 QA 均从同一 State 再生成。",
      skillNames.length ? `本轮需按 Vibe Coding Skills 执行：${skillNames.join("、")}` : "",
    ]);
    const openQuestions = unique([
      ...input.requirementAnalysis.missingCritical,
      ...input.requirementAnalysis.clarificationQuestions.map((item) => item.title || item.reason),
      ...input.knowledgeContext.unknownAreas,
    ]);

    return {
      id: stableId("product_build_plan", `${input.intent}_${title}_${input.userInput}`),
      projectId: input.existingState?.projectId ?? "",
      title,
      goal: input.existingState?.businessGoal || inferGoal(input),
      summary: "正式需求由 Product Planner 先规划执行范围、页面与状态覆盖，再由 Product Designer 写入 ProductDesignState；局部修改另走 PatchPlan。",
      requirementMode: requirementModeFromIntent(input.intent),
      sourceSummary: {
        userFacts,
        knowledgeFacts,
        assumptions,
        openQuestions,
      },
      scope: {
        inScope: inferInScope(input, pagePlan),
        outOfScope: ["接口实现", "数据库设计", "部署方案", "生产代码交付"],
        targetUsers: inferTargetUsers(input),
        coreScenarios: inferCoreScenarios(input),
      },
      pagePlan,
      statePlan,
      deliverables: {
        productDesignState: true,
        prd: true,
        prototypeSpec: true,
        htmlPrototype: true,
        qa: true,
        knowledgeCandidates: true,
      },
      agentSequence: [
        {
          agentName: AgentName.product_planner_agent,
          step: ModelTaskType.product_planning,
          input: stepInputs(skillInputs, "IntentResult", "RequirementAnalysis", "KnowledgeContext", "existing ProductDesignState"),
          output: "ProductBuildPlan",
          gate: "正式需求计划必须只描述执行方案，不直接写 PRD/HTML/State，也不规划局部 PatchPlan。",
        },
        {
          agentName: AgentName.product_designer_agent,
          step: ModelTaskType.product_design,
          input: stepInputs(skillInputs, "ProductBuildPlan", "RequirementAnalysis", "KnowledgeContext"),
          output: "ProductDesignDraft",
          gate: "所有业务修改必须先落到 ProductDesignState。",
        },
        {
          agentName: AgentName.prd_writer_agent,
          step: ModelTaskType.prd_generation,
          input: stepInputs(skillInputs, "ProductDesignState"),
          output: "RequirementDocumentDraft",
          gate: "只允许从 ProductDesignState 渲染 PRD。",
        },
        {
          agentName: AgentName.prototype_designer_agent,
          step: ModelTaskType.prototype_design,
          input: stepInputs(skillInputs, "ProductDesignState"),
          output: "PrototypeSpec",
          gate: "只允许从 ProductDesignState 生成原型结构。",
        },
        {
          agentName: AgentName.prototype_code_agent,
          step: ModelTaskType.prototype_code_generation,
          input: stepInputs(skillInputs, "PrototypeSpec"),
          output: "PrototypeArtifactDraft",
          gate: "只允许从 PrototypeSpec 生成离线 HTML 评审原型。",
        },
        {
          agentName: AgentName.qa_agent,
          step: ModelTaskType.qa_check,
          input: stepInputs(skillInputs, "ProductDesignState", "RequirementDocument", "PrototypeSpec", "PrototypeArtifact"),
          output: "QAReport",
          gate: "QA 只能检查，不能修改任何产物。",
        },
        {
          agentName: AgentName.knowledge_extractor_agent,
          step: ModelTaskType.knowledge_extraction,
          input: stepInputs(skillInputs, "ProductDesignState", "RequirementDocument", "PrototypeSpec", "PatchPlan"),
          output: "KnowledgeCandidateDraft[]",
          gate: "只生成候选知识，正式入库必须审核。",
        },
      ],
      qaFocus: [
        "ProductDesignState、PRD、PrototypeSpec 和 HTML 是否围绕同一页面与状态范围",
        "用户明确事实、知识库规则和 AI 推断是否被正确标记",
        "默认态、成功态、禁用态和异常态是否都有验收标准",
      ],
      risks: inferRisks(input),
      assumptions,
    };
  }

  protected normalize(output: ProductBuildPlan, input: ProductPlannerInput): ProductBuildPlan {
    const fallback = this.fallback(input);
    const deliverables = output.deliverables && typeof output.deliverables === "object"
      ? output.deliverables
      : fallback.deliverables;

    return {
      id: text(output.id, fallback.id),
      projectId: text(output.projectId, fallback.projectId),
      title: text(output.title, fallback.title),
      goal: text(output.goal, fallback.goal),
      summary: text(output.summary, fallback.summary),
      requirementMode: normalizeRequirementMode(output.requirementMode) ?? fallback.requirementMode,
      sourceSummary: {
        userFacts: stringArray(output.sourceSummary?.userFacts, fallback.sourceSummary.userFacts),
        knowledgeFacts: stringArray(output.sourceSummary?.knowledgeFacts, fallback.sourceSummary.knowledgeFacts),
        assumptions: stringArray(output.sourceSummary?.assumptions, fallback.sourceSummary.assumptions),
        openQuestions: stringArray(output.sourceSummary?.openQuestions, fallback.sourceSummary.openQuestions),
      },
      scope: {
        inScope: stringArray(output.scope?.inScope, fallback.scope.inScope),
        outOfScope: stringArray(output.scope?.outOfScope, fallback.scope.outOfScope),
        targetUsers: stringArray(output.scope?.targetUsers, fallback.scope.targetUsers),
        coreScenarios: stringArray(output.scope?.coreScenarios, fallback.scope.coreScenarios),
      },
      pagePlan: normalizePagePlan(output.pagePlan, fallback.pagePlan),
      statePlan: normalizeStatePlan(output.statePlan, fallback.statePlan),
      deliverables: {
        productDesignState: bool(deliverables.productDesignState, fallback.deliverables.productDesignState),
        prd: bool(deliverables.prd, fallback.deliverables.prd),
        prototypeSpec: bool(deliverables.prototypeSpec, fallback.deliverables.prototypeSpec),
        htmlPrototype: bool(deliverables.htmlPrototype, fallback.deliverables.htmlPrototype),
        qa: bool(deliverables.qa, fallback.deliverables.qa),
        knowledgeCandidates: bool(deliverables.knowledgeCandidates, fallback.deliverables.knowledgeCandidates),
      },
      agentSequence: Array.isArray(output.agentSequence) && output.agentSequence.length
        ? output.agentSequence.map((item, index) => ({
            agentName: normalizeAgentName(item.agentName) ?? fallback.agentSequence[index]?.agentName ?? AgentName.product_designer_agent,
            step: normalizeTaskType(item.step) ?? fallback.agentSequence[index]?.step ?? ModelTaskType.product_design,
            input: stringArray(item.input, fallback.agentSequence[index]?.input ?? []),
            output: text(item.output, fallback.agentSequence[index]?.output ?? "AgentOutput"),
            gate: typeof item.gate === "string" ? item.gate : fallback.agentSequence[index]?.gate,
          }))
        : fallback.agentSequence,
      qaFocus: stringArray(output.qaFocus, fallback.qaFocus),
      risks: normalizeRisks(output.risks, fallback.risks),
      assumptions: stringArray(output.assumptions, fallback.assumptions),
    };
  }
}

function normalizeTitle(input: ProductPlannerInput) {
  return firstSentence(input.userInput, input.existingState?.title ?? "产品需求方案")
    .replace(/^帮我|^请|需求和原型/g, "")
    .slice(0, 60) || input.existingState?.title || "产品需求方案";
}

function inferGoal(input: ProductPlannerInput) {
  if (/活跃|留存|转化|增长/.test(input.userInput)) return "提升核心业务指标，并沉淀可评审的 PRD 与原型。";
  if (/后台|运营|配置|管理/.test(input.userInput)) return "提升运营配置效率，降低规则理解和评审成本。";
  return "明确正式需求范围，形成统一 ProductDesignState，并生成可评审 PRD 与原型。";
}

function inferPagePlan(input: ProductPlannerInput, title: string): ProductBuildPlan["pagePlan"] {
  if (input.existingState?.pages?.length) {
    return input.existingState.pages.map((page, index) => {
      const record = page as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : `页面 ${index + 1}`;
      return {
        id: typeof record.id === "string" ? record.id : stableId("page", name),
        name,
        purpose: typeof record.purpose === "string" ? record.purpose : "承载已有产品核心流程。",
        priority: normalizePriority(record.priority) ?? "must",
        sourcePaths: ["pages"],
      };
    });
  }

  const pages: ProductBuildPlan["pagePlan"] = [
    {
      id: stableId("page", title),
      name: title || "核心页面",
      purpose: "承载用户核心流程、关键状态展示和主要行动入口。",
      priority: "must",
      sourcePaths: ["pages", "scope.inScope"],
    },
  ];

  if (/后台|运营|配置|管理/.test(input.userInput)) {
    pages.push({
      id: stableId("page", `${title}_config`),
      name: "运营配置页",
      purpose: "承载规则配置、状态开关和发布前校验。",
      priority: "should",
      sourcePaths: ["backendConfigs", "businessRules"],
    });
  }

  return pages;
}

function inferStatePlan(): ProductBuildPlan["statePlan"] {
  return [
    {
      id: "state_default",
      name: "默认态",
      coverage: "default",
      required: true,
      sourcePaths: ["stateRules", "frontendRules"],
    },
    {
      id: "state_success",
      name: "成功态",
      coverage: "success",
      required: true,
      sourcePaths: ["stateRules", "acceptanceCriteria"],
    },
    {
      id: "state_disabled",
      name: "禁用态",
      coverage: "disabled",
      required: true,
      sourcePaths: ["stateRules", "frontendRules"],
    },
    {
      id: "state_error",
      name: "异常态",
      coverage: "error",
      required: true,
      sourcePaths: ["exceptionScenarios", "acceptanceCriteria"],
    },
  ];
}

function inferInScope(input: ProductPlannerInput, pagePlan: ProductBuildPlan["pagePlan"]) {
  return unique([
    ...pagePlan.map((page) => `${page.name}：${page.purpose}`),
    "ProductDesignState 唯一事实源",
    "PRD 草案",
    "PrototypeSpec 与 HTML 评审原型",
    "一致性 QA",
    /知识|规则|沉淀/.test(input.userInput) ? "知识候选抽取" : "",
  ]);
}

function inferTargetUsers(input: ProductPlannerInput) {
  const existingUsers =
    input.existingState?.targetUsers
      ?.map((item) => item.name)
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim())) ?? [];
  const inferred = [
    /运营|后台|配置/.test(input.userInput) ? "运营人员" : "",
    /用户|会员|客户/.test(input.userInput) ? "普通用户" : "",
    /商家/.test(input.userInput) ? "商家用户" : "",
    "产品评审人员",
  ];
  return unique([...existingUsers, ...inferred]).length ? unique([...existingUsers, ...inferred]) : ["普通用户", "产品评审人员"];
}

function inferCoreScenarios(input: ProductPlannerInput) {
  const fromUser = input.requirementAnalysis.knownFromUser
    .filter((item) => item.length <= 80)
    .slice(0, 3);
  return unique([
    ...fromUser,
    "用户完成核心业务动作并获得明确反馈",
    "评审人员检查 PRD、原型和 QA 是否一致",
    /后台|运营|配置/.test(input.userInput) ? "运营人员配置规则并进行发布前检查" : "",
  ]);
}

function inferRisks(input: ProductPlannerInput): ProductBuildPlan["risks"] {
  const risks: ProductBuildPlan["risks"] = [
    ...input.requirementAnalysis.conflicts.map((item, index) => ({
      id: `risk_conflict_${index + 1}`,
      level: "high" as const,
      description: item,
      mitigation: "保留为风险项，QA 阶段必须检查，不自动覆盖 strong_rule。",
    })),
    ...input.requirementAnalysis.missingCritical.map((item, index) => ({
      id: `risk_missing_${index + 1}`,
      level: "medium" as const,
      description: `关键需求缺失：${item}`,
      mitigation: "先按通用最佳实践生成并标记 assumption，等待用户确认。",
    })),
  ];

  if (risks.length) return risks;
  return [
    {
      id: "risk_ai_assumption",
      level: "low",
      description: "部分页面、状态和异常由 AI 基于最佳实践补齐。",
      mitigation: "全部写入 assumptions 和 sourceSummary，后续由 QA 与用户评审确认。",
    },
  ];
}

function requirementModeFromIntent(intent: UserIntent): ProductBuildPlan["requirementMode"] {
  if (intent === UserIntent.complete_requirement) return "requirement_completion";
  if (intent === UserIntent.generate_prd) return "prd_generation";
  if (intent === UserIntent.generate_prototype) return "prototype_generation";
  return "formal_requirement";
}

function knowledgeReferences(context: KnowledgeContext) {
  return collectKnowledgeReferences(context);
}

function stepInputs(skillInputs: string[], ...items: string[]) {
  return [...items, ...skillInputs];
}

function unique(values: Array<string | undefined | null>) {
  return [...new Set(values.map((item) => item?.trim()).filter((item): item is string => Boolean(item)))];
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown, fallback: string[]) {
  return Array.isArray(value) ? unique(value.map((item) => String(item))) : fallback;
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeRequirementMode(value: unknown): ProductBuildPlan["requirementMode"] | undefined {
  if (
    value === "formal_requirement" ||
    value === "requirement_completion" ||
    value === "prd_generation" ||
    value === "prototype_generation"
  ) {
    return value;
  }
  return undefined;
}

function normalizePriority(value: unknown): ProductBuildPlanPriority | undefined {
  if (value === "must" || value === "should" || value === "could") return value;
  return undefined;
}

function normalizeCoverage(value: unknown): ProductBuildPlanStateCoverage | undefined {
  if (
    value === "default" ||
    value === "loading" ||
    value === "success" ||
    value === "empty" ||
    value === "disabled" ||
    value === "error"
  ) {
    return value;
  }
  return undefined;
}

function normalizePagePlan(value: unknown, fallback: ProductBuildPlan["pagePlan"]) {
  if (!Array.isArray(value) || !value.length) return fallback;
  return value.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const name = text(record.name, fallback[index]?.name ?? `页面 ${index + 1}`);
    return {
      id: text(record.id, fallback[index]?.id ?? stableId("page", name)),
      name,
      purpose: text(record.purpose, fallback[index]?.purpose ?? "承载核心流程。"),
      priority: normalizePriority(record.priority) ?? fallback[index]?.priority ?? "must",
      sourcePaths: stringArray(record.sourcePaths, fallback[index]?.sourcePaths ?? ["pages"]),
    };
  });
}

function normalizeStatePlan(value: unknown, fallback: ProductBuildPlan["statePlan"]) {
  if (!Array.isArray(value) || !value.length) return fallback;
  return value.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const name = text(record.name, fallback[index]?.name ?? `状态 ${index + 1}`);
    return {
      id: text(record.id, fallback[index]?.id ?? stableId("state", name)),
      name,
      coverage: normalizeCoverage(record.coverage) ?? fallback[index]?.coverage ?? "default",
      required: typeof record.required === "boolean" ? record.required : fallback[index]?.required ?? true,
      sourcePaths: stringArray(record.sourcePaths, fallback[index]?.sourcePaths ?? ["stateRules"]),
    };
  });
}

function normalizeRisks(value: unknown, fallback: ProductBuildPlan["risks"]) {
  if (!Array.isArray(value) || !value.length) return fallback;
  return value.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const level = record.level === "high" || record.level === "medium" || record.level === "low"
      ? record.level
      : fallback[index]?.level ?? "low";
    return {
      id: text(record.id, fallback[index]?.id ?? `risk_${index + 1}`),
      level,
      description: text(record.description, fallback[index]?.description ?? "计划风险待确认。"),
      mitigation: text(record.mitigation, fallback[index]?.mitigation ?? "进入 QA 和用户评审确认。"),
    };
  });
}

function normalizeAgentName(value: unknown): AgentName | undefined {
  return Object.values(AgentName).includes(value as AgentName) ? value as AgentName : undefined;
}

function normalizeTaskType(value: unknown): ModelTaskType | undefined {
  return Object.values(ModelTaskType).includes(value as ModelTaskType) ? value as ModelTaskType : undefined;
}
