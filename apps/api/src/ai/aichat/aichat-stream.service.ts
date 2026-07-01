import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { KnowledgeType, MessageType, Prisma, type RuntimeRunLog } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { ConversationService } from "../../modules/conversation/conversation.service";
import { KnowledgeRetrievalService } from "../../knowledge/knowledge-retrieval.service";
import { MessageService } from "../../projects/message.service";
import { DeerFlowRuntimeService } from "../deerflow-runtime.service";
import type { DeerFlowKnowledgeReference, DeerFlowRuntimeEvent } from "../deerflow-runtime.service";
import { FinalActionApplierService } from "../final-action-applier.service";
import { RuntimeRunLogService } from "../runtime-run-log.service";
import { toInputJson } from "../ai-vibe.helpers";
import { classifyRequirementMode, type RequirementMode } from "../requirement-mode.helper";
import {
  createBridgeContext,
  createRuntimeEvent,
  emitChatTitle,
  emitDeerFlowEvent,
  emitPrdArtifact,
  emitPrdDocumentPreview,
  emitPrototypeArtifact,
  emitPrototypeDocumentPreview,
  emitRuntimeEvent,
  emitRuntimeFinish,
  emitRuntimeStart,
  emitStaticText,
  emitToolInputAvailable,
  emitToolOutputAvailable,
  finishReasoning,
  finishText,
  getPersistedToolParts,
  type PersistedToolPart,
  runtimeEventsFromDeerFlow,
  type RuntimeProcessEvent,
  type RuntimeProcessSnapshot,
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
        const startedAt = run.startedAt.toISOString();
        const runtimeEvents: RuntimeProcessEvent[] = [];
        const assistantDraft = this.createAssistantDraftWriter({
          projectId,
          conversationId,
          userId: user.id,
          runId: run.id,
          getContent: () => ctx.textBuffer.trim(),
          getReasoning: () => ctx.reasoningBuffer.trim(),
          getRuntimeEvents: () => runtimeEvents,
          getToolParts: () => getPersistedToolParts(ctx),
        });
        const recordRuntimeEvent = (eventType: string, payload: unknown) => {
          void this.runLogs.recordStreamEvent({
            runId: run.id,
            projectId,
            eventType,
            payload,
          }).catch((error) => {
            this.logger.warn(
              `运行过程事件落库失败 runId=${run.id}：${serializeError(error)}`,
            );
          });
        };
        const publishRuntimeEvent = (event: RuntimeProcessEvent) => {
          runtimeEvents.push(event);
          emitRuntimeEvent(streamWriter, event);
          recordRuntimeEvent("runtime_event", event);
        };
        const publishRuntimeFinish = (
          status: RuntimeProcessSnapshot["status"],
          extraEvents: RuntimeProcessEvent[] = [],
        ) => {
          const endedAt = new Date().toISOString();
          for (const event of extraEvents) {
            runtimeEvents.push(event);
          }
          const snapshot: RuntimeProcessSnapshot = {
            runId: run.id,
            status,
            startedAt,
            endedAt,
            events: extraEvents,
            title:
              status === "succeeded"
                ? "已完成"
                : status === "failed"
                  ? "生成失败"
                  : status === "cancelled"
                    ? "已停止"
                    : undefined,
          };
          emitRuntimeFinish(streamWriter, snapshot);
        };
        const documentStream = createDocumentStreamState(run.id);
        res.on("close", markClientClosed);

        try {
          streamWriter.write({ type: "start", messageId: randomUUID() });
          emitChatTitle(streamWriter, conversation.title);
          const startSnapshot: RuntimeProcessSnapshot = {
            runId: run.id,
            status: "running",
            startedAt,
            events: [],
          };
          emitRuntimeStart(streamWriter, startSnapshot);
          recordRuntimeEvent("runtime_start", startSnapshot);

          if (isKnowledgeInventoryQuestion(content)) {
            await this.respondWithKnowledgeInventory({
              content,
              conversationId,
              ctx,
              projectId,
              runId: run.id,
              streamWriter,
              userId: user.id,
              assistantDraft,
            });
            await this.completeRunBestEffort(
              run.id,
              { status: "success", handledBy: "listKnowledgeBase" },
              "已返回知识库真实列表",
            );
            publishRuntimeFinish("succeeded");
            streamWriter.write({ type: "finish" });
            return;
          }

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
              const previousTextLength = ctx.textBuffer.length;
              for (const runtimeEvent of runtimeEventsFromDeerFlow(event, ctx, run.id)) {
                publishRuntimeEvent(runtimeEvent);
              }
              const routedDocumentDelta = routeAssistantDocumentDelta(event, streamWriter, documentStream);
              if (!routedDocumentDelta.suppressChat) {
                emitDeerFlowEvent(event, streamWriter, ctx);
              } else {
                emitDeerFlowEvent({ ...event, chunk: "", content: "" }, streamWriter, ctx);
              }
              if (ctx.textBuffer.length > previousTextLength) {
                void assistantDraft.persist();
              }
            },
          });

          // 收尾文本/步骤 part
          finishReasoning(streamWriter, ctx);
          finishText(streamWriter, ctx);
          await assistantDraft.persist(true);

          const expectsArtifact =
            result.finalAction.type === "review_prd" ||
            result.finalAction.type === "review_prototype";
          if (expectsArtifact) {
            publishRuntimeEvent(createRuntimeEvent({
              runId: run.id,
              id: "apply-final-action",
              kind: "document",
              label: "正在整理产物并写入工作台",
              status: "running",
            }));
          }
          const applied = await this.finalActionApplier.apply({
            projectId,
            userId: user.id,
            runId: run.id,
            finalAction: result.finalAction,
            artifacts: result.artifacts,
            assistantText: result.assistantText,
          });

          if (applied.prdDocument) {
            const prdChatMessage = "PRD 已生成，请在右侧画布查看。";
            publishRuntimeEvent(createRuntimeEvent({
              runId: run.id,
              id: "apply-final-action",
              kind: "document",
              label: "PRD 已写入工作台",
            }));
            emitStaticText(prdChatMessage, streamWriter, ctx);
            finishReasoning(streamWriter, ctx);
            finishText(streamWriter, ctx);
            // 干净收尾流式 draft 画布，再发最终 PRD，避免 data-clear 空窗闪烁。
            finishDocumentStream(streamWriter, documentStream);
            emitPrdArtifact(applied.prdDocument, streamWriter);
            emitPrdDocumentPreview(applied.prdDocument, streamWriter);
            const prdReadyEvent = createRuntimeEvent({
              runId: run.id,
              id: "prd-ready",
              kind: "document",
              label: "PRD 已生成，正在唤起右侧画布",
              detail: applied.prdDocument.title,
              artifact: {
                id: applied.prdDocument.id,
                title: applied.prdDocument.title || "产品需求文档（PRD）",
                kind: "text",
              },
            });
            publishRuntimeEvent(prdReadyEvent);
            deliveredUserVisibleResult = true;
            await assistantDraft.finalize({
              projectId,
              conversationId,
              userId: user.id,
              content: prdChatMessage,
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
            });
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
            publishRuntimeFinish("succeeded");
          } else if (applied.prototypeArtifact) {
            const prototypeChatMessage = "原型已生成，请在右侧画布查看。";
            publishRuntimeEvent(createRuntimeEvent({
              runId: run.id,
              id: "apply-final-action",
              kind: "document",
              label: "原型已写入工作台",
            }));
            emitStaticText(prototypeChatMessage, streamWriter, ctx);
            finishReasoning(streamWriter, ctx);
            finishText(streamWriter, ctx);
            emitPrototypeArtifact(applied.prototypeArtifact, streamWriter);
            emitPrototypeDocumentPreview(applied.prototypeArtifact, streamWriter);
            const prototypeReadyEvent = createRuntimeEvent({
              runId: run.id,
              id: "prototype-ready",
              kind: "document",
              label: "原型已生成，正在唤起右侧画布",
              detail: applied.prototypeArtifact.title,
              artifact: {
                id: applied.prototypeArtifact.id,
                title: applied.prototypeArtifact.title || "原型",
                kind: "prototype",
              },
            });
            publishRuntimeEvent(prototypeReadyEvent);
            deliveredUserVisibleResult = true;
            await assistantDraft.finalize({
              projectId,
              conversationId,
              userId: user.id,
              content: prototypeChatMessage,
              type: MessageType.agent_summary,
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                prototypeArtifactId: applied.prototypeArtifact.id,
                prototypeArtifactTitle: applied.prototypeArtifact.title,
                finalActionType: result.finalAction.type,
                threadId: result.threadId,
              }),
              relatedRunId: run.id,
              relatedPrototypeArtifactId: applied.prototypeArtifact.id,
            });
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
            publishRuntimeFinish("succeeded");
          } else {
            // 无产物：把 finalAction.message 作为文本下发（若未在 chunk 流里）
            const message = result.finalAction.message || ctx.textBuffer.trim() || result.assistantText || "本轮未生成产物。";
            finishDocumentStream(streamWriter, documentStream);
            if (!ctx.hasEmittedText) {
              emitStaticText(message, streamWriter, ctx);
              finishReasoning(streamWriter, ctx);
              finishText(streamWriter, ctx);
            }
            deliveredUserVisibleResult = true;
            await assistantDraft.finalize({
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
            });
            await this.completeRunBestEffort(
              run.id,
              {
                status: "no_artifact",
                finalAction: result.finalAction,
                threadId: result.threadId,
              },
              message,
            );
            publishRuntimeFinish("succeeded");
          }

          streamWriter.write({ type: "finish" });
        } catch (error) {
          // 跨刷新/重启场景下，内存 controller 可能不在本实例，signal.aborted 为 false，
          // 但 DB run 行已被 stop 兜底置为 cancelled。这里查一次 DB 以走取消分支而非误报失败。
          // 注意：仅覆盖孤儿流与 stop 同实例的情形；多实例需共享取消信号（如 Redis pub/sub）。
          const wasCancelled =
            controller.signal.aborted ||
            (await this.runLogs.isRunCancelled(run.id).catch(() => false));
          if (wasCancelled) {
            const cancelledEvent = createRuntimeEvent({
              runId: run.id,
              id: "cancelled",
              kind: "status",
              label: "用户已停止本次生成",
              status: "completed",
            });
            publishRuntimeEvent(cancelledEvent);
            publishRuntimeFinish("cancelled");
            await this.runLogs.cancelRun({
              runId: run.id,
              canceledBy: user.id,
              reason: "用户停止 aichat 生成",
            }).catch((cancelError) => {
              this.logger.error(`aichat run 取消状态写入失败 runId=${run.id}：${serializeError(cancelError)}`);
            });
            const partialMessage = ctx.textBuffer.trim();
            if (partialMessage) {
              await assistantDraft.finalize({
                projectId,
                conversationId,
                userId: user.id,
                content: partialMessage,
                type: MessageType.agent_summary,
                metadata: toInputJson({
                  source: "aichat",
                  runId: run.id,
                  status: "cancelled",
                  draft: false,
                }),
                relatedRunId: run.id,
              });
            }
            finishReasoning(streamWriter, ctx);
            finishText(streamWriter, ctx);
            streamWriter.write({ type: "finish", finishReason: "stop" });
            return;
          }

          this.logger.error(`aichat stream 失败 runId=${run.id}：${serializeError(error)}`);
          const failedEvent = createRuntimeEvent({
            runId: run.id,
            id: "failed",
            kind: "error",
            label: "生成失败",
            detail: serializeError(error),
            status: "failed",
          });
          publishRuntimeEvent(failedEvent);
          publishRuntimeFinish("failed");
          await this.runLogs.failRun(run.id, error).catch((failError) => {
            this.logger.error(`aichat run 失败状态写入失败 runId=${run.id}：${serializeError(failError)}`);
          });
          if (!deliveredUserVisibleResult) {
            await assistantDraft.finalize({
              projectId,
              conversationId,
              userId: user.id,
              content: ctx.textBuffer.trim() || "生成失败，请重试",
              type: MessageType.error,
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                status: "failed",
                draft: false,
              }),
              relatedRunId: run.id,
            });
            // 收尾已开的文本 part，避免前端解析悬挂
            finishReasoning(streamWriter, ctx);
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
    stale?: boolean;
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
    //    先校验会话归属，再取映射。刷新/重启后 controller 可能丢失，
    //    但 runtime-status 仍会从 DB 看到 running，所以需要兜底取消 DB 最新运行。
    await this.conversations.get(user, conversationIdOrRunId).catch(() => {
      throw new NotFoundException("会话不存在");
    });
    const conversationController = this.activeConversationControllers.get(conversationIdOrRunId);

    if (conversationController) {
      conversationController.abort();
    }

    // 反查 runId：遍历 activeRunControllers 找到对应 controller
    let runId: string | undefined;
    if (conversationController) {
      for (const [candidateRunId, candidateController] of this.activeRunControllers) {
        if (candidateController === conversationController) {
          runId = candidateRunId;
          break;
        }
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

    const staleCancellation = await this.runLogs.cancelLatestRunningRunForConversation({
      conversationId: conversationIdOrRunId,
      canceledBy: user.id,
      reason: "用户停止 aichat 生成",
    });

    if (staleCancellation) {
      if (staleCancellation.changed) {
        await this.recordStaleStopEvent(staleCancellation.run).catch((error) => {
          this.logger.warn(
            `aichat 停止事件落库失败 runId=${staleCancellation.run.id}：${serializeError(error)}`,
          );
        });
      }
      return {
        ok: true,
        runId: staleCancellation.run.id,
        canceled: staleCancellation.changed,
        skipped: !staleCancellation.changed,
        stale: !conversationController,
      };
    }

    return { ok: true, skipped: true };
  }

  private async recordStaleStopEvent(
    run: Pick<RuntimeRunLog, "id" | "projectId" | "startedAt">,
  ) {
    const event = createRuntimeEvent({
      runId: run.id,
      id: "cancelled",
      kind: "status",
      label: "用户已停止本次生成",
      status: "completed",
    });

    await this.runLogs.recordStreamEvent({
      runId: run.id,
      projectId: run.projectId,
      eventType: "runtime_event",
      payload: event,
    });
  }

  /** 移植自 copilot-prd-runtime.service.ts 的知识检索。 */
  private async retrieveKnowledge(input: {
    projectId: string;
    conversationId: string;
    runId: string;
    message: string;
  }): Promise<DeerFlowKnowledgeReference[]> {
    const retrieval = await this.searchKnowledgeForChat(input);
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

  private async respondWithKnowledgeInventory(input: {
    content: string;
    conversationId: string;
    ctx: ReturnType<typeof createBridgeContext>;
    projectId: string;
    runId: string;
    streamWriter: UIMessageStreamWriter;
    userId: string;
    assistantDraft: {
      finalize: (
        message: Parameters<MessageService["createAssistantMessage"]>[0],
      ) => Promise<void>;
    };
  }) {
    const toolCallId = `knowledge-inventory-${input.runId}`;
    const toolInput = {
      query: input.content,
      limit: 20,
      scope: "current-project",
    };
    emitToolInputAvailable(
      {
        toolCallId,
        toolName: "listKnowledgeBase",
        input: toolInput,
      },
      input.streamWriter,
      input.ctx,
    );

    const retrieval = await this.searchKnowledgeForChat({
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      message: "",
      limit: 20,
    });
    const output = {
      query: input.content,
      matchedCount: retrieval.matchedCount,
      selectedCount: retrieval.selectedCount,
      retrievalError: retrieval.retrievalError,
      items: retrieval.references.map((ref) => ({
        id: ref.knowledgeId,
        title: ref.title,
        type: ref.type,
        score: ref.score,
        semanticScore: ref.semanticScore,
        reason: ref.reason,
        snippet: ref.snippet,
      })),
    };
    emitToolOutputAvailable({ toolCallId, output }, input.streamWriter, input.ctx);

    const message = formatKnowledgeInventoryMessage(output);
    emitStaticText(message, input.streamWriter, input.ctx);
    finishReasoning(input.streamWriter, input.ctx);
    finishText(input.streamWriter, input.ctx);

    await input.assistantDraft.finalize({
      projectId: input.projectId,
      conversationId: input.conversationId,
      userId: input.userId,
      content: message,
      type: MessageType.text,
      metadata: toInputJson({
        source: "aichat",
        runId: input.runId,
        handledBy: "listKnowledgeBase",
      }),
      relatedRunId: input.runId,
    });
  }

  private async searchKnowledgeForChat(input: {
    projectId: string;
    conversationId: string;
    runId: string;
    message: string;
    limit?: number;
  }) {
    const requirementMode: RequirementMode = classifyRequirementMode(input.message, { hasExistingState: true });
    return this.knowledgeRetrieval.search({
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      runtimeName: "runtime_generation",
      query: input.message,
      limit: input.limit ?? 8,
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
  }

  private createAssistantDraftWriter(input: {
    projectId: string;
    conversationId: string;
    userId: string;
    runId: string;
    getContent: () => string;
    getReasoning: () => string;
    getRuntimeEvents: () => RuntimeProcessEvent[];
    getToolParts: () => PersistedToolPart[];
  }) {
    const thinkingMetadata = () => {
      const metadata: Record<string, unknown> = {};
      const reasoningText = input.getReasoning().trim();
      if (reasoningText) {
        metadata.reasoningText = reasoningText;
      }

      const runtimeEvents = input.getRuntimeEvents().filter(isRuntimeProcessEvent).slice(-80);
      if (runtimeEvents.length > 0) {
        metadata.runtimeEvents = runtimeEvents;
      }

      const toolParts = input.getToolParts();
      if (reasoningText || toolParts.length > 0) {
        metadata.parts = buildPersistedAssistantParts({
          content: input.getContent(),
          reasoningText,
          toolParts,
        });
      }

      return metadata;
    };

    const draftMetadata = () =>
      toInputJson({
        source: "aichat",
        runId: input.runId,
        status: "running",
        draft: true,
        ...thinkingMetadata(),
      });

    const mergeFinalMetadata = (metadata: unknown) =>
      toInputJson({
        ...recordFromJson(metadata),
        ...thinkingMetadata(),
      });

    const toUpdateInput = (message: Parameters<MessageService["createAssistantMessage"]>[0]) => ({
      content: message.content,
      type: message.type,
      attachments: message.attachments,
      metadata: mergeFinalMetadata(message.metadata),
      relatedRunId: message.relatedRunId,
      relatedPrdDocumentId: message.relatedPrdDocumentId,
      relatedPrototypeArtifactId: message.relatedPrototypeArtifactId,
      relatedQaReportId: message.relatedQaReportId,
    });

    let draftMessageId: string | undefined;
    let lastPersistedContent = "";
    let lastPersistedSignature = "";
    let lastPersistedAt = 0;
    let isFinalizing = false;
    let pending: Promise<void> = Promise.resolve();

    const queueWrite = (
      content: string,
      metadata: Prisma.InputJsonValue,
      signature: string,
    ) => {
      pending = pending
        .catch(() => undefined)
        .then(async () => {
          if (isFinalizing || signature === lastPersistedSignature) return;

          if (!draftMessageId) {
            const created = await this.messages.createAssistantMessage({
              projectId: input.projectId,
              conversationId: input.conversationId,
              userId: input.userId,
              content,
              type: MessageType.text,
              metadata,
              relatedRunId: input.runId,
            });
            draftMessageId = created.id;
          } else {
            await this.messages.updateAssistantMessage(draftMessageId, {
              content,
              type: MessageType.text,
              metadata,
              relatedRunId: input.runId,
            });
          }

          lastPersistedContent = content;
          lastPersistedSignature = signature;
        })
        .catch((error) => {
          this.logger.error(`assistant 草稿落库失败 runId=${input.runId}：${serializeError(error)}`);
        });
      return pending;
    };

    return {
      persist: (force = false) => {
        if (isFinalizing) return pending;

        const content = input.getContent();
        const metadata = draftMetadata();
        const signature = safeJsonSignature({ content, metadata });
        if (!content && !hasPersistableMetadata(metadata)) return pending;

        const now = Date.now();
        const hasMeaningfulDelta =
          Math.abs(signature.length - lastPersistedSignature.length) >= 160 ||
          content.length - lastPersistedContent.length >= 160;
        const hasWaitedLongEnough = now - lastPersistedAt >= 1200;
        if (!force && !hasMeaningfulDelta && !hasWaitedLongEnough) {
          return pending;
        }

        lastPersistedAt = now;
        return queueWrite(content, metadata, signature);
      },
      finalize: async (message: Parameters<MessageService["createAssistantMessage"]>[0]) => {
        isFinalizing = true;
        await pending.catch(() => undefined);
        const finalMessage = {
          ...message,
          metadata: mergeFinalMetadata(message.metadata),
        };

        try {
          if (draftMessageId) {
            await this.messages.updateAssistantMessage(draftMessageId, toUpdateInput(finalMessage));
          } else {
            await this.messages.createAssistantMessage(finalMessage);
          }
        } catch (error) {
          this.logger.error(`assistant 消息落库失败 runId=${input.runId}：${serializeError(error)}`);
        }
      },
    };
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

type DocumentStreamState = {
  id: string;
  started: boolean;
  finished: boolean;
  title?: string;
  textBuffer: string;
  pending: string;
  inFinalActionBlock: boolean;
};

const FINAL_ACTION_FENCE = "```ai_product_workbench_final_action";

function createDocumentStreamState(runId: string): DocumentStreamState {
  return {
    id: `streaming-prd-${runId}`,
    started: false,
    finished: false,
    textBuffer: "",
    pending: "",
    inFinalActionBlock: false,
  };
}

function routeAssistantDocumentDelta(
  event: DeerFlowRuntimeEvent,
  writer: UIMessageStreamWriter,
  state: DocumentStreamState,
): { suppressChat: boolean } {
  if (event.messageRole !== "assistant" || typeof event.chunk !== "string" || !event.chunk) {
    return { suppressChat: false };
  }

  const { visible, touchedFinalAction } = stripFinalActionDelta(event.chunk, state);
  const shouldRouteToCanvas =
    state.started ||
    looksLikeDocumentDraft(`${state.textBuffer}${visible}`, visible);

  if (!shouldRouteToCanvas) {
    return { suppressChat: touchedFinalAction };
  }

  if (visible) {
    startDocumentStream(writer, state, visible);
    writer.write({ type: "data-textDelta", data: visible, transient: true });
    state.textBuffer += visible;
    updateDocumentStreamTitle(writer, state);
  }

  return { suppressChat: true };
}

function startDocumentStream(
  writer: UIMessageStreamWriter,
  state: DocumentStreamState,
  firstDelta: string,
) {
  if (state.started) return;

  state.started = true;
  state.title = inferDocumentTitle(firstDelta) ?? "生成中的 PRD";
  writer.write({ type: "data-kind", data: "text", transient: true });
  writer.write({ type: "data-id", data: state.id, transient: true });
  writer.write({ type: "data-title", data: state.title, transient: true });
  writer.write({ type: "data-clear", data: null, transient: true });
}

function updateDocumentStreamTitle(
  writer: UIMessageStreamWriter,
  state: DocumentStreamState,
) {
  const title = inferDocumentTitle(state.textBuffer);
  if (!title || title === state.title) return;

  state.title = title;
  writer.write({ type: "data-title", data: title, transient: true });
}

function finishDocumentStream(
  writer: UIMessageStreamWriter,
  state: DocumentStreamState,
) {
  if (!state.started || state.finished) return;

  state.finished = true;
  writer.write({ type: "data-finish", data: null, transient: true });
}

function stripFinalActionDelta(
  delta: string,
  state: DocumentStreamState,
): { visible: string; touchedFinalAction: boolean } {
  state.pending += delta;
  let visible = "";
  let touchedFinalAction = false;

  while (state.pending) {
    if (state.inFinalActionBlock) {
      touchedFinalAction = true;
      const endIndex = state.pending.indexOf("```");
      if (endIndex === -1) {
        state.pending = keepPotentialFenceSuffix(state.pending);
        break;
      }
      state.pending = state.pending.slice(endIndex + 3);
      state.inFinalActionBlock = false;
      continue;
    }

    const startIndex = state.pending.indexOf(FINAL_ACTION_FENCE);
    if (startIndex !== -1) {
      visible += state.pending.slice(0, startIndex);
      state.pending = state.pending.slice(startIndex + FINAL_ACTION_FENCE.length);
      state.inFinalActionBlock = true;
      touchedFinalAction = true;
      continue;
    }

    const holdLength = longestSuffixMatchingFinalActionFence(state.pending);
    if (holdLength > 0) {
      visible += state.pending.slice(0, -holdLength);
      state.pending = state.pending.slice(-holdLength);
      touchedFinalAction = true;
      break;
    }

    visible += state.pending;
    state.pending = "";
  }

  return { visible, touchedFinalAction };
}

function looksLikeDocumentDraft(buffer: string, delta: string) {
  const sample = buffer.trim();
  const current = delta.trim();
  if (!sample || sample.length < 8) return false;

  if (/产品需求文档|需求文档|PRD/i.test(sample)) return true;
  if (/^#{1,3}\s+.*(PRD|需求|文档|功能|页面|产品)/im.test(sample)) return true;
  if (
    /(^|\n)\s*(#{1,4}\s*)?(\d+(\.\d+)*[.、]?\s*)?(引言|项目背景|文档范围|使用场景|业务需求|功能需求|流程|页面要求|接口|验收标准|业务降级方案|需求安全基线)/.test(sample)
  ) {
    return true;
  }

  const headingCount = (sample.match(/^#{1,4}\s+/gm) ?? []).length;
  if (headingCount >= 2 && /(用户|页面|功能|规则|流程|奖励|活动|接口|配置)/.test(sample)) {
    return true;
  }

  return /^#{1,4}\s+/.test(current) && /(需求|PRD|文档|功能|页面)/i.test(current);
}

function inferDocumentTitle(value: string) {
  const heading = value.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!heading) return undefined;
  return heading.replace(/[#*`]/g, "").trim().slice(0, 80) || undefined;
}

function keepPotentialFenceSuffix(value: string) {
  if (value.endsWith("``")) return "``";
  if (value.endsWith("`")) return "`";
  return "";
}

function longestSuffixMatchingFinalActionFence(value: string) {
  const maxLength = Math.min(value.length, FINAL_ACTION_FENCE.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (FINAL_ACTION_FENCE.startsWith(value.slice(-length))) {
      return length;
    }
  }
  return 0;
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

function recordFromJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function isKnowledgeInventoryQuestion(value: string) {
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (!/(知识库|知识|规则库|素材库)/.test(compact)) return false;
  return /(有哪些|有什么|有什么内容|哪些内容|列出|列表|目录|清单|盘点|收录|包含什么|都有什么)/.test(compact);
}

function formatKnowledgeInventoryMessage(output: {
  matchedCount: number;
  selectedCount: number;
  retrievalError?: string;
  items: Array<{
    title: string;
    type: string;
    snippet?: string;
  }>;
}) {
  if (output.items.length === 0) {
    return output.retrievalError
      ? `我查询了知识库，但本次没有拿到可展示的知识条目：${output.retrievalError}`
      : "我查询了知识库，当前没有可展示的已启用知识条目。";
  }

  const lines = output.items.slice(0, 10).map((item, index) => {
    const snippet = item.snippet?.trim();
    return `${index + 1}. ${item.title}（${item.type}）${snippet ? `：${snippet}` : ""}`;
  });
  const suffix =
    output.selectedCount > lines.length
      ? `\n\n还有 ${output.selectedCount - lines.length} 条已在工具结果里展示。`
      : "";

  return [
    `我查询到 ${output.selectedCount} 条可用知识（总命中 ${output.matchedCount} 条），真实列表已在工具结果中展开。`,
    "",
    ...lines,
    suffix,
  ].join("\n");
}

function buildPersistedAssistantParts(input: {
  content: string;
  reasoningText: string;
  toolParts: PersistedToolPart[];
}) {
  const parts: unknown[] = [];
  const reasoningText = input.reasoningText.trim();
  if (reasoningText) {
    parts.push({ type: "reasoning", text: reasoningText });
  }
  parts.push(...input.toolParts.map((part) => ({ ...part })));
  const content = input.content.trim();
  if (content) {
    parts.push({ type: "text", text: content });
  }
  return parts;
}

function hasPersistableMetadata(metadata: Prisma.InputJsonValue) {
  const record = recordFromJson(metadata);
  return Boolean(
    record.reasoningText ||
      (Array.isArray(record.runtimeEvents) && record.runtimeEvents.length > 0) ||
      (Array.isArray(record.parts) && record.parts.length > 0),
  );
}

function safeJsonSignature(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(Date.now());
  }
}

function isRuntimeProcessEvent(value: unknown): value is RuntimeProcessEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string"
  );
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
