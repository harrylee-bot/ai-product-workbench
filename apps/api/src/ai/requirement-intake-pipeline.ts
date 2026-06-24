import { UserIntent } from "@prisma/client";
import { stableId, summarizeText } from "./ai-vibe.helpers";
import type {
  AgentRunContext,
  AttachmentSummary,
  ClarificationQuestion,
  ContextFetchResult,
  KnowledgeContext,
  ProductBuildPlan,
  ProductDesignState,
  RequirementAnalysis,
  RequirementFlowType,
  RequirementGateDecision,
  RequirementPackage,
  RequirementSafetyCheckResult,
  RequirementValidationResult,
} from "./ai-vibe.types";

type BuildContextFetchInput = {
  context: AgentRunContext;
  attachments: AttachmentSummary[];
};

type BuildRequirementPackageInput = {
  context: AgentRunContext;
  intent: UserIntent;
  knowledgeContext: KnowledgeContext;
  contextFetch: ContextFetchResult;
  requirementAnalysis: RequirementAnalysis;
};

type ValidateRequirementInput = {
  requirementPackage: RequirementPackage;
  productBuildPlan?: ProductBuildPlan;
};

type SafetyCheckInput = {
  requirementPackage: RequirementPackage;
  productBuildPlan?: ProductBuildPlan;
};

type DecideGateInput = {
  requirementPackage: RequirementPackage;
  validation: RequirementValidationResult;
  safety: RequirementSafetyCheckResult;
  productBuildPlan?: ProductBuildPlan;
  fallbackUsed: boolean;
};

export function buildContextFetchResult({
  context,
  attachments,
}: BuildContextFetchInput): ContextFetchResult {
  const state = context.productDesignState;
  const recentMessages = context.recentMessages.slice(-12);
  const userMessageCount = recentMessages.filter((message) => message.role === "user").length;
  const assistantMessageCount = recentMessages.filter((message) => message.role === "assistant").length;
  const traceRefs = [
    `run:${context.runId}`,
    `project:${context.projectId}`,
    `conversation:${context.conversationId}`,
    state ? `state:${state.id}@v${state.version}` : "",
    context.selectedRegion?.targetId ? `selected:${context.selectedRegion.targetId}` : "",
    ...attachments.map((attachment) => `attachment:${attachment.fileId}`),
  ].filter(Boolean);

  return {
    project: {
      id: context.projectId,
      status: context.currentProjectStatus,
      currentProductDesignStateId: state?.id,
      currentProductDesignStateVersion: state?.version,
    },
    conversation: {
      id: context.conversationId,
      summary: context.conversationSummary,
      recentMessages,
      userMessageCount,
      assistantMessageCount,
    },
    existingState: state ? compactState(state) : undefined,
    selectedRegion: context.selectedRegion,
    attachments,
    traceRefs,
    retrievedAt: new Date().toISOString(),
    summary: summarizeContext(state, recentMessages.length, attachments.length, context.selectedRegion),
  };
}

