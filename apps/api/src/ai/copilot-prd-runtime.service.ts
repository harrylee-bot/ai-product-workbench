import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventType, RunAgentInputSchema, type Message, type RunAgentInput } from "@ag-ui/core";
import {
  ConversationStatus,
  KnowledgeType,
  MessageRole,
  MessageType,
  ProjectStatus,
  RuntimeRunStatus,
  UserRole,
  type RuntimeRunLog,
} from "@prisma/client";
import type { Response } from "express";
import type { AuthenticatedUser } from "../auth/auth.types";
import { KnowledgeRetrievalService } from "../knowledge/knowledge-retrieval.service";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type { RequirementDocument, RequirementDocSection } from "./ai-vibe.types";
import {
  DeerFlowRuntimeService,
  type DeerFlowFinalAction,
  type DeerFlowRuntimeEvent,
} from "./deerflow-runtime.service";
import { FinalActionApplierService } from "./final-action-applier.service";
import { ProductDesignStateService } from "./product-design-state.service";
import { RuntimeRunLogService } from "./runtime-run-log.service";
import { classifyRequirementMode, type RequirementMode } from "./requirement-mode.helper";

export const WORKBENCH_PRD_AGENT_ID = "workbench-prd";
export const PRD_STATE_KEY = "workbenchPrd";

type AgUiEvent = {
  type: EventType;
  timestamp?: number;
  [key: string]: unknown;
};

export type WorkbenchPrdDocumentState = {
  status: "idle" | "writing" | "ready" | "failed";
  title: string;
  markdown: string;
  sections: Array<{
    id: string;
    title: string;
    level: number;
    order: number;
  }>;
  activeHeadingId?: string;
  prdDocumentId?: string;
  updatedAt: string;
};

type AccessibleConversation = {
  id: string;
  projectId: string;
  ownerId: string;
  project: {
    id: string;
    ownerId: string;
    status: ProjectStatus;
    deletedAt: Date | null;
  };
};

