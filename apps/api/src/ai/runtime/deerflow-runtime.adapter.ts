import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ExternalRuntimeConfigService } from "./external-runtime-config.service";
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeResult,
  RuntimeTask,
  RequirementRuntimeInput,
  RequirementRuntimeOutput,
} from "./external-runtime.types";
import type {
  AssumptionReference,
  ClarificationQuestionReference,
  ProductDesignDraft,
  RequirementDocumentDraft,
  RequirementDocSection,
} from "../ai-vibe.types";

@Injectable()
export class DeerFlowRuntimeAdapter implements RuntimeAdapter {
  readonly provider = "deerflow" as const;

  constructor(private readonly config: ExternalRuntimeConfigService) {}

  async runTask<TInput, TOutput>(task: RuntimeTask<TInput>): Promise<RuntimeResult<TOutput>> {
    const gatewayUrl = this.config.deerFlowGatewayUrl();
    if (!gatewayUrl) {
      throw new Error("DeerFlow runtime 未配置：请设置 DEERFLOW_GATEWAY_URL");
    }

    if (task.taskType === "intake_requirement") {
      return this.runRequirementIntake(
        task as RuntimeTask<RequirementRuntimeInput>,
        gatewayUrl,
      ) as Promise<RuntimeResult<TOutput>>;
    }

    if (
      task.taskType === "generate_prototype" ||
      task.taskType === "patch_prd" ||
      task.taskType === "patch_prototype" ||
      task.taskType === "qa_review"
    ) {
      return this.runGenericTask(task as RuntimeTask<unknown>, gatewayUrl) as Promise<RuntimeResult<TOutput>>;
    }

    throw new Error(`DeerFlow runtime 暂不支持任务类型：${task.taskType}`);
  }

  private async runRequirementIntake(
    task: RuntimeTask<RequirementRuntimeInput>,
    gatewayUrl: string,
  ): Promise<RuntimeResult<RequirementRuntimeOutput>> {
    const events = [event(task, "runtime_task_started", "DeerFlow runtime 已创建需求规划任务。")];
    const raw = this.config.deerFlowGatewayMode() === "langgraph"
      ? await this.runLangGraphTask(task, gatewayUrl, events)
      : await this.runVibeGatewayTask(task, gatewayUrl, events);
    const output = normalizeRequirementRuntimeOutput(raw, task);
    return {
      provider: this.provider,
      taskId: task.id,
      runId: task.runId,
      status: "completed",
      output,
      artifacts: [{ path: "requirement-runtime-output.json", kind: "json", content: JSON.stringify(output) }],
      events: [...events, event(task, "runtime_task_completed", "DeerFlow runtime 需求规划完成。")],
      raw,
    };
  }

  private async runGenericTask(
    task: RuntimeTask<unknown>,
    gatewayUrl: string,
  ): Promise<RuntimeResult<unknown>> {
    const events = [event(task, "runtime_task_started", `DeerFlow runtime 已创建 ${task.taskType} 任务。`)];
    const raw = this.config.deerFlowGatewayMode() === "langgraph"
      ? await this.runGenericLangGraphTask(task, gatewayUrl, events)
      : await this.runGenericVibeGatewayTask(task, gatewayUrl, events);
    const output = extractGenericRuntimeOutput(raw);
    return {
      provider: this.provider,
      taskId: task.id,
      runId: task.runId,
      status: "completed",
      output,
      artifacts: [{ path: `${task.taskType}-runtime-output.json`, kind: "json", content: JSON.stringify(output) }],
      events: [...events, event(task, "runtime_task_completed", `DeerFlow runtime ${task.taskType} 任务完成。`)],
      raw,
    };
  }

  private async runVibeGatewayTask(
    task: RuntimeTask<RequirementRuntimeInput>,
    gatewayUrl: string,
    events: RuntimeEvent[],
  ) {
    const url = joinUrl(gatewayUrl, this.config.deerFlowGatewayPath());
    events.push(event(task, "runtime_tool_called", "正在调用 DeerFlow Vibe Gateway。", { url }));
    return this.postJson(url, {
      task,
      contract: "vibe.runtime.requirement.v1",
      outputSchema: "RequirementRuntimeOutput",
    });
  }