export function buildRequirementPackage({
  context,
  intent,
  knowledgeContext,
  contextFetch,
  requirementAnalysis,
}: BuildRequirementPackageInput): RequirementPackage {
  const flowType = flowTypeForIntent(intent);
  const userFacts = unique([
    ...requirementAnalysis.knownFromUser,
    context.userInput ? `用户原始输入：${summarizeText(context.userInput, 260)}` : "",
  ]);
  const knowledgeFacts = unique([
    ...requirementAnalysis.knownFromKnowledge,
    ...knowledgeItems(knowledgeContext).map((item) => `${item.title}${item.sourceType ? `（${item.sourceType}）` : ""}`),
  ]);
  const contextFacts = unique([
    contextFetch.existingState
      ? `已有产品状态：${contextFetch.existingState.title}，版本 v${contextFetch.existingState.version}，状态 ${contextFetch.existingState.status}`
      : "当前项目还没有产品状态。",
    contextFetch.conversation.recentMessages.length
      ? `已读取最近 ${contextFetch.conversation.recentMessages.length} 条对话。`
      : "",
    contextFetch.attachments.length ? `本轮包含 ${contextFetch.attachments.length} 个附件摘要。` : "",
    contextFetch.selectedRegion ? `本轮包含选区：${contextFetch.selectedRegion.label ?? contextFetch.selectedRegion.type}` : "",
  ]);
  const conflicts = unique([
    ...requirementAnalysis.conflicts,
    ...knowledgeContext.conflicts.map((item) => item.description),
  ]);
  const assumptions = unique(requirementAnalysis.inferredByAI);
  const missingRequiredInfo = unique(requirementAnalysis.missingCritical);
  const missingOptionalInfo = unique(requirementAnalysis.missingOptional);
  const constraints = unique([
    ...knowledgeContext.strongRules.map((item) => `强规则：${item.title}`),
    ...knowledgeContext.defaultRules.map((item) => `默认规则：${item.title}`),
    ...((knowledgeContext.agentSkills ?? []).map((skill) => `Skill：${skill.name}（${skill.sourcePath}）`)),
    "PRD、原型和 Patch 都必须从 ProductDesignState 派生。",
    "未确认的 AI assumption 不能沉淀为正式知识。",
  ]);
  const readiness = readinessFor(requirementAnalysis, conflicts, flowType);

  return {
    id: stableId("requirement_package", `${context.runId}_${intent}_${context.userInput}`),
    intent,
    flowType,
    userInput: context.userInput,
    userFacts,
    knowledgeFacts,
    contextFacts,
    assumptions,
    missingRequiredInfo,
    missingOptionalInfo,
    conflicts,
    constraints,
    requiredArtifacts: requiredArtifactsFor(flowType),
    sourcePaths: sourcePathsFor(flowType, contextFetch),
    traceRefs: unique([...contextFetch.traceRefs, ...knowledgeItems(knowledgeContext).map((item) => item.knowledgeId ?? item.id)]),
    selectedRegionContext: contextFetch.selectedRegion,
    contextSnapshot: contextFetch,
    knowledgeSummary: knowledgeContext.summary,
    requirementAnalysis,
    readiness,
    summary: summarizeRequirementPackage(flowType, userFacts, knowledgeFacts, assumptions, missingRequiredInfo, conflicts),
  };
}

export function validateRequirementPackage({
  requirementPackage,
  productBuildPlan,
}: ValidateRequirementInput): RequirementValidationResult {
  const missingFields: string[] = [];
  const invalidOperations: string[] = [];
  const requiredClarifications: ClarificationQuestion[] = [];

  if (!requirementPackage.userInput.trim()) {
    missingFields.push("用户原始输入为空");
  }
  if (!requirementPackage.userFacts.length) {
    missingFields.push("缺少可识别的用户事实");
  }
  if (requirementPackage.flowType === "patch") {
    if (!requirementPackage.selectedRegionContext) {
      invalidOperations.push("局部修改缺少 selectedRegion");
    }
    if (!requirementPackage.contextSnapshot.existingState) {
      invalidOperations.push("局部修改缺少可修改的 ProductDesignState");
    }
  }
  if (productBuildPlan) {
    if (!productBuildPlan.pagePlan.length) missingFields.push("ProductBuildPlan.pagePlan 为空");
    if (!productBuildPlan.statePlan.length) missingFields.push("ProductBuildPlan.statePlan 为空");
    if (!productBuildPlan.deliverables.productDesignState) missingFields.push("ProductBuildPlan 未声明生成 ProductDesignState");
  }

  const shouldAskUser =
    requirementPackage.requirementAnalysis.shouldAskUser &&
    requirementPackage.flowType !== "patch";
  if (shouldAskUser) {
    requiredClarifications.push(...requirementPackage.requirementAnalysis.clarificationQuestions);
  }

  const hardBlock = invalidOperations.length > 0 || (!requirementPackage.userInput.trim() && !requirementPackage.contextSnapshot.existingState);
  const status: RequirementValidationResult["status"] = hardBlock
    ? "block"
    : missingFields.length || requirementPackage.conflicts.length || requiredClarifications.length
      ? "warn"
      : "pass";

  return {
    status,
    missingFields,
    conflicts: requirementPackage.conflicts,
    invalidOperations,
    requiredClarifications,
    canAutoContinue: !hardBlock && !requiredClarifications.length,
    userMessage: validationUserMessage(status, missingFields, invalidOperations, requiredClarifications),
    summary: validationSummary(status, missingFields, invalidOperations, requiredClarifications),
  };
}

