import type { AgentName, ModelTaskType } from "@prisma/client";
import type { AgentFallbackMetadata } from "./agent-fallback-policy";
import type { AgentDecisionTrace } from "./ai-vibe.types";

type TraceInput = {
  agentName?: AgentName;
  taskType?: ModelTaskType;
  input: unknown;
  output: unknown;
  fallback?: AgentFallbackMetadata;
  modelTrace?: unknown;
};

export const DECISION_TRACE_OUTPUT_INSTRUCTION = [
  "调试期必须在顶层附带 decisionTrace 对象，用于展示可审计决策过程。",
  "decisionTrace 只能写公开、可展示的判断摘要，不要写隐藏链路推理或长篇逐 token 思维。",
  "decisionTrace 字段：summary、inputSignals、constraints、assumptions、alternativesConsidered、decision、risks、nextStep。",
  "每个数组控制在 3-6 条，使用中文自然语言，便于产品调试人员阅读。",
].join("\n");

export function buildAgentDecisionTrace(input: TraceInput): AgentDecisionTrace {
  const fallback = deterministicTrace(input);
  return normalizeAgentDecisionTrace(input.modelTrace, fallback);
}

export function attachDecisionTraceToStepData<T>(data: T, trace?: AgentDecisionTrace): T {
  if (!trace) return data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return {
      ...(data as Record<string, unknown>),
      decisionTrace: trace,
    } as T;
  }

  return {
    value: data,
    decisionTrace: trace,
  } as T;
}

export function readModelDecisionTrace(value: unknown): unknown {
  const record = asRecord(value);
  return record?.decisionTrace ?? record?.debugTrace ?? record?.trace;
}

export function normalizeAgentDecisionTrace(
  value: unknown,
  fallback: AgentDecisionTrace,
): AgentDecisionTrace {
  const record = asRecord(value);
  if (!record) return fallback;

  return {
    summary: oneLine(record.summary) || fallback.summary,
    inputSignals: textList(record.inputSignals, fallback.inputSignals),
    constraints: textList(record.constraints, fallback.constraints),
    assumptions: textList(record.assumptions, fallback.assumptions),
    alternativesConsidered: textList(record.alternativesConsidered, fallback.alternativesConsidered),
    decision: oneLine(record.decision) || fallback.decision,
    risks: textList(record.risks, fallback.risks),
    nextStep: oneLine(record.nextStep) || fallback.nextStep,
    generatedBy: "model",
  };
}

function deterministicTrace({ agentName, taskType, input, output, fallback }: TraceInput): AgentDecisionTrace {
  const agentLabel = agentName ? displayAgentName(agentName) : "Agent";
  const outputRecord = asRecord(output);
  const inputRecord = asRecord(input);
  const fallbackText = fallback
    ? `模型输出不可用，已使用 ${fallback.fallbackMode} 兜底继续。`
    : "";
  const decision = fallbackText || deriveDecision(agentLabel, outputRecord, output);

  return {
    summary: oneLine(outputRecord?.summary ?? outputRecord?.reason ?? fallback?.userMessage)
      || `${agentLabel} 已完成 ${taskType ?? "当前"} 节点，并产出可传递给下游的结果。`,
    inputSignals: pickInputSignals(inputRecord, input),
    constraints: pickConstraints(inputRecord, outputRecord),
    assumptions: pickAssumptions(inputRecord, outputRecord),
    alternativesConsidered: alternativesFor(agentName),
    decision,
    risks: pickRisks(inputRecord, outputRecord, fallback),
    nextStep: nextStepFor(agentName),
    generatedBy: fallback ? "deterministic" : "deterministic",
  };
}