  private async runGenericVibeGatewayTask(
    task: RuntimeTask<unknown>,
    gatewayUrl: string,
    events: RuntimeEvent[],
  ) {
    const url = joinUrl(gatewayUrl, this.config.deerFlowGatewayPath());
    events.push(event(task, "runtime_tool_called", "正在调用 DeerFlow Vibe Gateway。", { url, taskType: task.taskType }));
    return this.postJson(url, {
      task,
      contract: "vibe.runtime.task.v1",
      outputSchema: outputSchemaName(task.taskType),
    });
  }

  private async runLangGraphTask(
    task: RuntimeTask<RequirementRuntimeInput>,
    gatewayUrl: string,
    events: RuntimeEvent[],
  ) {
    const threadUrl = joinUrl(gatewayUrl, "/api/langgraph/threads");
    events.push(event(task, "runtime_tool_called", "正在创建 DeerFlow LangGraph thread。", { url: threadUrl }));
    const thread = asRecord(await this.postJson(threadUrl, {
      metadata: {
        vibeRunId: task.runId,
        vibeProjectId: task.projectId,
        vibeTaskId: task.id,
      },
    }));
    const threadId = text(thread?.thread_id) || text(thread?.id) || task.runId;
    const runUrl = joinUrl(gatewayUrl, `/api/langgraph/threads/${encodeURIComponent(threadId)}/runs/wait`);
    events.push(event(task, "runtime_tool_called", "正在等待 DeerFlow LangGraph run 输出。", {
      url: runUrl,
      assistantId: this.config.deerFlowAssistantId(),
    }));
    return this.postJson(runUrl, {
      assistant_id: this.config.deerFlowAssistantId(),
      input: {
        messages: [
          {
            role: "user",
            content: requirementPrompt(task.input),
          },
        ],
      },
      metadata: {
        vibeRunId: task.runId,
        vibeProjectId: task.projectId,
        vibeTaskType: task.taskType,
      },
      config: {
        tags: ["vibe-coding", "requirement-intake"],
        configurable: {
          thread_id: threadId,
        },
      },
      stream_mode: ["values"],
      multitask_strategy: "enqueue",
      on_disconnect: "continue",
    });
  }

  private async runGenericLangGraphTask(
    task: RuntimeTask<unknown>,
    gatewayUrl: string,
    events: RuntimeEvent[],
  ) {
    const threadUrl = joinUrl(gatewayUrl, "/api/langgraph/threads");
    events.push(event(task, "runtime_tool_called", "正在创建 DeerFlow LangGraph thread。", { url: threadUrl, taskType: task.taskType }));
    const thread = asRecord(await this.postJson(threadUrl, {
      metadata: {
        vibeRunId: task.runId,
        vibeProjectId: task.projectId,
        vibeTaskId: task.id,
        vibeTaskType: task.taskType,
      },
    }));
    const threadId = text(thread?.thread_id) || text(thread?.id) || task.runId;
    const runUrl = joinUrl(gatewayUrl, `/api/langgraph/threads/${encodeURIComponent(threadId)}/runs/wait`);
    events.push(event(task, "runtime_tool_called", "正在等待 DeerFlow LangGraph run 输出。", {
      url: runUrl,
      assistantId: this.config.deerFlowAssistantId(),
      taskType: task.taskType,
    }));
    return this.postJson(runUrl, {
      assistant_id: this.config.deerFlowAssistantId(),
      input: {
        messages: [
          {
            role: "user",
            content: genericRuntimePrompt(task),
          },
        ],
      },
      metadata: {
        vibeRunId: task.runId,
        vibeProjectId: task.projectId,
        vibeTaskType: task.taskType,
      },
      config: {
        tags: ["vibe-coding", task.taskType],
        configurable: {
          thread_id: threadId,
        },
      },
      stream_mode: ["values"],
      multitask_strategy: "enqueue",
      on_disconnect: "continue",
    });
  }