export function checkRequirementSafety({
  requirementPackage,
  productBuildPlan,
}: SafetyCheckInput): RequirementSafetyCheckResult {
  const text = [
    requirementPackage.userInput,
    ...requirementPackage.userFacts,
    ...requirementPackage.assumptions,
    productBuildPlan?.summary ?? "",
  ].join("\n");
  const riskTypes: RequirementSafetyCheckResult["riskTypes"] = [];
  const blockedReasons: string[] = [];
  const warnings: string[] = [];

  if (/忽略(以上|之前|所有).*(指令|规则)|ignore\s+(previous|above)\s+instructions/i.test(text)) {
    riskTypes.push("prompt_injection");
    blockedReasons.push("用户输入疑似要求忽略系统规则或绕过链路。");
  }
  if (/api[_ -]?key|密钥|token|secret|authorization|cookie/i.test(text) && /泄露|显示|打印|输出|读取|获取/i.test(text)) {
    riskTypes.push("secret_leak");
    blockedReasons.push("用户输入疑似要求读取或展示密钥、token、cookie 等敏感信息。");
  }
  if (/绕过.*确认|跳过.*确认|直接.*入库|直接.*发布/i.test(text)) {
    riskTypes.push("permission");
    blockedReasons.push("用户输入疑似要求绕过确认门、知识审核或发布门。");
  }
  if (/真实(支付|扣款|转账|下单|发送短信|发邮件)|生产数据库|线上数据库/i.test(text)) {
    riskTypes.push("real_world_action");
    warnings.push("输入涉及真实外部动作，本链路只能生成评审原型和文档，不能执行真实接口或生产操作。");
  }
  if (requirementPackage.conflicts.length) {
    riskTypes.push("strong_rule_conflict");
    warnings.push("需求或知识库存在冲突，后续产物必须保留为风险并等待评审。");
  }
  if (/身份证|手机号|银行卡|个人隐私|隐私数据/i.test(text)) {
    riskTypes.push("privacy");
    warnings.push("输入涉及隐私或个人信息，原型与 PRD 应使用脱敏示例，不生成真实个人数据。");
  }

  const status: RequirementSafetyCheckResult["status"] = blockedReasons.length
    ? "block"
    : warnings.length
      ? "warn"
      : "pass";

  return {
    status,
    riskTypes: unique(riskTypes),
    blockedReasons,
    warnings,
    safeAlternative: blockedReasons.length
      ? "我可以继续帮你生成不包含密钥、越权操作或真实接口动作的 PRD / 原型方案。"
      : undefined,
    userMessage: safetyUserMessage(status, blockedReasons, warnings),
    summary: safetySummary(status, blockedReasons, warnings),
  };
}

export function decideRequirementGate({
  requirementPackage,
  validation,
  safety,
  fallbackUsed,
}: DecideGateInput): RequirementGateDecision {
  const reasons = unique([
    validation.summary,
    safety.summary,
    fallbackUsed ? "本轮存在模型兜底事件，后续产物会继续暴露兜底信息。" : "",
  ]);

  if (safety.status === "block") {
    return {
      action: "blocked",
      reasons,
      visibleMessage: safety.userMessage,
      canGenerateArtifacts: false,
      canApplyPatch: false,
      fallbackUsed,
      questions: [],
      requirementPackage,
      validation,
      safety,
    };
  }

  if (validation.status === "block") {
    return {
      action: "blocked",
      reasons,
      visibleMessage: validation.userMessage,
      canGenerateArtifacts: false,
      canApplyPatch: false,
      fallbackUsed,
      questions: validation.requiredClarifications,
      requirementPackage,
      validation,
      safety,
    };
  }

  if (validation.requiredClarifications.length) {
    return {
      action: "ask_clarification",
      reasons,
      visibleMessage: validation.userMessage,
      canGenerateArtifacts: false,
      canApplyPatch: false,
      fallbackUsed,
      questions: validation.requiredClarifications,
      requirementPackage,
      validation,
      safety,
    };
  }

  const degraded = validation.status === "warn" || safety.status === "warn" || fallbackUsed;
  return {
    action: degraded ? "degraded_continue" : "continue",
    reasons,
    visibleMessage: degraded
      ? "生成前校验通过，但存在需要评审关注的风险或假设；我会继续生成并在产物中标记。"
      : "生成前校验通过，可以进入产品状态、PRD 和后续原型链路。",
    canGenerateArtifacts: requirementPackage.flowType !== "patch",
    canApplyPatch: requirementPackage.flowType === "patch",
    fallbackUsed,
    questions: [],
    requirementPackage,
    validation,
    safety,
  };
}