function pickInputSignals(inputRecord: Record<string, unknown> | null, input: unknown) {
  const signals: string[] = [];
  pushText(signals, inputRecord?.userInput, "用户输入");
  pushText(signals, inputRecord?.intent, "识别意图");
  pushText(signals, nested(inputRecord, "selectedRegion.label"), "选区");
  pushText(signals, nested(inputRecord, "knowledgeContext.summary"), "知识上下文");
  pushText(signals, nested(inputRecord, "requirementAnalysis.completenessScore"), "需求完整度");
  pushText(signals, nested(inputRecord, "productBuildPlan.title"), "产品方案");
  pushText(signals, nested(inputRecord, "productDesignState.title"), "产品状态");
  pushText(signals, nested(inputRecord, "prototypeSpec.title"), "原型结构");

  if (!signals.length) {
    const compact = compactJson(input, 220);
    if (compact) signals.push(`输入摘要：${compact}`);
  }
  return limit(signals, 6, ["没有可展示的输入摘要。"]);
}

function pickConstraints(inputRecord: Record<string, unknown> | null, outputRecord: Record<string, unknown> | null) {
  const constraints: string[] = [];
  const strongRules = arrayLength(nested(inputRecord, "knowledgeContext.strongRules"));
  const defaultRules = arrayLength(nested(inputRecord, "knowledgeContext.defaultRules"));
  const skillRoutes = arrayLength(nested(inputRecord, "knowledgeContext.skillRouting"));
  if (strongRules) constraints.push(`命中 ${strongRules} 条强规则，后续输出必须遵守。`);
  if (defaultRules) constraints.push(`命中 ${defaultRules} 条默认规则，作为生成参考。`);
  if (skillRoutes) constraints.push(`加载 ${skillRoutes} 条 skill 路由，需传递给对应 agent。`);
  for (const item of textList(nested(outputRecord, "qaFocus"), [])) {
    constraints.push(`QA 焦点：${item}`);
  }
  for (const item of textList(nested(outputRecord, "scope.outOfScope"), [])) {
    constraints.push(`排除范围：${item}`);
  }
  return limit(constraints, 6, ["本节点按职责边界和上游产物继续执行。"]);
}

function pickAssumptions(inputRecord: Record<string, unknown> | null, outputRecord: Record<string, unknown> | null) {
  const assumptions = [
    ...textList(nested(inputRecord, "requirementAnalysis.inferredByAI"), []),
    ...textList(nested(outputRecord, "sourceSummary.assumptions"), []),
    ...textList(outputRecord?.assumptions, []).map((item) => objectishText(item)),
  ].filter(Boolean);
  return limit(assumptions, 6, ["没有新增需要展示的假设。"]);
}

function pickRisks(
  inputRecord: Record<string, unknown> | null,
  outputRecord: Record<string, unknown> | null,
  fallback?: AgentFallbackMetadata,
) {
  const risks: string[] = [];
  if (fallback) risks.push(fallback.reason || fallback.userMessage);
  for (const item of asArray(outputRecord?.risks)) {
    const record = asRecord(item);
    risks.push(oneLine(record?.description ?? record?.message ?? item));
  }
  for (const item of asArray(outputRecord?.issues)) {
    const record = asRecord(item);
    risks.push(oneLine(record?.title ?? record?.description ?? item));
  }
  for (const item of textList(nested(inputRecord, "requirementAnalysis.conflicts"), [])) {
    risks.push(`需求冲突：${item}`);
  }
  for (const item of textList(nested(inputRecord, "knowledgeContext.unknownAreas"), [])) {
    risks.push(`未知区域：${item}`);
  }
  return limit(risks.filter(Boolean), 6, ["没有识别到阻断风险。"]);
}

function deriveDecision(agentLabel: string, outputRecord: Record<string, unknown> | null, output: unknown) {
  const direct = oneLine(outputRecord?.decision ?? outputRecord?.reason ?? outputRecord?.summary);
  if (direct) return direct;
  const status = oneLine(outputRecord?.status);
  if (status) return `${agentLabel} 输出状态为 ${status}。`;
  return `${agentLabel} 已产出结构化结果：${compactJson(output, 240) || "无额外摘要"}`;
}

