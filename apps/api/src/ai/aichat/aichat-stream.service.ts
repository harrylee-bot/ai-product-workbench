import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { KnowledgeType, MessageType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { ConversationService } from "../../modules/conversation/conversation.service";
import { KnowledgeRetrievalService } from "../../knowledge/knowledge-retrieval.service";
import { MessageService } from "../../projects/message.service";
import { DeerFlowRuntimeService } from "../deerflow-runtime.service";
import type { DeerFlowKnowledgeReference } from "../deerflow-runtime.service";
import { FinalActionApplierService } from "../final-action-applier.service";
import { RuntimeRunLogService } from "../runtime-run-log.service";
import { toInputJson } from "../ai-vibe.helpers";
import { classifyRequirementMode, type RequirementMode } from "../requirement-mode.helper";
import {
  createBridgeContext,
  emitDeerFlowEvent,
  emitPrdArtifact,
  emitPrdDocumentPreview,
  emitPrototypeArtifact,
  emitStaticText,
  finishText,
  type UIMessageStreamWriter,
} from "./aichat-ai-sdk-bridge";
import type { ChatStreamDto } from "./aichat-stream.dto";

@Injectable()
export class AichatStreamService {
  private readonly logger = new Logger(AichatStreamService.name);
  /** runId → AbortController，用于 stop by runId。 */
  private readonly activeRunControllers = new Map<string, AbortController>();
  /** conversationId → AbortController，用于 stop by conversationId（取最近一次）。 */
  private readonly activeConversationControllers = new Map<string, AbortController>();

  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
    private readonly deerFlow: DeerFlowRuntimeService,
    private readonly finalActionApplier: FinalActionApplierService,
    private readonly runLogs: RuntimeRunLogService,
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
  ) {}

  /**
   * 主流程：把 DeerFlow 的 SSE 事件翻译成 AI SDK v6 UIMessageStream 并 pipe 到响应。
   */
  async stream(user: AuthenticatedUser, dto: ChatStreamDto, res: Response): Promise<void> {
    const conversationId = dto.id;

    // a) 抽取用户消息文本
    const content = extractUserText(dto.message);
    if (!content) {
      throw new BadRequestException("请求缺少用户消息文本");
    }

    // b) 新对话页的 id 来自前端临时 UUID；首条消息到达时在后端落成真实会话。
    const session = await this.conversations.getOrCreateInternal(
      user,
      conversationId,
      buildConversationTitle(content),
    );
    const { conversation, project } = session;
    const projectId = conversation.projectId ?? project.id;
    const productContext = buildProductContextForDeerFlow(session);

    // c) 持久化用户消息
    await this.messages.createUserMessage({
      projectId,
      conversationId,
      userId: user.id,
      content,
      metadata: toInputJson({ source: "aichat" }),
    });

    if (!this.deerFlow.isEnabled()) {
      throw new BadRequestException("DeerFlow 未启用，无法生成回复。");
    }

    // d) 构建 UIMessageStream
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const ctx = createBridgeContext();
        let deliveredUserVisibleResult = false;
        const run = await this.runLogs.createRun({
          projectId,
          conversationId,
          userId: user.id,
          userInput: content,
        });
        const controller = new AbortController();
        this.activeRunControllers.set(run.id, controller);
        this.activeConversationControllers.set(conversationId, controller);
        let clientClosed = false;
        const markClientClosed = () => {
          clientClosed = true;
        };
        const streamWriter: UIMessageStreamWriter = {
          write: (part) => {
            if (!clientClosed) {
              (writer.write as unknown as (chunk: Record<string, unknown>) => void)(part);
            }
          },
        };
        res.on("close", markClientClosed);

        try {
          streamWriter.write({ type: "start", messageId: randomUUID() });

          const knowledgeContext = await this.retrieveKnowledge({
            projectId,
            conversationId,
            runId: run.id,
            message: content,
          });

          const result = await this.deerFlow.runTurn({
            runId: run.id,
            projectId,
            conversationId,
            userId: user.id,
            message: content,
            previewMode: "prd",
            productDesignState: productContext,
            knowledgeContext,
            signal: controller.signal,
            onEvent: (event) => {
              if (controller.signal.aborted) return;
              emitDeerFlowEvent(event, streamWriter, ctx);
            },
          });

          // 收尾文本/步骤 part
          finishText(streamWriter, ctx);

          // 落地 final action
          const applied = await this.finalActionApplier.apply({
            projectId,
            userId: user.id,
            runId: run.id,
            finalAction: result.finalAction,
            artifacts: result.artifacts,
            assistantText: result.assistantText,
          });

          if (applied.prdDocument) {
            emitStaticText(result.finalAction.message || "PRD 已生成，请在右侧文档区检查。", streamWriter, ctx);
            finishText(streamWriter, ctx);
            emitPrdArtifact(applied.prdDocument, streamWriter);
            emitPrdDocumentPreview(applied.prdDocument, streamWriter);
            deliveredUserVisibleResult = true;
            await this.createAssistantMessageBestEffort({
              projectId,
              conversationId,
              userId: user.id,
              content: result.finalAction.message || "PRD 已生成，请在右侧文档区检查。",
              type: MessageType.agent_summary,
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                prdDocumentId: applied.prdDocument.id,
                prdDocumentTitle: applied.prdDocument.title,
                finalActionType: result.finalAction.type,
                threadId: result.threadId,
              }),
              relatedRunId: run.id,
              relatedPrdDocumentId: applied.prdDocument.id,
            }, run.id);
            await this.completeRunBestEffort(
              run.id,
              {
                status: "success",
                threadId: result.threadId,
                finalAction: result.finalAction,
                prdDocument: applied.prdDocument,
              },
              "PRD 已生成",
            );
          } else if (applied.prototypeArtifact) {
            emitStaticText(result.finalAction.message || "原型已生成，请在右侧预览区查看。", streamWriter, ctx);
            finishText(streamWriter, ctx);
            emitPrototypeArtifact(applied.prototypeArtifact, streamWriter);
            deliveredUserVisibleResult = true;
            await this.createAssistantMessageBestEffort({
              projectId,
              conversationId,
              userId: user.id,
              content: result.finalAction.message || "原型已生成，请在右侧预览区查看。",
              type: MessageType.agent_summary,
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                prototypeArtifactId: applied.prototypeArtifact.id,
                finalActionType: result.finalAction.type,
                threadId: result.threadId,
              }),
              relatedRunId: run.id,
              relatedPrototypeArtifactId: applied.prototypeArtifact.id,
            }, run.id);
            await this.completeRunBestEffort(
              run.id,
              {
                status: "success",
                threadId: result.threadId,
                finalAction: result.finalAction,
                prototypeArtifact: applied.prototypeArtifact,
              },
              "原型已生成",
            );
          } else {
            // 无产物：把 finalAction.message 作为文本下发（若未在 chunk 流里）
            const message = result.finalAction.message || ctx.textBuffer.trim() || result.assistantText || "本轮未生成产物。";
            if (!ctx.hasEmittedText) {
              emitStaticText(message, streamWriter, ctx);
              finishText(streamWriter, ctx);
            }
            deliveredUserVisibleResult = true;
            await this.createAssistantMessageBestEffort({
              projectId,
              conversationId,
              userId: user.id,
              content: message,
              type: pickAssistantMessageType(result.finalAction.type),
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                finalAction: result.finalAction,
                threadId: result.threadId,
              }),
              relatedRunId: run.id,
            }, run.id);
            await this.completeRunBestEffort(
              run.id,
              {
                status: "no_artifact",
                finalAction: result.finalAction,
                threadId: result.threadId,
              },
              message,
            );
          }

          streamWriter.write({ type: "finish" });
        } catch (error) {
          if (controller.signal.aborted) {
            await this.runLogs.cancelRun({
              runId: run.id,
              canceledBy: user.id,
              reason: "用户停止 aichat 生成",
            }).catch((cancelError) => {
              this.logger.error(`aichat run 取消状态写入失败 runId=${run.id}：${serializeError(cancelError)}`);
            });
            finishText(streamWriter, ctx);
            streamWriter.write({ type: "finish", finishReason: "stop" });
            return;
          }

          this.logger.error(`aichat stream 失败 runId=${run.id}：${serializeError(error)}`);
          await this.runLogs.failRun(run.id, error).catch((failError) => {
            this.logger.error(`aichat run 失败状态写入失败 runId=${run.id}：${serializeError(failError)}`);
          });
          if (!deliveredUserVisibleResult) {
            // 收尾已开的文本 part，避免前端解析悬挂
            finishText(streamWriter, ctx);
            streamWriter.write({ type: "error", errorText: "生成失败，请重试" });
            streamWriter.write({ type: "finish", finishReason: "error" });
          } else {
            streamWriter.write({ type: "finish", finishReason: "stop" });
          }
        } finally {
          res.off("close", markClientClosed);
          this.activeRunControllers.delete(run.id);
          // 仅当仍是本次 controller 时才清除会话映射（避免覆盖后续轮次）
          if (this.activeConversationControllers.get(conversationId) === controller) {
            this.activeConversationControllers.delete(conversationId);
          }
        }
      },
      onError: () => "生成失败，请重试",
      generateId: () => randomUUID(),
    });

    // e) pipe 到 express 响应
    pipeUIMessageStreamToResponse({ response: res, stream });
  }

  /**
   * 停止指定 run（或会话最近一次运行）。
   * 输入既可以是 runId（优先），也可以是 conversationId。
   */
  async stop(user: AuthenticatedUser, conversationIdOrRunId: string): Promise<{
    ok: boolean;
    runId?: string;
    canceled?: boolean;
    skipped?: boolean;
  }> {
    // 1) 优先按 runId 直接 abort
    const directController = this.activeRunControllers.get(conversationIdOrRunId);
    if (directController) {
      directController.abort();
      await this.runLogs.cancelRun({
        runId: conversationIdOrRunId,
        canceledBy: user.id,
        reason: "用户停止 aichat 生成",
      });
      return { ok: true, runId: conversationIdOrRunId, canceled: true };
    }

    // 2) 否则按 conversationId 找当前运行中的 controller
    //    先校验会话归属，再取映射。若没有在跑的 run，返回 skipped。
    await this.conversations.get(user, conversationIdOrRunId).catch(() => {
      throw new NotFoundException("会话不存在");
    });
    const conversationController = this.activeConversationControllers.get(conversationIdOrRunId);
    if (!conversationController) {
      return { ok: true, skipped: true };
    }
    conversationController.abort();
    // 反查 runId：遍历 activeRunControllers 找到对应 controller
    let runId: string | undefined;
    for (const [candidateRunId, candidateController] of this.activeRunControllers) {
      if (candidateController === conversationController) {
        runId = candidateRunId;
        break;
      }
    }
    if (runId) {
      await this.runLogs.cancelRun({
        runId,
        canceledBy: user.id,
        reason: "用户停止 aichat 生成",
      });
      return { ok: true, runId, canceled: true };
    }
    return { ok: true, skipped: true };
  }

  /** 移植自 copilot-prd-runtime.service.ts 的知识检索。 */
  private async retrieveKnowledge(input: {
    projectId: string;
    conversationId: string;
    runId: string;
    message: string;
  }): Promise<DeerFlowKnowledgeReference[]> {
    const requirementMode: RequirementMode = classifyRequirementMode(input.message, { hasExistingState: true });
    const retrieval = await this.knowledgeRetrieval.search({
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      runtimeName: "runtime_generation",
      query: input.message,
      limit: 8,
      requirementMode,
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
      type: ref.type as string | undefined,
      score: ref.score,
      semanticScore: ref.semanticScore,
      reason: ref.reason,
    }));
  }

  private async createAssistantMessageBestEffort(
    input: Parameters<MessageService["createAssistantMessage"]>[0],
    runId: string,
  ) {
    try {
      await this.messages.createAssistantMessage(input);
    } catch (error) {
      this.logger.error(`assistant 消息落库失败 runId=${runId}：${serializeError(error)}`);
    }
  }

  private async completeRunBestEffort(
    runId: string,
    result: unknown,
    outputSummary: string,
  ) {
    try {
      await this.runLogs.completeRun(runId, result, outputSummary);
    } catch (error) {
      this.logger.error(`aichat run 成功状态写入失败 runId=${runId}：${serializeError(error)}`);
      await this.runLogs.completeRun(
        runId,
        {
          status: readResultStatus(result) ?? "success",
          resultOmitted: true,
          warning: serializeError(error),
        },
        outputSummary,
      ).catch((fallbackError) => {
        this.logger.error(`aichat run 最小成功状态写入失败 runId=${runId}：${serializeError(fallbackError)}`);
      });
    }
  }
}