export function gateDecisionTrace(gate: RequirementGateDecision) {
  return {
    summary: gate.visibleMessage,
    inputSignals: [
      `需求包状态：${gate.requirementPackage.readiness}`,
      `结构校验：${gate.validation.status}`,
      `安全检查：${gate.safety.status}`,
    ],
    constraints: gate.requirementPackage.constraints.slice(0, 6),
    assumptions: gate.requirementPackage.assumptions.slice(0, 6),
    alternativesConsidered: ["继续生成", "降级继续并标记风险", "向用户澄清", "阻断危险或不可执行输入"],
    decision: `GateDecision.action=${gate.action}`,
    risks: unique([...gate.validation.conflicts, ...gate.safety.blockedReasons, ...gate.safety.warnings]).slice(0, 6),
    nextStep: gate.canGenerateArtifacts
      ? "进入 ProductDesignState 和 PRD 生成链路。"
      : gate.canApplyPatch
        ? "进入 Patch 候选生成链路。"
        : "等待用户补充或修改输入。",
    generatedBy: "deterministic" as const,
  };
}

function compactState(state: ProductDesignState): NonNullable<ContextFetchResult["existingState"]> {
  return {
    id: state.id,
    version: state.version,
    title: state.title,
    status: state.status,
    summary: state.summary,
    businessGoal: state.businessGoal,
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
    prd: state.prdDocument
      ? {
          id: state.prdDocument.id,
          title: state.prdDocument.title,
          status: state.prdDocument.status,
          sectionCount: state.prdDocument.sections.length,
        }
      : undefined,
    prototype: state.prototypeSpec
      ? {
          id: state.prototypeSpec.id,
          title: state.prototypeSpec.title,
          pageCount: state.prototypeSpec.pages.length,
        }
      : undefined,
    pendingQuestions: state.pendingQuestions.slice(0, 8),
    assumptions: state.assumptions.slice(0, 8),
  };
}

function summarizeContext(
  state: ProductDesignState | undefined,
  messageCount: number,
  attachmentCount: number,
  selectedRegion: AgentRunContext["selectedRegion"],
) {
  const parts = [
    state ? `已读取当前产品状态「${state.title}」v${state.version}` : "当前没有可复用的产品状态",
    `最近对话 ${messageCount} 条`,
    attachmentCount ? `附件 ${attachmentCount} 个` : "",
    selectedRegion ? `选区 ${selectedRegion.label ?? selectedRegion.type}` : "",
  ].filter(Boolean);
  return parts.join("，");
}

function flowTypeForIntent(intent: UserIntent): RequirementFlowType {
  if (intent === UserIntent.patch_document || intent === UserIntent.patch_prototype) return "patch";
  if (intent === UserIntent.complete_requirement) return "requirement_completion";
  if (intent === UserIntent.generate_prd) return "prd_generation";
  if (intent === UserIntent.generate_prototype) return "prototype_generation";
  if (intent === UserIntent.export_word || intent === UserIntent.export_html) return "export";
  if (intent === UserIntent.general_question || intent === UserIntent.knowledge_update) return "question";
  return "formal_requirement";
}

function requiredArtifactsFor(flowType: RequirementFlowType): ProductBuildPlan["deliverables"] {
  if (flowType === "patch") {
    return {
      productDesignState: true,
      prd: true,
      prototypeSpec: true,
      htmlPrototype: true,
      qa: true,
      knowledgeCandidates: true,
    };
  }
  if (flowType === "prd_generation") {
    return {
      productDesignState: true,
      prd: true,
      prototypeSpec: false,
      htmlPrototype: false,
      qa: false,
      knowledgeCandidates: false,
    };
  }
  return {
    productDesignState: true,
    prd: true,
    prototypeSpec: true,
    htmlPrototype: true,
    qa: true,
    knowledgeCandidates: true,
  };
}