  private async postJson(url: string, body: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.deerFlowRequestTimeoutMs());
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const textBody = await response.text();
      if (!response.ok) {
        throw new Error(`DeerFlow Gateway 请求失败 ${response.status}: ${compact(textBody || response.statusText)}`);
      }
      return parseJsonText(textBody) ?? textBody;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`DeerFlow Gateway 请求超时：${this.config.deerFlowRequestTimeoutMs()}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeRequirementRuntimeOutput(
  raw: unknown,
  task: RuntimeTask<RequirementRuntimeInput>,
): RequirementRuntimeOutput {
  const parsed = extractRuntimeJson(raw);
  const record = asRecord(parsed);
  const output = firstRecord(
    record?.output,
    record?.data,
    record?.result,
    record?.values,
    record,
  );
  const productSource = firstRecord(
    output?.productDesignDraft,
    output?.productDesignStateDraft,
    output?.productDesignState,
    output?.state,
  );
  if (!productSource) {
    throw new Error("DeerFlow runtime 输出缺少 productDesignDraft");
  }

  const productDesignDraft = normalizeProductDesignDraft(productSource, task);
  const prdSource = firstRecord(
    output?.requirementDocumentDraft,
    output?.prdDraft,
    output?.prdDocumentDraft,
    output?.requirementDocument,
  );
  const requirementDocumentDraft = prdSource
    ? normalizeRequirementDocumentDraft(prdSource, productDesignDraft, task)
    : undefined;

  return {
    productDesignDraft,
    requirementDocumentDraft,
    message: text(output?.message) || text(output?.summary) || undefined,
    clarificationQuestions: recordArray(output?.clarificationQuestions ?? productDesignDraft.pendingQuestions),
    risks: recordArray(output?.risks),
  };
}

function extractGenericRuntimeOutput(raw: unknown): unknown {
  const parsed = extractRuntimeJson(raw);
  const record = asRecord(parsed);
  if (!record) return parsed;
  return firstRecord(
    record.output,
    record.data,
    record.result,
    record.values,
  ) ?? record;
}

function outputSchemaName(taskType: RuntimeTask["taskType"]) {
  const names: Partial<Record<RuntimeTask["taskType"], string>> = {
    generate_prototype: "PrototypeSpec",
    patch_prd: "PatchPlan",
    patch_prototype: "PatchPlan",
    qa_review: "QAProtocolOutput",
  };
  return names[taskType] ?? "RuntimeOutput";
}

function genericRuntimePrompt(task: RuntimeTask<unknown>) {
  return [
    "你是 Vibe Coding 的 DeerFlow runtime。",
    "请基于下面的 task JSON 完成规划/审查，并输出严格 JSON，不要输出 Markdown 解释。",
    `任务类型：${task.taskType}`,
    `输出 schema：${outputSchemaName(task.taskType)}`,
    "约束：",
    "- 不要直接写业务数据库。",
    "- 不要执行真实外部副作用。",
    "- 不要把 AI 假设伪装成用户确认事实。",
    "- 信息不足时，用 risks、issues、pendingQuestions 或 clarificationQuestions 表达。",
    "- 输出必须能被 Vibe adapter 转成对应 schema。",
    "",
    `task: ${JSON.stringify(task)}`,
  ].join("\n");
}

function normalizeProductDesignDraft(
  source: Record<string, unknown>,
  task: RuntimeTask<RequirementRuntimeInput>,
): ProductDesignDraft {
  const title = text(source.title) || titleFromUserInput(task.input.userInput);
  return {
    projectId: task.projectId,
    title,
    summary: text(source.summary) || text(source.description) || `根据用户输入生成：${task.input.userInput}`,
    background: optionalText(source.background),
    businessGoal: text(source.businessGoal) || text(source.goal) || "待补充业务目标",
    targetUsers: recordArray(source.targetUsers),
    userScenarios: recordArray(source.userScenarios ?? source.scenarios),
    pages: recordArray(source.pages),
    features: recordArray(source.features),
    backendConfigs: recordArray(source.backendConfigs),
    frontendRules: recordArray(source.frontendRules),
    businessRules: recordArray(source.businessRules),
    stateRules: recordArray(source.stateRules),
    exceptionScenarios: recordArray(source.exceptionScenarios),
    acceptanceCriteria: recordArray(source.acceptanceCriteria),
    prototypeOutline: asRecord(source.prototypeOutline) ?? undefined,
    assumptions: recordArray(source.assumptions),
    knowledgeRefs: recordArray(source.knowledgeRefs),
    pendingQuestions: recordArray(source.pendingQuestions ?? source.clarificationQuestions),
    confirmedFacts: recordArray(source.confirmedFacts),
    createdBy: task.userId ?? "deerflow",
    updatedBy: task.userId,
  };
}

function normalizeRequirementDocumentDraft(
  source: Record<string, unknown>,
  state: ProductDesignDraft,
  task: RuntimeTask<RequirementRuntimeInput>,
): RequirementDocumentDraft {
  const sections = recordArray(source.sections)
    .map((section, index) => normalizeSection(section, index))
    .filter((section): section is RequirementDocSection => Boolean(section));
  return {
    projectId: task.projectId,
    title: text(source.title) || `${state.title} PRD`,
    sections: sections.length ? sections : fallbackSectionsFromState(state),
    knowledgeRefs: recordArray(source.knowledgeRefs ?? state.knowledgeRefs),
    assumptions: normalizeAssumptions(source.assumptions),
    pendingQuestions: normalizePendingQuestions(source.pendingQuestions ?? state.pendingQuestions),
    validationNotes: stringArray(source.validationNotes).length
      ? stringArray(source.validationNotes)
      : ["PRD 由 DeerFlow runtime 生成，已通过 Vibe 产品协议落库。"],
  };
}

function normalizeSection(section: Record<string, unknown>, index: number): RequirementDocSection | null {
  const content = text(section.content);
  if (!content) return null;
  return {
    id: safeId(text(section.id) || `section_${index + 1}`),
    title: text(section.title) || `章节 ${index + 1}`,
    type: normalizeSectionType(text(section.type)),
    level: normalizeLevel(section.level),
    order: numberValue(section.order) ?? index + 1,
    content,
    blocks: recordArray(section.blocks) as RequirementDocSection["blocks"],
    sourcePaths: stringArray(section.sourcePaths).length ? stringArray(section.sourcePaths) : ["runtime.deerflow"],
    tags: stringArray(section.tags) as RequirementDocSection["tags"],
  };
}

function fallbackSectionsFromState(state: ProductDesignDraft): RequirementDocSection[] {
  return [
    {
      id: "overview",
      title: "1. 需求概述",
      type: "overview",
      level: 1,
      order: 1,
      content: state.summary || `本需求围绕“${state.title}”生成产品状态和 PRD。`,
      sourcePaths: ["summary"],
    },
    {
      id: "business_goal",
      title: "2. 业务目标",
      type: "business_goal",
      level: 1,
      order: 2,
      content: state.businessGoal,
      sourcePaths: ["businessGoal"],
    },
  ];
}

function normalizeAssumptions(value: unknown): AssumptionReference[] {
  return recordArray(value).map((item, index) => ({
    assumptionId: text(item.assumptionId) || text(item.id) || `assumption_${index + 1}`,
    content: text(item.content) || text(item.description) || text(item.title) || "待确认假设",
    relatedSectionIds: stringArray(item.relatedSectionIds),
    status: normalizeAssumptionStatus(item.status),
  }));
}

function normalizePendingQuestions(value: unknown): ClarificationQuestionReference[] {
  return recordArray(value).map((item, index) => ({
    questionId: text(item.questionId) || text(item.id) || `question_${index + 1}`,
    question: text(item.question) || text(item.title) || text(item.content) || "请补充该需求细节。",
    reason: text(item.reason) || "该信息会影响后续 PRD 或原型生成。",
    relatedSectionIds: stringArray(item.relatedSectionIds),
    status: normalizeQuestionStatus(item.status),
  }));
}

function normalizeAssumptionStatus(value: unknown): AssumptionReference["status"] {
  return value === "confirmed" || value === "rejected" ? value : "pending";
}

function normalizeQuestionStatus(value: unknown): ClarificationQuestionReference["status"] {
  return value === "answered" || value === "skipped" ? value : "pending";
}

function extractRuntimeJson(raw: unknown): unknown {
  const record = asRecord(raw);
  if (record) {
    const direct = firstRecord(record.output, record.data, record.result);
    if (direct) return record;
    const messages = asArray(record.messages ?? record.values);
    const finalMessage = [...messages].reverse()
      .map((item) => text(asRecord(item)?.content ?? item))
      .find(Boolean);
    const parsed = parseJsonText(finalMessage ?? "");
    if (parsed) return parsed;
  }
  if (typeof raw === "string") return parseJsonText(raw) ?? raw;
  return raw;
}

function requirementPrompt(input: RequirementRuntimeInput) {
  return [
    "你是 Vibe Coding 的需求规划 runtime。",
    "请基于用户输入、历史消息、附件摘要和已有 ProductDesignState，输出严格 JSON，不要输出 Markdown 解释。",
    "JSON 顶层结构必须是：",
    "{",
    '  "productDesignDraft": { ...ProductDesignDraft },',
    '  "requirementDocumentDraft": { ...RequirementDocumentDraft },',
    '  "message": "给用户看的简短中文摘要",',
    '  "clarificationQuestions": [],',
    '  "risks": []',
    "}",
    "约束：不要写实现细节、接口 URL、数据库、SQL、部署方案；不要把 AI 假设写成用户确认事实；无法确定的信息写入 assumptions 或 pendingQuestions。",
    "",
    `用户输入：${input.userInput}`,
    `历史消息：${JSON.stringify(input.recentMessages.slice(-8))}`,
    `附件摘要：${JSON.stringify(input.attachments)}`,
    `已有产品状态：${JSON.stringify(input.productDesignState ?? null)}`,
  ].join("\n");
}

function event(
  task: RuntimeTask<unknown>,
  type: RuntimeEvent["type"],
  content: string,
  payload?: unknown,
): RuntimeEvent {
  return {
    id: randomUUID(),
    provider: "deerflow",
    taskId: task.id,
    runId: task.runId,
    type,
    content,
    payload,
    createdAt: new Date().toISOString(),
  };
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function parseJsonText(value: string) {
  const textValue = value.trim();
  if (!textValue) return undefined;
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    const fenced = textValue.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return parseJsonText(fenced);
    const first = textValue.indexOf("{");
    const last = textValue.lastIndexOf("}");
    if (first >= 0 && last > first) return parseJsonText(textValue.slice(first, last + 1));
    return undefined;
  }
}

function firstRecord(...values: unknown[]) {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
}

function stringArray(value: unknown): string[] {
  return asArray(value).map(text).filter(Boolean);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown) {
  const result = text(value);
  return result || undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLevel(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

function normalizeSectionType(value: string): RequirementDocSection["type"] {
  const allowed: RequirementDocSection["type"][] = [
    "overview",
    "background",
    "business_goal",
    "target_users",
    "user_scenarios",
    "scope",
    "page_requirements",
    "backend_configs",
    "frontend_rules",
    "business_rules",
    "state_rules",
    "exception_scenarios",
    "acceptance_criteria",
    "assumptions",
    "knowledge_refs",
    "pending_questions",
    "appendix",
  ];
  return allowed.includes(value as RequirementDocSection["type"])
    ? value as RequirementDocSection["type"]
    : "appendix";
}

function titleFromUserInput(userInput: string) {
  const compactText = compact(userInput);
  return compactText ? compactText.slice(0, 30) : "产品需求方案";
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_").slice(0, 64) || "section";
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
