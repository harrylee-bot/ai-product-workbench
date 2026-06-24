import { UserIntent } from "@prisma/client";
import { stableId, summarizeText } from "./ai-vibe.helpers";
import type {
  AgentDecisionTrace,
  AgentRunContext,
  AgentStepName,
  AttachmentSummary,
  ClarificationQuestion,
  ContextFetchResult,
  KnowledgeContext,
  ProductBuildPlan,
  ProductDesignState,
  RequirementAnalysis,
  RequirementFlowType,
  RequirementGateDecision,
  RequirementIntakeGraph,
  RequirementIntakeNode,
  RequirementIntakeNodeName,
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

type BuildIntakeGraphInput = {
  context: AgentRunContext;
  requirementPackage: RequirementPackage;
  validation: RequirementValidationResult;
  safety: RequirementSafetyCheckResult;
  gate: RequirementGateDecision;
  productBuildPlan?: ProductBuildPlan;
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

export function buildRequirementIntakeGraph({
  context,
  requirementPackage,
  validation,
  safety,
  gate,
  productBuildPlan,
}: BuildIntakeGraphInput): RequirementIntakeGraph {
  const intent = context.intentResult;
  const knowledge = context.knowledgeContext;
  const contextFetch = context.contextFetch;
  const requirement = context.requirementAnalysis;
  const nodes: RequirementIntakeNode[] = [
    {
      id: `${context.runId}:intent`,
      name: "intent",
      title: "Intent",
      agent: "Intent Agent",
      status: intent?.isAmbiguous ? "warning" : "completed",
      inputRefs: ["userInput", "selectedRegion", "recentMessages"],
      outputRefs: ["IntentResult.intent", "IntentResult.requiresSelection"],
      summary: intent
        ? `识别为 ${intent.intent}，置信度 ${Math.round(intent.confidence * 100)}%。${intent.reason}`
        : "尚未记录意图识别结果。",
      decisionTrace: context.intentResult
        ? buildPublicTrace({
            summary: "Intent Agent 完成意图路由。",
            inputSignals: [
              context.userInput ? `用户输入：${summarizeText(context.userInput, 140)}` : "",
              context.selectedRegion ? `存在选区：${context.selectedRegion.label ?? context.selectedRegion.type}` : "无选区",
            ],
            constraints: ["Intent 只决定路线，不生成 PRD、原型或 Patch。"],
            assumptions: [],
            alternativesConsidered: ["正式需求", "局部修改", "普通问答", "导出"],
            decision: `进入 ${context.intentResult.intent} 路线。`,
            risks: context.intentResult.isAmbiguous ? ["意图存在歧义，后续节点需要保留澄清可能。"] : [],
            nextStep: "并行启动 Knowledge 和 Context Fetch。",
          })
        : undefined,
    },
    {
      id: `${context.runId}:knowledge`,
      name: "knowledge",
      title: "Knowledge",
      agent: "Knowledge Agent",
      status: knowledge?.conflicts.length ? "warning" : "completed",
      inputRefs: ["userInput", "intent", "attachments", "productDesignState"],
      outputRefs: ["KnowledgeContext.summary", "KnowledgeContext.references", "KnowledgeContext.skillRouting"],
      summary: knowledge
        ? `${knowledge.summary} 命中知识 ${knowledgeItemCount(knowledge)} 条，skill 路由 ${knowledge.skillRouting?.length ?? 0} 条。`
        : "尚未记录知识检索结果。",
      decisionTrace: knowledge
        ? buildPublicTrace({
            summary: "Knowledge Agent 完成知识、规则、案例和 skills 检索。",
            inputSignals: [
              `查询：${knowledge.query}`,
              `命中知识 ${knowledgeItemCount(knowledge)} 条。`,
              `unknownAreas ${knowledge.unknownAreas.length} 个。`,
            ],
            constraints: knowledge.strongRules.slice(0, 4).map((item) => item.title),
            assumptions: knowledge.unknownAreas.slice(0, 4),
            alternativesConsidered: ["使用强规则", "使用默认规则", "使用案例", "无命中时按最佳实践并标记假设"],
            decision: "将知识上下文交给 Requirement Analyst 和 Planner 共享使用。",
            risks: knowledge.conflicts.map((item) => item.description).slice(0, 4),
            nextStep: "等待 Context Fetch 并进入 Requirement。",
          })
        : undefined,
    },
    {
      id: `${context.runId}:context_fetch`,
      name: "context_fetch",
      title: "Context Fetch",
      agent: "Context Fetch",
      status: "completed",
      inputRefs: ["projectId", "conversationId", "selectedRegion", "attachments"],
      outputRefs: ["ContextFetchResult.project", "ContextFetchResult.conversation", "ContextFetchResult.existingState"],
      summary: contextFetch?.summary ?? "尚未记录上下文抓取结果。",
      decisionTrace: contextFetch
        ? buildPublicTrace({
            summary: "Context Fetch 完成项目上下文读取。",
            inputSignals: [
              `项目：${contextFetch.project.id}`,
              `最近对话 ${contextFetch.conversation.recentMessages.length} 条。`,
              contextFetch.existingState
                ? `已有状态：${contextFetch.existingState.title} v${contextFetch.existingState.version}`
                : "当前没有已有产品状态。",
              contextFetch.selectedRegion ? `选区：${contextFetch.selectedRegion.label ?? contextFetch.selectedRegion.type}` : "",
            ],
            constraints: ["Context Fetch 只读取上下文，不做业务判断。"],
            assumptions: [],
            alternativesConsidered: ["读取已有状态", "读取对话上下文", "读取附件摘要", "读取选区"],
            decision: "将上下文事实交给 RequirementPackage。",
            risks: [],
            nextStep: "进入 Requirement 分析与需求包整理。",
          })
        : undefined,
    },
    {
      id: `${context.runId}:requirement`,
      name: "requirement",
      title: "Requirement",
      agent: "Requirement Analyst",
      status: requirementPackage.readiness === "blocked"
        ? "blocked"
        : requirementPackage.readiness === "needs_clarification"
          ? "warning"
          : "completed",
      inputRefs: ["IntentResult", "KnowledgeContext", "ContextFetchResult", "userInput"],
      outputRefs: ["RequirementAnalysis", "RequirementPackage"],
      summary: requirementPackage.summary,
      decisionTrace: buildPublicTrace({
        summary: "Requirement 将用户事实、知识事实、上下文事实和 AI 假设合并为同一份需求包。",
        inputSignals: [
          `用户事实 ${requirementPackage.userFacts.length} 条。`,
          `知识事实 ${requirementPackage.knowledgeFacts.length} 条。`,
          `上下文事实 ${requirementPackage.contextFacts.length} 条。`,
          `需求完整度 ${requirement?.completenessScore ?? "未知"}。`,
        ],
        constraints: requirementPackage.constraints.slice(0, 6),
        assumptions: requirementPackage.assumptions.slice(0, 6),
        alternativesConsidered: ["继续规划", "先澄清", "阻断不可执行输入"],
        decision: `RequirementPackage.readiness=${requirementPackage.readiness}`,
        risks: requirementPackage.conflicts.slice(0, 6),
        nextStep: "Planner、Validator 和 Safety Check 消费同一份 RequirementPackage。",
      }),
    },
    {
      id: `${context.runId}:planner`,
      name: "planner",
      title: "Planner",
      agent: "Product Planner",
      status: productBuildPlan ? "completed" : requirementPackage.flowType === "patch" ? "completed" : "warning",
      inputRefs: ["RequirementPackage"],
      outputRefs: productBuildPlan ? ["ProductBuildPlan"] : ["Patch route does not require ProductBuildPlan"],
      summary: productBuildPlan?.summary ?? "局部修改路线不生成 ProductBuildPlan，由 Patch Agent 接管。",
      decisionTrace: buildPublicTrace({
        summary: productBuildPlan
          ? "Planner 已把需求包拆成范围、页面、状态覆盖、下游 agent 顺序和风险。"
          : "Planner 在局部修改路线中让位给 Patch Agent。",
        inputSignals: [
          `流程类型：${requirementPackage.flowType}`,
          `需求包：${requirementPackage.id}`,
          productBuildPlan ? `页面 ${productBuildPlan.pagePlan.length} 个，状态 ${productBuildPlan.statePlan.length} 个。` : "",
        ],
        constraints: requirementPackage.constraints.slice(0, 6),
        assumptions: (productBuildPlan?.assumptions ?? requirementPackage.assumptions).slice(0, 6),
        alternativesConsidered: ["正式需求计划", "只生成 PRD", "只进入原型", "局部修改 Patch"],
        decision: productBuildPlan
          ? `生成 ProductBuildPlan：${productBuildPlan.title}`
          : "本轮交给 Patch 候选链路。",
        risks: productBuildPlan?.risks?.map((risk) => risk.description).slice(0, 6) ?? requirementPackage.conflicts.slice(0, 6),
        nextStep: "Validator 和 Safety Check 使用同一份需求包与计划进行生成前检查。",
      }),
    },
    {
      id: `${context.runId}:validator`,
      name: "validator",
      title: "Validator",
      agent: "Requirement Validator",
      status: validation.status === "block" ? "blocked" : validation.status === "warn" ? "warning" : "completed",
      inputRefs: ["RequirementPackage", productBuildPlan ? "ProductBuildPlan" : ""].filter(Boolean),
      outputRefs: ["RequirementValidationResult"],
      summary: validation.summary,
      decisionTrace: buildPublicTrace({
        summary: "Validator 检查需求包、计划、选区和版本条件是否可执行。",
        inputSignals: [
          `需求包：${requirementPackage.id}`,
          productBuildPlan ? `计划：${productBuildPlan.id}` : "无 ProductBuildPlan。",
          `requiredClarifications=${validation.requiredClarifications.length}`,
        ],
        constraints: requirementPackage.constraints.slice(0, 6),
        assumptions: requirementPackage.assumptions.slice(0, 6),
        alternativesConsidered: ["通过", "带警告继续", "要求澄清", "阻断"],
        decision: `RequirementValidationResult.status=${validation.status}`,
        risks: unique([...validation.conflicts, ...validation.invalidOperations, ...validation.missingFields]).slice(0, 6),
        nextStep: "与 Safety Check 的结果合并为 GateDecision。",
      }),
    },
    {
      id: `${context.runId}:safety`,
      name: "safety",
      title: "Safety Check",
      agent: "Safety Check",
      status: safety.status === "block" ? "blocked" : safety.status === "warn" ? "warning" : "completed",
      inputRefs: ["RequirementPackage", productBuildPlan ? "ProductBuildPlan" : ""].filter(Boolean),
      outputRefs: ["RequirementSafetyCheckResult"],
      summary: safety.summary,
      decisionTrace: buildPublicTrace({
        summary: "Safety Check 检查提示注入、密钥泄漏、越权、隐私和真实外部动作风险。",
        inputSignals: [
          `riskTypes=${safety.riskTypes.join(", ") || "none"}`,
          `blockedReasons=${safety.blockedReasons.length}`,
          `warnings=${safety.warnings.length}`,
        ],
        constraints: ["不能泄露密钥、不能绕过确认门、不能执行真实外部动作。"],
        assumptions: [],
        alternativesConsidered: ["通过", "带警告继续", "安全替代方案", "阻断"],
        decision: `RequirementSafetyCheckResult.status=${safety.status}`,
        risks: unique([...safety.blockedReasons, ...safety.warnings]).slice(0, 6),
        nextStep: "与 Validator 的结果合并为 GateDecision。",
      }),
    },
    {
      id: `${context.runId}:gate`,
      name: "gate",
      title: "Gate",
      agent: "Requirement Gate",
      status: gate.action === "blocked"
        ? "blocked"
        : gate.action === "ask_clarification" || gate.action === "degraded_continue"
          ? "warning"
          : "completed",
      inputRefs: ["RequirementValidationResult", "RequirementSafetyCheckResult", "RequirementPackage"],
      outputRefs: ["RequirementGateDecision"],
      summary: gate.visibleMessage,
      decisionTrace: gateDecisionTrace(gate),
    },
  ];

  return {
    schema: "requirement.intake.graph.v1",
    runId: context.runId,
    projectId: context.projectId,
    requirementPackageId: requirementPackage.id,
    productBuildPlanId: productBuildPlan?.id,
    gateAction: gate.action,
    nodes,
    edges: [
      { from: "intent", to: "knowledge", mode: "async", summary: "Intent 完成后异步启动 Knowledge。" },
      { from: "intent", to: "context_fetch", mode: "async", summary: "Intent 完成后异步启动 Context Fetch。" },
      { from: "knowledge", to: "requirement", mode: "sync", summary: "Knowledge 输出知识事实和规则。" },
      { from: "context_fetch", to: "requirement", mode: "sync", summary: "Context Fetch 输出项目事实和 trace refs。" },
      { from: "requirement", to: "planner", mode: "shared_input", summary: "Planner 消费 RequirementPackage。" },
      { from: "requirement", to: "validator", mode: "shared_input", summary: "Validator 消费同一份 RequirementPackage。" },
      { from: "requirement", to: "safety", mode: "shared_input", summary: "Safety Check 消费同一份 RequirementPackage。" },
      { from: "planner", to: "validator", mode: "sync", summary: "Validator 同时检查 ProductBuildPlan。" },
      { from: "planner", to: "safety", mode: "sync", summary: "Safety Check 同时检查 ProductBuildPlan。" },
      { from: "validator", to: "gate", mode: "sync", summary: "Validator 决定结构可执行性。" },
      { from: "safety", to: "gate", mode: "sync", summary: "Safety Check 决定安全边界。" },
    ],
    summary: `Intent -> Knowledge/Context -> Requirement -> Planner/Validator/Safety -> Gate 已完成；Gate 动作为 ${gate.action}。`,
  };
}

export function buildRequirementNodeTrace(
  step: AgentStepName,
  output: unknown,
  overrides: Partial<AgentDecisionTrace> = {},
): AgentDecisionTrace {
  const base = traceForStep(step, output);
  return {
    ...base,
    ...overrides,
    inputSignals: overrides.inputSignals ?? base.inputSignals,
    constraints: overrides.constraints ?? base.constraints,
    assumptions: overrides.assumptions ?? base.assumptions,
    alternativesConsidered: overrides.alternativesConsidered ?? base.alternativesConsidered,
    risks: overrides.risks ?? base.risks,
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

function knowledgeItemCount(context: KnowledgeContext) {
  return knowledgeItems(context).length;
}

function traceForStep(step: AgentStepName, output: unknown): AgentDecisionTrace {
  const outputRecord = output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {};
  const summary = typeof outputRecord.summary === "string" ? outputRecord.summary : "";
  const mapping: Partial<Record<AgentStepName, AgentDecisionTrace>> = {
    context_fetch: buildPublicTrace({
      summary: summary || "Context Fetch 已读取项目状态、对话、附件和选区。",
      inputSignals: ["项目状态", "最近对话", "附件摘要", "选区"],
      constraints: ["只读取上下文，不做业务决策。"],
      assumptions: [],
      alternativesConsidered: ["读取已有状态", "读取对话", "读取附件", "读取选区"],
      decision: "把上下文事实交给 RequirementPackage。",
      risks: [],
      nextStep: "等待 Knowledge 并进入 Requirement。",
    }),
    requirement_packaging: buildPublicTrace({
      summary: summary || "RequirementPackage 已整理完成。",
      inputSignals: ["用户事实", "知识事实", "上下文事实", "AI 假设", "trace refs"],
      constraints: ["Planner、Validator、Safety Check 必须消费同一份 RequirementPackage。"],
      assumptions: textArray(outputRecord.assumptions),
      alternativesConsidered: ["继续规划", "请求澄清", "阻断"],
      decision: `RequirementPackage.readiness=${String(outputRecord.readiness ?? "unknown")}`,
      risks: textArray(outputRecord.conflicts),
      nextStep: "进入 Planner，并在生成前运行 Validator 与 Safety Check。",
    }),
    requirement_validation: buildPublicTrace({
      summary: summary || "生成前结构校验完成。",
      inputSignals: ["RequirementPackage", "ProductBuildPlan", "selectedRegion", "existingState"],
      constraints: ["局部修改必须有选区和可修改状态；正式需求必须有可用计划。"],
      assumptions: [],
      alternativesConsidered: ["通过", "警告继续", "要求澄清", "阻断"],
      decision: `Validation.status=${String(outputRecord.status ?? "unknown")}`,
      risks: [
        ...textArray(outputRecord.invalidOperations),
        ...textArray(outputRecord.missingFields),
        ...textArray(outputRecord.conflicts),
      ],
      nextStep: "等待 Safety Check 后合并 GateDecision。",
    }),
    safety_check: buildPublicTrace({
      summary: summary || "生成前安全检查完成。",
      inputSignals: ["RequirementPackage.userInput", "RequirementPackage.assumptions", "ProductBuildPlan.summary"],
      constraints: ["不能泄露密钥、不能越权、不能执行真实外部动作。"],
      assumptions: [],
      alternativesConsidered: ["通过", "警告继续", "提供安全替代", "阻断"],
      decision: `Safety.status=${String(outputRecord.status ?? "unknown")}`,
      risks: [
        ...textArray(outputRecord.blockedReasons),
        ...textArray(outputRecord.warnings),
      ],
      nextStep: "等待 Validator 后合并 GateDecision。",
    }),
  };

  return mapping[step] ?? buildPublicTrace({
    summary: summary || `${step} 已完成。`,
    inputSignals: [],
    constraints: [],
    assumptions: [],
    alternativesConsidered: ["继续", "澄清", "阻断"],
    decision: `${step} completed`,
    risks: [],
    nextStep: "进入下一节点。",
  });
}

function buildPublicTrace(input: Omit<AgentDecisionTrace, "generatedBy">): AgentDecisionTrace {
  return {
    summary: input.summary,
    inputSignals: compactTextList(input.inputSignals),
    constraints: compactTextList(input.constraints),
    assumptions: compactTextList(input.assumptions),
    alternativesConsidered: compactTextList(input.alternativesConsidered),
    decision: input.decision,
    risks: compactTextList(input.risks),
    nextStep: input.nextStep,
    generatedBy: "deterministic",
  };
}

function textArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 8);
}

function compactTextList(values: string[]) {
  return unique(values).slice(0, 8);
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