function sourcePathsFor(flowType: RequirementFlowType, contextFetch: ContextFetchResult) {
  return [
    "userInput",
    "requirementAnalysis",
    "knowledgeContext",
    "contextFetch",
    contextFetch.existingState ? "productDesignState" : "",
    contextFetch.selectedRegion ? "selectedRegion" : "",
    flowType === "patch" ? "patch.selectedRegion" : "",
  ].filter(Boolean);
}

function readinessFor(
  requirement: RequirementAnalysis,
  conflicts: string[],
  flowType: RequirementFlowType,
): RequirementPackage["readiness"] {
  if (flowType === "patch") return "ready";
  if (conflicts.length && requirement.completenessScore < 40) return "blocked";
  if (requirement.shouldAskUser) return "needs_clarification";
  return "ready";
}

function summarizeRequirementPackage(
  flowType: RequirementFlowType,
  userFacts: string[],
  knowledgeFacts: string[],
  assumptions: string[],
  missingRequiredInfo: string[],
  conflicts: string[],
) {
  return [
    `流程类型：${flowType}`,
    `用户事实 ${userFacts.length} 条`,
    `知识事实 ${knowledgeFacts.length} 条`,
    assumptions.length ? `AI 假设 ${assumptions.length} 条` : "",
    missingRequiredInfo.length ? `待确认关键信息 ${missingRequiredInfo.length} 条` : "",
    conflicts.length ? `冲突 ${conflicts.length} 条` : "",
  ].filter(Boolean).join("；");
}

function knowledgeItems(context: KnowledgeContext) {
  return [
    ...context.strongRules,
    ...context.defaultRules,
    ...context.referenceCases,
    ...context.designPatterns,
    ...context.prdWritingRules,
    ...context.prototypeRules,
    ...context.businessConcepts,
  ];
}

function validationUserMessage(
  status: RequirementValidationResult["status"],
  missingFields: string[],
  invalidOperations: string[],
  requiredClarifications: ClarificationQuestion[],
) {
  if (status === "block") {
    return `生成前结构校验未通过：${[...invalidOperations, ...missingFields].join("；") || "输入不可执行"}。`;
  }
  if (requiredClarifications.length) {
    return "我需要先确认几个会影响业务方向的问题，再继续生成 PRD 和原型。";
  }
  if (status === "warn") {
    return "生成前结构校验通过，但存在缺失项或冲突，我会继续生成并标记为待评审风险。";
  }
  return "生成前结构校验通过。";
}

function validationSummary(
  status: RequirementValidationResult["status"],
  missingFields: string[],
  invalidOperations: string[],
  requiredClarifications: ClarificationQuestion[],
) {
  const parts = [
    `结构校验 ${status}`,
    missingFields.length ? `缺失字段 ${missingFields.length} 个` : "",
    invalidOperations.length ? `不可执行操作 ${invalidOperations.length} 个` : "",
    requiredClarifications.length ? `澄清问题 ${requiredClarifications.length} 个` : "",
  ].filter(Boolean);
  return parts.join("，");
}

function safetyUserMessage(
  status: RequirementSafetyCheckResult["status"],
  blockedReasons: string[],
  warnings: string[],
) {
  if (status === "block") {
    return `生成前安全检查阻断：${blockedReasons.join("；")}。`;
  }
  if (status === "warn") {
    return `生成前安全检查通过，但需要注意：${warnings.join("；")}。`;
  }
  return "生成前安全检查通过。";
}

function safetySummary(
  status: RequirementSafetyCheckResult["status"],
  blockedReasons: string[],
  warnings: string[],
) {
  const parts = [
    `安全检查 ${status}`,
    blockedReasons.length ? `阻断原因 ${blockedReasons.length} 个` : "",
    warnings.length ? `警告 ${warnings.length} 个` : "",
  ].filter(Boolean);
  return parts.join("，");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter((item) => {
    if (typeof item === "string") return Boolean(item.trim());
    return item !== undefined && item !== null;
  }).map((item) => typeof item === "string" ? item.trim() as T : item))];
}