@Injectable()
export class CopilotPrdRuntimeService {
  private readonly activeRunControllers = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessageService,
    private readonly runLogs: RuntimeRunLogService,
    private readonly productState: ProductDesignStateService,
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
    private readonly deerFlow: DeerFlowRuntimeService,
    private readonly finalActionApplier: FinalActionApplierService,
  ) {}

  getInfo() {
    return {
      version: "0.0.57",
      mode: "sse",
      agents: {
        [WORKBENCH_PRD_AGENT_ID]: {
          description: "生成产品需求文档（PRD），并把正式文档流式写入右侧预览区。",
          capabilities: {
            transport: { streaming: true },
            state: { snapshots: true, deltas: false, persistentState: true },
            output: { supportedMimeTypes: ["text/plain", "text/markdown", "application/json"] },
            tools: { supported: false, clientProvided: false },
          },
        },
      },
    };
  }

  async connect(user: AuthenticatedUser, agentId: string, body: unknown, response: Response) {
    this.assertAgent(agentId);
    const input = this.parseRunInput(body);
    const conversation = await this.getAccessibleConversation(user, input.threadId);
    const [messages, document] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "asc" },
        take: 100,
      }),
      this.getLatestDocument(conversation.projectId),
    ]);

    this.prepareSse(response);
    this.send(response, {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
      input,
    });
    this.send(response, {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: messages.map((message) => dbMessageToAgUi(message)),
    });
    this.sendPrdState(response, document ? documentToState(document, "ready") : emptyPrdState());
    this.send(response, {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      result: { connected: true },
      outcome: { type: "success" },
    });
    response.end();
  }

  async run(user: AuthenticatedUser, agentId: string, body: unknown, response: Response) {
    this.assertAgent(agentId);
    const input = this.parseRunInput(body);
    const conversation = await this.getAccessibleConversation(user, input.threadId);
    const userText = extractLatestUserText(input.messages);
    if (!userText) throw new BadRequestException("AG-UI 请求缺少用户消息");

    this.prepareSse(response);

    const run = await this.runLogs.createRun({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      userId: user.id,
      userInput: userText,
    });
    const controller = new AbortController();
    this.activeRunControllers.set(run.id, controller);

    await this.messages.createUserMessage({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      userId: user.id,
      content: userText,
      metadata: toInputJson({ source: "copilotkit", agentId }),
      relatedRunId: run.id,
    });

    const assistantMessageId = `assistant:${run.id}`;
    const activityMessageId = `activity:${run.id}`;
    const writer = new AgUiWriter(response, input.threadId, run.id, assistantMessageId);
    let prdState = emptyPrdState("writing");
    let lastStepName: string | undefined;

    writer.send({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: run.id,
      input: { ...input, runId: run.id },
    });
    writer.say("收到，我会先生成 PRD。正文会在右侧文档区同步写入。");
    this.sendPrdState(response, prdState);

    try {
      if (!this.deerFlow.isEnabled()) {
        throw new Error("DeerFlow 未启用，无法生成 PRD。");
      }

      const productDesignState = await this.productState.getCurrentState(conversation.projectId);
      const requirementMode = classifyRequirementMode(userText, { hasExistingState: Boolean(productDesignState) });
      const knowledgeContext = await this.retrieveKnowledge({
        projectId: conversation.projectId,
        conversationId: conversation.id,
        runId: run.id,
        message: userText,
        requirementMode,
      });

      const deerFlowResult = await this.deerFlow.runTurn({
        runId: run.id,
        projectId: conversation.projectId,
        conversationId: conversation.id,
        userId: user.id,
        message: buildPrdOnlyPrompt(userText),
        previewMode: "prd",
        productDesignState,
        knowledgeContext,
        signal: controller.signal,
        onEvent: async (event) => {
          if (!(await this.runLogs.isRunRunning(run.id)) || controller.signal.aborted) return;
          if (event.chunk) {
            const delta = safeAssistantDelta(event.chunk);
            if (delta) writer.say(delta);
          }
          const stepName = event.nodeName ?? event.nodeId;
          if (stepName && stepName !== lastStepName) {
            if (lastStepName) writer.stepFinished(lastStepName);
            lastStepName = stepName;
            writer.stepStarted(lastStepName);
          }
          const activity = activityFromDeerFlowEvent(event);
          if (activity) {
            writer.activity(activityMessageId, activity);
          }
        },
      });

      if (controller.signal.aborted || !(await this.runLogs.isRunRunning(run.id))) {
        await this.finishCanceledRun(user, run, writer);
        return;
      }

      if (lastStepName) {
        writer.stepFinished(lastStepName);
        lastStepName = undefined;
      }

      const prdDocument = await this.applyPrdOnlyFinalAction({
        projectId: conversation.projectId,
        userId: user.id,
        runId: run.id,
        finalAction: deerFlowResult.finalAction,
        artifacts: deerFlowResult.artifacts,
      });

      if (!prdDocument) {
        const message = deerFlowResult.finalAction.message || "本轮未生成 PRD。";
        await this.messages.createAssistantMessage({
          projectId: conversation.projectId,
          conversationId: conversation.id,
          content: message,
          type: message.includes("？") ? MessageType.clarification : MessageType.text,
          metadata: toInputJson({
            source: "copilotkit",
            runId: run.id,
            finalAction: deerFlowResult.finalAction,
          }),
          relatedRunId: run.id,
        });
        await this.runLogs.completeRun(run.id, {
          status: "no_prd",
          finalAction: deerFlowResult.finalAction,
          threadId: deerFlowResult.threadId,
        }, message);
        prdState = { ...prdState, status: "idle", updatedAt: new Date().toISOString() };
        this.sendPrdState(response, prdState);
        writer.say(message);
        writer.finish({ status: "no_prd" });
        return;
      }

      const revealSections = [...prdDocument.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (let index = 0; index < revealSections.length; index += 1) {
        const partialDocument = { ...prdDocument, sections: revealSections.slice(0, index + 1) };
        prdState = {
          ...documentToState(partialDocument, "writing"),
          activeHeadingId: revealSections[index]?.id,
        };
        this.sendPrdState(response, prdState);
        if (index < revealSections.length - 1) {
          await delay(readPrdSectionDeltaDelayMs());
        }
      }

      prdState = documentToState(prdDocument, "ready");
      this.sendPrdState(response, prdState);
      await this.messages.createAssistantMessage({
        projectId: conversation.projectId,
        conversationId: conversation.id,
        content: "PRD 已生成，请在右侧文档区检查。",
        type: MessageType.agent_summary,
        metadata: toInputJson({
          source: "copilotkit",
          runId: run.id,
          prdDocumentId: prdDocument.id,
          finalActionType: deerFlowResult.finalAction.type,
          threadId: deerFlowResult.threadId,
        }),
        relatedRunId: run.id,
        relatedPrdDocumentId: prdDocument.id,
      });
      await this.runLogs.completeRun(run.id, {
        status: "success",
        threadId: deerFlowResult.threadId,
        finalAction: deerFlowResult.finalAction,
        prdDocument,
      }, "PRD 已生成");
      writer.say("PRD 已生成，请在右侧文档区检查。");
      writer.finish({ status: "success", prdDocumentId: prdDocument.id });
    } catch (error) {
      if (controller.signal.aborted || await this.isRunCancelled(run.id)) {
        await this.finishCanceledRun(user, run, writer);
        return;
      }
      const message = error instanceof Error ? error.message : "PRD 生成失败";
      await this.runLogs.failRun(run.id, error);
      await this.messages.createAssistantMessage({
        projectId: conversation.projectId,
        conversationId: conversation.id,
        content: `PRD 生成失败：${message}`,
        type: MessageType.error,
        metadata: toInputJson({ source: "copilotkit", runId: run.id, errorMessage: message }),
        relatedRunId: run.id,
      });
      prdState = { ...prdState, status: "failed", updatedAt: new Date().toISOString() };
      this.sendPrdState(response, prdState);
      writer.error(message);
    } finally {
      this.activeRunControllers.delete(run.id);
      if (!response.writableEnded) response.end();
    }
  }

  async stop(user: AuthenticatedUser, agentId: string, threadId: string) {
    this.assertAgent(agentId);
    const conversation = await this.getAccessibleConversation(user, threadId);
    const run = await this.prisma.runtimeRunLog.findFirst({
      where: { conversationId: conversation.id, status: RuntimeRunStatus.running },
      orderBy: { startedAt: "desc" },
    });
    if (!run) return { ok: true, skipped: true };
    this.activeRunControllers.get(run.id)?.abort();
    const result = await this.runLogs.cancelRun({
      runId: run.id,
      canceledBy: user.id,
      reason: "用户停止 CopilotKit PRD 生成",
    });
    return { ok: true, runId: run.id, result };
  }

  private async retrieveKnowledge(input: {
    projectId: string;
    conversationId: string;
    runId: string;
    message: string;
    requirementMode: RequirementMode;
  }) {
    const retrieval = await this.knowledgeRetrieval.search({
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      runtimeName: "runtime_generation",
      query: input.message,
      limit: 8,
      requirementMode: input.requirementMode,
      preferredTypes: [
        KnowledgeType.strong_rule,
        KnowledgeType.default_rule,
        KnowledgeType.design_pattern,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.business_concept,
        KnowledgeType.reference_case,
        KnowledgeType.product_architecture,
        KnowledgeType.page_inventory,
        KnowledgeType.ui_style_guide,
      ],
    });
    return retrieval.references.map((ref) => ({
      id: ref.id,
      title: ref.title,
      snippet: ref.snippet,
      content: ref.content,
      type: ref.type,
      score: ref.score,
      semanticScore: ref.semanticScore,
      reason: ref.reason,
    }));
  }

  private async applyPrdOnlyFinalAction(input: {
    projectId: string;
    userId: string;
    runId: string;
    finalAction: DeerFlowFinalAction;
    artifacts: Parameters<FinalActionApplierService["apply"]>[0]["artifacts"];
  }) {
    if (input.finalAction.type !== "review_prd") return null;
    const applied = await this.finalActionApplier.apply(input);
    return applied.prdDocument ?? null;
  }

  private async finishCanceledRun(user: AuthenticatedUser, run: RuntimeRunLog, writer: AgUiWriter) {
    await this.runLogs.cancelRun({
      runId: run.id,
      canceledBy: user.id,
      reason: "用户停止 CopilotKit PRD 生成",
    });
    await this.messages.createAssistantMessage({
      projectId: run.projectId,
      conversationId: run.conversationId,
      content: "已停止当前 PRD 生成。",
      type: MessageType.text,
      metadata: toInputJson({ source: "copilotkit", runId: run.id, canceled: true }),
      relatedRunId: run.id,
    });
    writer.say("已停止当前 PRD 生成。");
    writer.finish({ status: "canceled" });
  }

  private async isRunCancelled(runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return run?.status === RuntimeRunStatus.cancelled;
  }

  private assertAgent(agentId: string) {
    if (agentId !== WORKBENCH_PRD_AGENT_ID) {
      throw new NotFoundException("CopilotKit agent 不存在");
    }
  }

  private parseRunInput(body: unknown): RunAgentInput {
    const parsed = RunAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("非法 AG-UI 请求");
    }
    return parsed.data;
  }

  private async getAccessibleConversation(user: AuthenticatedUser, conversationId: string): Promise<AccessibleConversation> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.status === ConversationStatus.deleted || conversation.deletedAt) {
      throw new NotFoundException("会话不存在");
    }
    if (conversation.project.status === ProjectStatus.deleted || conversation.project.deletedAt) {
      throw new NotFoundException("项目不存在");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该会话");
    }
    if (user.role === UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("管理员不可直接操作用户项目");
    }
    return conversation;
  }

  private async getLatestDocument(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { currentPrdDocumentId: true },
    });
    const row = project?.currentPrdDocumentId
      ? await this.prisma.requirementDocument.findUnique({ where: { id: project.currentPrdDocumentId } })
      : await this.prisma.requirementDocument.findFirst({
          where: { projectId },
          orderBy: { updatedAt: "desc" },
        });
    return row ? rowToRequirementDocument(row) : null;
  }

  private prepareSse(response: Response) {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();
  }

  private send(response: Response, event: AgUiEvent) {
    if (response.writableEnded || response.destroyed) return;
    response.write(`data: ${JSON.stringify({ timestamp: Date.now(), ...event })}\n\n`);
  }

  private sendPrdState(response: Response, state: WorkbenchPrdDocumentState) {
    this.send(response, {
      type: EventType.STATE_SNAPSHOT,
      snapshot: { [PRD_STATE_KEY]: state },
    });
  }
}