/** 从 dto.message.parts 抽取纯文本。 */
function extractUserText(message: ChatStreamDto["message"]): string {
  if (!message?.parts?.length) return "";
  return message.parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function pickAssistantMessageType(
  finalActionType: string,
): MessageType {
  if (finalActionType === "ask_clarification") return MessageType.clarification;
  return MessageType.text;
}

function buildConversationTitle(content: string): string {
  const title = content.replace(/\s+/g, " ").trim();
  if (!title) return "新对话";
  return title.length > 60 ? `${title.slice(0, 60)}...` : title;
}

function buildProductContextForDeerFlow(session: {
  productDesignState?: unknown;
  prd?: unknown;
  prototype?: unknown;
}) {
  const state = asRecord(session.productDesignState);
  const prd = asRecord(session.prd);
  const prototype = asRecord(session.prototype);

  return {
    currentProductDesignState: state
      ? {
          id: state.id,
          version: state.version,
          status: state.status,
          title: state.title,
          summary: state.summary,
          businessGoal: state.businessGoal,
          targetUsers: state.targetUsers,
          userScenarios: state.userScenarios,
          pages: state.pages,
          features: state.features,
          backendConfigs: state.backendConfigs,
          frontendRules: state.frontendRules,
          businessRules: state.businessRules,
          stateRules: state.stateRules,
          exceptionScenarios: state.exceptionScenarios,
          acceptanceCriteria: state.acceptanceCriteria,
          prototypeOutline: state.prototypeOutline,
        }
      : null,
    currentPrdDocument: prd
      ? {
          id: prd.id,
          title: prd.title,
          status: prd.status,
          sections: prd.sections,
          updatedAt: prd.updatedAt,
        }
      : null,
    currentPrototypeArtifact: prototype
      ? {
          id: prototype.id,
          title: prototype.title,
          status: prototype.status,
          updatedAt: prototype.updatedAt,
        }
      : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function readResultStatus(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" && status.trim() ? status : undefined;
}