function alternativesFor(agentName?: AgentName) {
  const fallback = ["继续主链路", "请求用户澄清", "使用规则兜底"];
  const mapping: Partial<Record<AgentName, string[]>> = {
    intent_agent: ["进入正式需求链路", "进入局部修改链路", "按普通问答处理"],
    knowledge_agent: ["使用正式知识库规则", "使用附件和历史上下文", "无命中时按最佳实践并标记假设"],
    requirement_analyst_agent: ["继续生成", "先向用户澄清", "将缺失项标为待确认假设"],
    product_planner_agent: ["完整正式需求计划", "局部 Patch 计划", "因缺失信息暂停"],
    product_designer_agent: ["创建新产品状态", "补全已有产品状态", "保留待确认假设"],
    prd_writer_agent: ["从产品状态渲染 PRD", "等待状态补齐", "拒绝写实现细节"],
    prototype_designer_agent: ["生成原型结构", "等待 PRD/状态确认", "只覆盖受影响页面"],
    prototype_code_agent: ["生成单文件 HTML", "拒绝真实接口调用", "回退模板渲染"],
    patch_agent: ["生成待确认 PatchPlan", "因强规则冲突暂停", "回退完整再生成"],
    qa_agent: ["通过检查", "给出 warning", "阻断确认并要求修复"],
    knowledge_extractor_agent: ["抽取知识候选", "因未确认不抽取", "等待管理员审核"],
  };
  return mapping[agentName as AgentName] ?? fallback;
}

function nextStepFor(agentName?: AgentName) {
  const mapping: Partial<Record<AgentName, string>> = {
    intent_agent: "把意图交给 Knowledge Agent 或直接结束普通问答。",
    knowledge_agent: "把知识上下文交给 Requirement Analyst。",
    requirement_analyst_agent: "根据完整度决定继续规划或先向用户澄清。",
    product_planner_agent: "把执行方案交给 Product Designer 落入产品状态。",
    product_designer_agent: "从产品状态生成 PRD 草案。",
    prd_writer_agent: "保存 PRD 并进入确认门，确认后再生成原型。",
    prototype_designer_agent: "把原型结构交给 Prototype Code Agent。",
    prototype_code_agent: "保存 HTML 原型并进入 QA 校验。",
    patch_agent: "等待用户确认 PatchPlan 后再应用修改。",
    qa_agent: "根据 QA 结果决定可确认、需关注或阻断。",
    knowledge_extractor_agent: "把候选知识交给审核流程，不直接入正式知识库。",
  };
  return mapping[agentName as AgentName] ?? "把结果交给下一个编排节点。";
}

function displayAgentName(agentName: AgentName) {
  return String(agentName)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function textList(value: unknown, fallback: string[]) {
  const values = asArray(value)
    .map((item) => objectishText(item))
    .map((item) => oneLine(item))
    .filter(Boolean);
  return values.length ? limit(values, 6, fallback) : fallback;
}

function objectishText(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const record = asRecord(value);
  if (!record) return "";
  return String(record.title ?? record.name ?? record.content ?? record.description ?? record.reason ?? record.message ?? "");
}

function pushText(items: string[], value: unknown, label: string) {
  const text = oneLine(value);
  if (text) items.push(`${label}：${text}`);
}

function oneLine(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = objectishText(value).replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

function limit(items: string[], size: number, fallback: string[]) {
  const unique = [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  return unique.length ? unique.slice(0, size) : fallback;
}

function nested(record: Record<string, unknown> | null, path: string) {
  if (!record) return undefined;
  return path.split(".").reduce<unknown>((current, key) => {
    const currentRecord = asRecord(current);
    return currentRecord ? currentRecord[key] : undefined;
  }, record);
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactJson(value: unknown, maxLength: number) {
  try {
    const text = JSON.stringify(sanitize(value));
    if (!text) return "";
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return "";
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitize(item));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).slice(0, 20).map(([key, item]) => {
      const lower = key.toLowerCase();
      if (
        lower.includes("password") ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("apikey") ||
        lower.includes("api_key") ||
        lower.includes("authorization")
      ) {
        return [key, "****"];
      }
      return [key, sanitize(item)];
    }),
  );
}