class AgUiWriter {
  private textOpen = false;
  private hasText = false;

  constructor(
    private readonly response: Response,
    private readonly threadId: string,
    private readonly runId: string,
    private readonly messageId: string,
  ) {}

  send(event: AgUiEvent) {
    if (this.response.writableEnded || this.response.destroyed) return;
    this.response.write(`data: ${JSON.stringify({ timestamp: Date.now(), ...event })}\n\n`);
  }

  say(delta: string) {
    if (!delta.trim()) return;
    if (!this.textOpen) {
      this.textOpen = true;
      this.send({
        type: EventType.TEXT_MESSAGE_START,
        messageId: this.messageId,
        role: "assistant",
      });
    }
    this.hasText = true;
    this.send({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: this.messageId,
      delta,
    });
  }

  stepStarted(stepName: string) {
    this.send({ type: EventType.STEP_STARTED, stepName });
  }

  stepFinished(stepName: string) {
    this.send({ type: EventType.STEP_FINISHED, stepName });
  }

  activity(messageId: string, content: Record<string, unknown>) {
    this.send({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId,
      activityType: "workbench-prd-progress",
      replace: true,
      content,
    });
  }

  finish(result: Record<string, unknown>) {
    this.closeText();
    this.send({
      type: EventType.RUN_FINISHED,
      threadId: this.threadId,
      runId: this.runId,
      result,
      outcome: { type: "success" },
    });
  }

