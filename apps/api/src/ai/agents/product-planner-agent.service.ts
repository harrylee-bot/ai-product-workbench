import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType, UserIntent } from "@prisma/client";
import { ModelGatewayError } from "../../model-gateway/model-gateway.error";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { ModelGatewayErrorCode } from "../../model-gateway/model-gateway.types";
import type { AgentFallbackMetadata } from "../agent-fallback-policy";
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
  RequirementPackage,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type ProductPlannerInput = {
  userInput: string;
  intent: UserIntent;
  requirementAnalysis: RequirementAnalysis;
  requirementPackage?: RequirementPackage;
  knowledgeContext: KnowledgeContext;
  existingState?: ProductDesignState;
};

const PRODUCT_PLANNER_TIMEOUT_MS = 18_000;
const PRODUCT_PLANNER_MAX_TOKENS = 3_000;
const PRODUCT_PLANNER_FALLBACK_MODE = "deterministic_product_build_plan";

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
      { role: "user" as const, content: JSON.stringify(toPlannerPromptInput(input)) },
    ];
  }

  protected modelTimeoutMs() {
    return PRODUCT_PLANNER_TIMEOUT_MS;
  }

  protected modelRetryCount() {
    return 0;
  }

  protected jsonParseRetryCount() {
    return 0;
  }

  protected modelMaxTokens() {
    return PRODUCT_PLANNER_MAX_TOKENS;
  }

  protected fallbackOnError(error: unknown): AgentFallbackMetadata {
    return {
      used: true,
      level: "acceptable_result",
      action: "continue",
      agentName: this.agentName,
      taskType: this.taskType,
      fallbackMode: PRODUCT_PLANNER_FALLBACK_MODE,
      errorCode: modelErrorCode(error),
      errorMessage: errorText(error),
      reason: "Product Planner 模型调用未及时返回或输出不可用，已使用确定性规则生成 ProductBuildPlan，避免正式需求链路卡死。",
      userMessage: "Product Planner 模型规划未及时完成，已使用规则兜底生成执行计划并继续后续链路。",
      canContinue: true,
      allowsConfirmation: true,
      allowsKnowledgeExtraction: true,
      allowsExport: true,
      occurredAt: new Date().toISOString(),
    };
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
    const skillNames = unique([
      ...(input.knowledgeContext.agentSkills?.map((skill) => skill.name) ?? []),
      ...(input.knowledgeContext.skillRouting?.map((route) => route.skillName) ?? []),
    ]);
    const routedAgents = unique(
      input.knowledgeContext.skillRouting?.flatMap((route) =>
        route.appliesTo.map((target) => target.agentName)
      ) ?? [],
    );
    const skillInputs = skillNames.length
      ? input.knowledgeContext.skillRouting?.length
        ? ["VibeCodingSkillInstructions", "KnowledgeContext.skillRouting"]
        : ["VibeCodingSkillInstructions"]
      : [];
    const assumptions = unique([
      ...input.requirementAnalysis.inferredByAI,
      "正式需求先落 ProductBuildPlan，再落 ProductDesignState，PRD、原型和 QA 均从同一 State 再生成。",
      skillNames.length ? `本轮需按 Vibe Coding Skills 执行：${skillNames.join("、")}` : "",
      routedAgents.length ? `Skill 路由覆盖 Agent：${routedAgents.join("、")}` : "",
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
        userFacts: input.requirementPackage?.userFacts.length ? input.requirementPackage.userFacts : userFacts,
        knowledgeFacts: input.requirementPackage?.knowledgeFacts.length ? input.requirementPackage.knowledgeFacts : knowledgeFacts,
        assumptions: input.requirementPackage?.assumptions.length ? input.requirementPackage.assumptions : assumptions,
        openQuestions: input.requirementPackage
          ? unique([...input.requirementPackage.missingRequiredInfo, ...input.requirementPackage.missingOptionalInfo])
          : openQuestions,
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
        skillNames.length ? `Vibe Coding Skills 是否保留 sourcePath/knowledgeId 并进入 QA 检查：${skillNames.join("、")}` : "",
      ].filter(Boolean),
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

function toPlannerPromptInput(input: ProductPlannerInput) {
  return {
    userInput: input.userInput,
    intent: input.intent,
    requirementPackage: input.requirementPackage
      ? compactRequirementPackage(input.requirementPackage)
      : undefined,
    requirementAnalysis: {
      completenessScore: input.requirementAnalysis.completenessScore,
      knownFromUser: capStrings(input.requirementAnalysis.knownFromUser, 8),
      knownFromKnowledge: capStrings(input.requirementAnalysis.knownFromKnowledge, 8),
      inferredByAI: capStrings(input.requirementAnalysis.inferredByAI, 8),
      missingCritical: capStrings(input.requirementAnalysis.missingCritical, 8),
      missingOptional: capStrings(input.requirementAnalysis.missingOptional, 8),
      conflicts: capStrings(input.requirementAnalysis.conflicts, 6),
      shouldAskUser: input.requirementAnalysis.shouldAskUser,
      clarificationQuestions: input.requirementAnalysis.clarificationQuestions.slice(0, 6).map((item) => ({
        id: item.id,
        title: clip(item.title, 120),
        reason: clip(item.reason, 180),
      })),
    },
    knowledgeContext: {
      query: input.knowledgeContext.query,
      summary: clip(input.knowledgeContext.summary, 400),
      strongRules: compactKnowledgeItems(input.knowledgeContext.strongRules),
      defaultRules: compactKnowledgeItems(input.knowledgeContext.defaultRules),
      referenceCases: compactKnowledgeItems(input.knowledgeContext.referenceCases),
      designPatterns: compactKnowledgeItems(input.knowledgeContext.designPatterns),
      prdWritingRules: compactKnowledgeItems(input.knowledgeContext.prdWritingRules),
      prototypeRules: compactKnowledgeItems(input.knowledgeContext.prototypeRules),
      businessConcepts: compactKnowledgeItems(input.knowledgeContext.businessConcepts),
      conflicts: input.knowledgeContext.conflicts.slice(0, 6).map((item) => ({
        id: item.id,
        description: clip(item.description, 180),
        references: item.references.slice(0, 6),
      })),
      unknownAreas: capStrings(input.knowledgeContext.unknownAreas, 8),
      agentSkills: (input.knowledgeContext.agentSkills ?? []).slice(0, 8).map((skill) => ({
        id: skill.id,
        name: skill.name,
        sourcePath: skill.sourcePath,
        capabilities: capStrings(skill.capabilities, 8),
        triggerHints: capStrings(skill.triggerHints, 8),
      })),
      skillRouting: (input.knowledgeContext.skillRouting ?? []).slice(0, 8).map((route) => ({
        skillName: route.skillName,
        sourcePath: route.sourcePath,
        appliesTo: route.appliesTo.map((target) => ({
          agentName: target.agentName,
          taskType: target.taskType,
          handoffField: target.handoffField,
          usage: clip(target.usage, 180),
        })),
      })),
    },
    existingState: compactExistingState(input.existingState),
  };
}

function compactRequirementPackage(requirementPackage: RequirementPackage) {
  return {
    id: requirementPackage.id,
    flowType: requirementPackage.flowType,
    readiness: requirementPackage.readiness,
    summary: clip(requirementPackage.summary, 400),
    userFacts: capStrings(requirementPackage.userFacts, 10),
    knowledgeFacts: capStrings(requirementPackage.knowledgeFacts, 10),
    contextFacts: capStrings(requirementPackage.contextFacts, 8),
    assumptions: capStrings(requirementPackage.assumptions, 8),
    missingRequiredInfo: capStrings(requirementPackage.missingRequiredInfo, 8),
    missingOptionalInfo: capStrings(requirementPackage.missingOptionalInfo, 8),
    conflicts: capStrings(requirementPackage.conflicts, 6),
    constraints: capStrings(requirementPackage.constraints, 10),
    requiredArtifacts: requirementPackage.requiredArtifacts,
    sourcePaths: capStrings(requirementPackage.sourcePaths, 12),
    traceRefs: capStrings(requirementPackage.traceRefs, 12),
  };
}

function compactExistingState(state?: ProductDesignState) {
  if (!state) return undefined;
  return {
    projectId: state.projectId,
    id: state.id,
    version: state.version,
    status: state.status,
    title: state.title,
    businessGoal: clip(state.businessGoal, 240),
    counts: {
      pages: state.pages.length,
      targetUsers: state.targetUsers.length,
      userScenarios: state.userScenarios.length,
      backendConfigs: state.backendConfigs.length,
      frontendRules: state.frontendRules.length,
      businessRules: state.businessRules.length,
      stateRules: state.stateRules.length,
      exceptionScenarios: state.exceptionScenarios.length,
      acceptanceCriteria: state.acceptanceCriteria.length,
      assumptions: state.assumptions.length,
      pendingQuestions: state.pendingQuestions.length,
      confirmedFacts: state.confirmedFacts.length,
    },
    pages: state.pages.slice(0, 10).map((page) => compactRecord(page, ["id", "name", "purpose"], 220)),
    targetUsers: state.targetUsers.slice(0, 8).map((user) => compactRecord(user, ["id", "name", "description"], 180)),
    businessRules: state.businessRules.slice(0, 10).map((rule) => compactRecord(rule, ["id", "title", "description"], 240)),
    stateRules: state.stateRules.slice(0, 10).map((rule) => compactRecord(rule, ["id", "name", "description"], 240)),
    frontendRules: state.frontendRules.slice(0, 10).map((rule) => compactRecord(rule, ["id", "title", "description"], 240)),
    exceptionScenarios: state.exceptionScenarios.slice(0, 8).map((item) => compactRecord(item, ["id", "title", "handling"], 240)),
    acceptanceCriteria: state.acceptanceCriteria.slice(0, 8).map((item) => compactRecord(item, ["id", "description"], 240)),
    assumptions: state.assumptions.slice(0, 8).map((item) => compactRecord(item, ["id", "content", "reason"], 200)),
    pendingQuestions: state.pendingQuestions.slice(0, 8).map((item) => compactRecord(item, ["id", "question", "reason"], 200)),
  };
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

function unique(values: Array<unknown>) {
  return [...new Set(values.map(toCleanString).filter((item): item is string => Boolean(item)))];
}

function capStrings(values: string[] | undefined, limit: number) {
  return unique((values ?? []).slice(0, limit).map((item) => clip(item, 220)));
}

function compactKnowledgeItems(items: Array<{ id?: string; knowledgeId?: string; title?: string; content?: string; snippet?: string; sourceType?: string }> = []) {
  return items.slice(0, 8).map((item) => ({
    id: item.id,
    knowledgeId: item.knowledgeId,
    title: clip(item.title, 120),
    sourceType: item.sourceType,
    summary: clip(item.snippet || item.content, 260),
  }));
}

function compactRecord(record: Record<string, unknown>, keys: string[], maxLength: number) {
  return Object.fromEntries(
    keys
      .map((key) => [key, clip(record[key], maxLength)] as const)
      .filter(([, value]) => Boolean(value)),
  );
}

function clip(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function modelErrorCode(error: unknown): ModelGatewayErrorCode {
  return error instanceof ModelGatewayError ? error.code : "MODEL_CALL_FAILED";
}

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : "模型调用失败";
  return clip(message, 500) || "模型调用失败";
}

function toCleanString(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return clip(record.title ?? record.name ?? record.content ?? record.description ?? record.reason ?? JSON.stringify(value), 240);
  }
  return "";
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