  error(message: string) {
    this.closeText();
    this.send({
      type: EventType.RUN_ERROR,
      message,
      code: "workbench_prd_runtime_error",
    });
  }

  private closeText() {
    if (!this.textOpen) return;
    if (!this.hasText) {
      this.send({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: this.messageId,
        delta: "本轮已结束。",
      });
    }
    this.send({
      type: EventType.TEXT_MESSAGE_END,
      messageId: this.messageId,
    });
    this.textOpen = false;
    this.hasText = false;
  }
}

function extractLatestUserText(messages: RunAgentInput["messages"]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((part) => part.type === "text" ? part.text : "")
        .join("\n")
        .trim();
    }
  }
  return "";
}

function buildPrdOnlyPrompt(userText: string) {
  return [
    userText,
    "",
    "当前系统阶段只做 PRD 单流程。请只生成产品需求文档，不生成原型、不执行 QA、不进入确认门。",
    "最终 final action 必须优先使用 review_prd，并提供 prdDocumentDraft 或 PRD markdown artifact。",
    "如果缺少阻塞信息，可以 ask_clarification；不要返回 review_prototype。",
  ].join("\n");
}

function safeAssistantDelta(delta: string) {
  const trimmed = delta.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.includes("ai_product_workbench_final_action")) return "";
  if (looksLikeFullPrd(trimmed)) return "";
  if (trimmed.length > 220) return "";
  return delta;
}

function activityFromDeerFlowEvent(event: DeerFlowRuntimeEvent) {
  if (event.toolCalls?.length) {
    return {
      label: "关键调用",
      detail: event.toolCalls.map((call) => call.name).filter(Boolean).join("、"),
      status: "running",
    };
  }
  if (event.toolCallId) {
    return {
      label: "调用完成",
      detail: event.toolName ?? event.toolCallId,
      status: "done",
    };
  }
  if (event.content && !safeAssistantDelta(event.content)) {
    return {
      label: "执行过程",
      detail: event.content.slice(0, 120),
      status: "running",
    };
  }
  return null;
}

function dbMessageToAgUi(message: {
  id: string;
  role: MessageRole;
  content: string;
}): Message {
  return {
    id: message.id,
    role: message.role === MessageRole.user ? "user" : "assistant",
    content: compactChatContent(message.role, message.content),
  } as Message;
}

function compactChatContent(role: MessageRole, content: string) {
  if (role !== MessageRole.assistant) return content;
  const trimmed = content.trim();
  if (trimmed.length <= 800 && !looksLikeFullPrd(trimmed)) return trimmed;
  return "PRD 已生成，请在右侧文档区查看。";
}

function looksLikeFullPrd(content: string) {
  const headingCount = (content.match(/^#{1,3}\s+/gm) ?? []).length;
  return headingCount >= 3 || content.includes("需求文档（PRD）") || content.includes("产品需求文档");
}

function rowToRequirementDocument(row: {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  status: string;
  sections: unknown;
  assumptions: unknown;
  knowledgeRefs: unknown;
  pendingQuestions: unknown;
  validationNotes: unknown;
  generatedByRunId: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RequirementDocument {
  return {
    id: row.id,
    projectId: row.projectId,
    productDesignStateId: row.productDesignStateId,
    productDesignStateVersion: row.productDesignStateVersion,
    title: row.title,
    status: row.status as RequirementDocument["status"],
    sections: Array.isArray(row.sections) ? row.sections as RequirementDocSection[] : [],
    assumptions: Array.isArray(row.assumptions) ? row.assumptions as RequirementDocument["assumptions"] : [],
    knowledgeRefs: Array.isArray(row.knowledgeRefs) ? row.knowledgeRefs as RequirementDocument["knowledgeRefs"] : [],
    pendingQuestions: Array.isArray(row.pendingQuestions) ? row.pendingQuestions as RequirementDocument["pendingQuestions"] : [],
    validationNotes: Array.isArray(row.validationNotes) ? row.validationNotes as string[] : [],
    generatedByRunId: row.generatedByRunId ?? undefined,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function documentToState(document: RequirementDocument, status: WorkbenchPrdDocumentState["status"]): WorkbenchPrdDocumentState {
  const sections = [...(document.sections ?? [])]
    .filter((section) => section.title || section.content)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    status,
    title: document.title || "产品需求文档（PRD）",
    markdown: documentToMarkdown({ ...document, sections }),
    sections: sections.map((section, index) => ({
      id: section.id || `section_${index + 1}`,
      title: section.title || `章节 ${index + 1}`,
      level: section.level ? Math.min(Math.max(section.level + 1, 2), 4) : headingLevelForTitle(section.title),
      order: section.order ?? index,
    })),
    activeHeadingId: sections.at(-1)?.id,
    prdDocumentId: document.id,
    updatedAt: document.updatedAt || new Date().toISOString(),
  };
}

function documentToMarkdown(document: RequirementDocument) {
  const lines = [`# ${document.title || "产品需求文档（PRD）"}`];
  const sections = [...(document.sections ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const section of sections) {
    const title = section.title?.trim();
    const content = section.content?.trim();
    if (!title && !content) continue;
    lines.push("", `## ${title || "未命名章节"}`, "");
    if (content) lines.push(content);
    const blockText = section.blocks
      ?.map((block) => block.content?.trim())
      .filter(Boolean)
      .join("\n\n");
    if (blockText && blockText !== content) {
      lines.push("", blockText);
    }
  }
  return lines.join("\n").trim();
}

function emptyPrdState(status: WorkbenchPrdDocumentState["status"] = "idle"): WorkbenchPrdDocumentState {
  return {
    status,
    title: "产品需求文档（PRD）",
    markdown: "",
    sections: [],
    updatedAt: new Date().toISOString(),
  };
}

function headingLevelForTitle(title?: string) {
  const numericDepth = title?.match(/^(\d+(?:\.\d+)*)/)?.[1]?.split(".").length;
  return Math.min(Math.max((numericDepth ?? 1) + 1, 2), 4);
}

function readPrdSectionDeltaDelayMs() {
  const value = Number(process.env.PRD_SECTION_DELTA_DELAY_MS);
  if (Number.isFinite(value) && value >= 0) return value;
  return 60;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
