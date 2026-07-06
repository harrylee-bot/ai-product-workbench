import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { KnowledgeType, MessageType, Prisma, type RuntimeRunLog } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { ConversationService } from "../../modules/conversation/conversation.service";
import { KnowledgeRetrievalService } from "../../knowledge/knowledge-retrieval.service";
import { FileAssetService } from "../../files/file-asset.service";
import { MessageService } from "../../conversations/message.service";
import { DeerFlowRuntimeService } from "../deerflow-runtime.service";
import type {
  DeerFlowFinalAction,
  DeerFlowKnowledgeReference,
  DeerFlowRuntimeEvent,
} from "../deerflow-runtime.service";
import { FinalActionApplierService } from "../final-action-applier.service";
import { QaService } from "../qa.service";
import { RuntimeRunLogService } from "../runtime-run-log.service";
import { toInputJson } from "../ai-vibe.helpers";
import type { QACheckType, QAReport } from "../ai-vibe.types";
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
  /** runId → conversationId，用于 stop by runId 前做归属校验。 */
  private readonly activeRunConversationIds = new Map<string, string>();
  /** conversationId → AbortController，用于 stop by conversationId（取最近一次）。 */
  private readonly activeConversationControllers = new Map<string, AbortController>();

  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
    private readonly deerFlow: DeerFlowRuntimeService,
    private readonly finalActionApplier: FinalActionApplierService,
    private readonly qaService: QaService,
    private readonly runLogs: RuntimeRunLogService,
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
    private readonly files: FileAssetService,
  ) {}

  /**
   * 主流程：把 DeerFlow 的 SSE 事件翻译成 AI SDK v6 UIMessageStream 并 pipe 到响应。
   */
  async stream(user: AuthenticatedUser, dto: ChatStreamDto, res: Response): Promise<void> {
    const conversationId = dto.id;

    // a) 抽取用户消息文本
    const userContent = extractUserText(dto.message);
    if (!userContent) {
      throw new BadRequestException("请求缺少用户消息文本");
    }
    const forceCanvasDocument = isCanvasDocumentMode(dto.selectedArtifactMode);
    const runtimeContent = forceCanvasDocument
      ? buildCanvasDocumentRuntimePrompt(userContent)
      : userContent;

    // b) 新对话页的 id 来自前端临时 UUID；首条消息到达时在后端落成真实会话。
    const session = await this.conversations.getOrCreateInternal(
      user,
      conversationId,
      buildConversationTitle(userContent),
    );
    const { conversation } = session;
    const conversationContext = buildConversationContextForDeerFlow(session);
    const fileParts = extractFileParts(dto.message);
    const fileIds = [...new Set(fileParts.map((part) => part.fileId))];
    const attachmentFiles = await this.files.getRuntimeAttachmentFiles(fileIds, conversationId);

    // c) 持久化用户消息
    const userMessage = await this.messages.createUserMessage({
      conversationId,
      userId: user.id,
      content: userContent,
      attachments: fileParts.length ? toInputJson(fileParts) : undefined,
      metadata: toInputJson({
        source: "aichat",
        selectedArtifactMode: forceCanvasDocument ? "canvas" : "chat",
      }),
    });
    await this.files.attachFilesToMessage(fileIds, userMessage.id, conversationId);

    if (!this.deerFlow.isEnabled()) {
      throw new BadRequestException("DeerFlow 未启用，无法生成回复。");
    }

    // d) 构建 UIMessageStream
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const ctx = createBridgeContext();
        let deliveredUserVisibleResult = false;
        const run = await this.runLogs.createRun({
          conversationId,
          userId: user.id,
          userInput: userContent,
        });
        const controller = new AbortController();
        this.activeRunControllers.set(run.id, controller);
        this.activeRunConversationIds.set(run.id, conversationId);
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
            conversationId,
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
        const documentStream = createDocumentStreamState(run.id, {
          forceDocumentStream:
            forceCanvasDocument || isDocumentGenerationRequest(runtimeContent),
        });
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

          if (!forceCanvasDocument && isKnowledgeInventoryQuestion(userContent)) {
            await this.respondWithKnowledgeInventory({
              content: userContent,
              conversationId,
              ctx,
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
            conversationId,
            runId: run.id,
            message: runtimeContent,
          });

          // 知识库检索结果摘要事件——告诉用户检索了哪些知识
          publishRuntimeEvent(createRuntimeEvent({
            runId: run.id,
            id: `${run.id}:knowledge-complete`,
            kind: "knowledge",
            label: knowledgeContext.length > 0
              ? `知识库检索完成，命中 ${knowledgeContext.length} 条相关知识`
              : "知识库未命中，将根据模型知识和行业经验补充",
            detail: knowledgeContext.length > 0
              ? knowledgeContext
                  .slice(0, 5)
                  .map((k) => `· ${k.title}${k.type ? ` [${k.type}]` : ""}`)
                  .join("\n")
              : "将参考行业最佳实践和产品设计经验",
            status: "completed",
          }));

          const result = await this.deerFlow.runTurn({
            runId: run.id,
            conversationId,
            userId: user.id,
            message: runtimeContent,
            attachments: fileParts,
            attachmentFiles,
            previewMode: "prd",
            conversationDesignState: conversationContext,
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

          let finalAction = result.finalAction;
          let artifacts = result.artifacts;
          let assistantText = result.assistantText;
          const shouldForcePrdFinalAction =
            forceCanvasDocument && finalAction.type !== "review_prd";
          if (
            shouldForcePrdFinalAction ||
            (!finalAction.parsed &&
              (forceCanvasDocument || isDocumentGenerationRequest(runtimeContent)))
          ) {
            finalAction = buildFallbackPrdFinalAction(userContent);
            artifacts = [];
            assistantText = finalAction.message;
            publishRuntimeEvent(createRuntimeEvent({
              runId: run.id,
              id: "fallback-prd-final-action",
              kind: "document",
              label: "模型未返回最终动作，已生成结构化 PRD 草稿",
              detail: "已按标准需求文档结构写入画布，保留 QA 提示供后续补充。",
            }));
          }

          const expectsArtifact =
            finalAction.type === "review_prd" ||
            finalAction.type === "review_prototype";
          if (
            !finalAction.parsed &&
            (forceCanvasDocument || requiresExplicitFinalAction(runtimeContent))
          ) {
            throw new BadRequestException("FINAL_ACTION_REQUIRED_FOR_ARTIFACT_INTENT");
          }
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
            conversationId,
            userId: user.id,
            runId: run.id,
            finalAction,
            artifacts,
            assistantText,
          });

          if (applied.prdDocument) {
            const qaReport = await this.qaService.runForConversation(conversationId, user.id, {
              trigger: "initial_generation",
              runId: run.id,
              prdDocument: applied.prdDocument,
              checkTypes: PRD_GENERATION_QA_CHECK_TYPES,
            });
            const prdChatMessage = `PRD 已生成，${formatQaOutcome(qaReport)}，请在右侧画布查看。`;
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
              conversationId,
              userId: user.id,
              content: prdChatMessage,
              type: MessageType.agent_summary,
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                prdDocumentId: applied.prdDocument.id,
                prdDocumentTitle: applied.prdDocument.title,
                qaReportId: qaReport.id,
                qaStatus: qaReport.status,
                qaBlockingSummary: qaBlockingSummary(qaReport),
                finalActionType: finalAction.type,
                threadId: result.threadId,
              }),
              relatedRunId: run.id,
              relatedPrdDocumentId: applied.prdDocument.id,
              relatedQaReportId: qaReport.id,
            });
            await this.completeRunBestEffort(
              run.id,
              {
                status: "success",
                threadId: result.threadId,
                finalAction,
                prdDocument: applied.prdDocument,
                qaReport,
              },
              prdChatMessage,
            );
            publishRuntimeFinish("succeeded");
          } else if (applied.prototypeArtifact) {
            const qaReport = await this.qaService.runForConversation(conversationId, user.id, {
              trigger: "initial_generation",
              runId: run.id,
              prototypeArtifact: applied.prototypeArtifact,
            });
            const prototypeChatMessage = `原型已生成，${formatQaOutcome(qaReport)}，请在右侧画布查看。`;
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
              conversationId,
              userId: user.id,
              content: prototypeChatMessage,
              type: MessageType.agent_summary,
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                prototypeArtifactId: applied.prototypeArtifact.id,
                prototypeArtifactTitle: applied.prototypeArtifact.title,
                qaReportId: qaReport.id,
                qaStatus: qaReport.status,
                qaBlockingSummary: qaBlockingSummary(qaReport),
                finalActionType: finalAction.type,
                threadId: result.threadId,
              }),
              relatedRunId: run.id,
              relatedPrototypeArtifactId: applied.prototypeArtifact.id,
              relatedQaReportId: qaReport.id,
            });
            await this.completeRunBestEffort(
              run.id,
              {
                status: "success",
                threadId: result.threadId,
                finalAction,
                prototypeArtifact: applied.prototypeArtifact,
                qaReport,
              },
              prototypeChatMessage,
            );
            publishRuntimeFinish("succeeded");
          } else {
            // 无产物：把 finalAction.message 作为文本下发（若未在 chunk 流里）
            const message = finalAction.message || ctx.textBuffer.trim() || assistantText || "本轮未生成产物。";
            finishDocumentStream(streamWriter, documentStream);
            if (!ctx.hasEmittedText) {
              emitStaticText(message, streamWriter, ctx);
              finishReasoning(streamWriter, ctx);
              finishText(streamWriter, ctx);
            }
            deliveredUserVisibleResult = true;
            await assistantDraft.finalize({
              conversationId,
              userId: user.id,
              content: message,
              type: pickAssistantMessageType(finalAction.type),
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                finalAction,
                threadId: result.threadId,
              }),
              relatedRunId: run.id,
            });
            await this.completeRunBestEffort(
              run.id,
              {
                status: "no_artifact",
                finalAction,
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
          this.activeRunConversationIds.delete(run.id);
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
      const conversationId = this.activeRunConversationIds.get(conversationIdOrRunId);
      if (!conversationId) {
        throw new NotFoundException("运行不存在");
      }
      await this.conversations.get(user, conversationId).catch(() => {
        throw new NotFoundException("运行不存在");
      });
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
    run: Pick<RuntimeRunLog, "id" | "conversationId" | "startedAt">,
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
      conversationId: run.conversationId,
      eventType: "runtime_event",
      payload: event,
    });
  }

  /** 移植自 copilot-prd-runtime.service.ts 的知识检索。 */
  private async retrieveKnowledge(input: {
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
      visualAssets: ref.visualAssets,
    }));
  }

  private async respondWithKnowledgeInventory(input: {
    content: string;
    conversationId: string;
    ctx: ReturnType<typeof createBridgeContext>;
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
      scope: "current-conversation",
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
    conversationId: string;
    runId: string;
    message: string;
    limit?: number;
  }) {
    const requirementMode: RequirementMode = classifyRequirementMode(input.message, { hasExistingState: true });
    return this.knowledgeRetrieval.search({
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

const PRD_GENERATION_QA_CHECK_TYPES: QACheckType[] = [
  "prd_completeness",
  "state_prd_consistency",
  "knowledge_rule_compliance",
  "assumption_risk",
];

export type DocumentStreamState = {
  id: string;
  forceDocumentStream: boolean;
  started: boolean;
  finished: boolean;
  title?: string;
  textBuffer: string;
  candidateBuffer: string;
  pending: string;
  inFinalActionBlock: boolean;
};

const FINAL_ACTION_FENCE = "```ai_product_workbench_final_action";

export function createDocumentStreamState(
  runId: string,
  options: { forceDocumentStream?: boolean } = {},
): DocumentStreamState {
  return {
    id: `streaming-prd-${runId}`,
    forceDocumentStream: options.forceDocumentStream ?? false,
    started: false,
    finished: false,
    textBuffer: "",
    candidateBuffer: "",
    pending: "",
    inFinalActionBlock: false,
  };
}

export function routeAssistantDocumentDelta(
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
    if (state.forceDocumentStream && visible) {
      state.candidateBuffer = trimDocumentCandidateBuffer(`${state.candidateBuffer}${visible}`);
      const candidate = extractDocumentDraftCandidate(state.candidateBuffer);
      if (candidate && looksLikeDocumentDraft(candidate, visible)) {
        startDocumentStream(writer, state, candidate);
        writer.write({ type: "data-textDelta", data: candidate, transient: true });
        state.textBuffer += candidate;
        state.candidateBuffer = "";
        updateDocumentStreamTitle(writer, state);
        return { suppressChat: true };
      }

      return { suppressChat: true };
    }

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

export function looksLikeDocumentDraft(buffer: string, delta: string) {
  const sample = normalizeDocumentDraftSample(buffer);
  const current = normalizeDocumentDraftSample(delta);
  if (!sample || sample.length < 8) return false;

  if (looksLikeCompletionSummary(sample)) {
    return false;
  }

  if (looksLikeRuntimeNarration(sample) && !hasStrongDocumentDraftStructure(sample)) {
    return false;
  }

  if (/```?\s*mermaid|(^|\n)\s*mermaid\s*\n|flowchart\s+(TD|LR|BT|RL)|sequenceDiagram|stateDiagram|classDiagram/.test(sample)) {
    return /(需求|文档|说明书|业务|活动|页面|接口|配置|状态|流程|快照|验收)/.test(sample);
  }
  if (looksLikeStructuredJsonDraft(sample)) {
    return false;
  }
  if (hasDocumentTitleLine(sample)) return true;
  if (/^#{1,4}\s*.*(PRD|需求|文档|说明书|功能|页面|产品)/im.test(sample)) return true;
  if (/版本历史/.test(sample) && /\|\s*版本\s*\|/.test(sample)) return true;
  if (
    /(^|\n)\s*(#{1,4}\s*)?(\d+(\.\d+)*[.、]?\s*)?(版本历史|引言|项目背景|文档范围|使用场景|业务需求|功能需求|非功能需求|流程|页面要求|接口|权限|数据|统计|导出|审核|发布|下线|验收标准|业务降级方案|需求安全基线)/.test(sample)
  ) {
    return true;
  }

  const headingCount = (sample.match(/^#{1,4}\s+/gm) ?? []).length;
  if (headingCount >= 2 && /(用户|页面|功能|规则|流程|奖励|活动|接口|配置|权限|数据|统计|导出|审核)/.test(sample)) {
    return true;
  }

  return /^#{1,4}\s*/.test(current) && /(需求|PRD|文档|说明书|功能|页面)/i.test(current);
}

function trimDocumentCandidateBuffer(value: string) {
  const max = 8_000;
  if (value.length <= max) return value;
  return value.slice(-max);
}

function extractDocumentDraftCandidate(value: string) {
  const starts = [
    findDocumentTitleLineStart(value),
    findDocumentSectionStart(value),
    findMarkdownDocumentHeadingStart(value),
  ].filter((index): index is number => typeof index === "number" && index >= 0);
  const start = starts.length ? Math.min(...starts) : undefined;
  if (start === undefined) return undefined;
  return value.slice(start).trimStart();
}

function findDocumentTitleLineStart(value: string) {
  const pattern = /(^|\n)\s*[^\n。！？!?]{2,80}(需求说明书|需求文档|产品需求文档|PRD)(?=\s*(#|\n|$|\|))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const start = match.index + (match[1] ? match[1].length : 0);
    const lineEnd = value.indexOf("\n", start);
    const line = value.slice(start, lineEnd === -1 ? undefined : lineEnd).trim();
    if (!looksLikeRuntimeNarration(line) && !looksLikeCompletionSummary(line)) return start;
  }
  return undefined;
}

function findDocumentSectionStart(value: string) {
  const match = value.match(
    /(^|\n)\s*(#{1,4}\s*)?(\d+(\.\d+)*[.、]?\s*)?(版本历史|引言|项目背景|文档范围|使用场景|业务需求|功能需求|非功能需求|流程|页面要求|接口|权限|数据|统计|导出|审核|发布|下线|验收标准|业务降级方案|需求安全基线)/,
  );
  if (!match || match.index === undefined) return undefined;
  return match.index + (match[1] ? match[1].length : 0);
}

function findMarkdownDocumentHeadingStart(value: string) {
  const match = value.match(
    /(^|\n)\s*#{1,4}\s*.*(PRD|需求|文档|说明书|功能|页面|产品|业务|验收)/i,
  );
  if (!match || match.index === undefined) return undefined;
  return match.index + (match[1] ? match[1].length : 0);
}

function hasStrongDocumentDraftStructure(sample: string) {
  if (/^#{1,4}\s*.*(PRD|需求|文档|说明书|功能|页面|产品)/im.test(sample)) {
    return true;
  }
  if (hasDocumentTitleLine(sample)) return true;
  if (/版本历史/.test(sample) && /\|\s*版本\s*\|/.test(sample)) return true;
  if (
    /(^|\n)\s*(#{1,4}\s*)?(\d+(\.\d+)*[.、]?\s*)?(版本历史|引言|项目背景|文档范围|使用场景|业务需求|功能需求|验收标准|业务降级方案|需求安全基线)/.test(sample)
  ) {
    return true;
  }
  const headingCount = (sample.match(/^#{1,4}\s+/gm) ?? []).length;
  return headingCount >= 2;
}

function looksLikeStructuredJsonDraft(sample: string) {
  return /"type"\s*:\s*"(table|diagram|image|prototype_snapshot|asset_reference|section)"|"blocks"\s*:|"sourcePaths"\s*:|"prdDocumentDraft"\s*:|"designStateDraft"\s*:|"acceptanceCriteria"\s*:|"exceptionScenarios"\s*:|"businessRules"\s*:/.test(sample);
}

function hasDocumentTitleLine(sample: string) {
  return normalizeDocumentDraftSample(sample)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      if (looksLikeRuntimeNarration(line)) return false;
      if (looksLikeCompletionSummary(line)) return false;
      if (line.length > 96) return false;
      return /^(#\s*)?[^。！？!?]{2,80}(需求说明书|需求文档|产品需求文档|PRD)(\s*(#|\||$))?/i.test(line);
    });
}

function looksLikeRuntimeNarration(sample: string) {
  const head = sample.slice(0, 240);
  return /(我已|我将|现在开始|开始分析|分析请求|思考过程|用户明确|用户要求|请求中|已加载技能|调用\s*\w+|工具调用|read[_ ]?file|已完成|已生成|已写入|请在右侧|右侧\s*(PRD\s*)?画布|画布查看|本轮)/i.test(head);
}

function looksLikeCompletionSummary(sample: string) {
  const firstLine = normalizeDocumentDraftSample(sample)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const head = (firstLine || sample).slice(0, 260);
  if (!head) return false;

  const hasArtifactSubject = /(需求说明书|需求文档|产品需求文档|PRD|原型|画布)/i.test(head);
  if (!hasArtifactSubject) return false;

  return (
    /^(已生成|已完成|已写入|PRD\s*已生成|需求文档已生成|产品需求文档已生成|原型已生成)/i.test(head) ||
    /(请在右侧|可在右侧|右侧\s*(PRD\s*)?画布|画布(中)?(查看|继续|评审|修改)|继续评审|继续修改)/i.test(head)
  );
}

function normalizeDocumentDraftSample(value: string) {
  return value
    .replace(/([^\n])(?=#{1,4}\S)/g, "$1\n")
    .replace(/^(#{1,4})(?=\S)/gm, "$1 ")
    .trim();
}

function inferDocumentTitle(value: string) {
  if (looksLikeCompletionSummary(value)) return undefined;

  const heading = value.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading.replace(/[#*`]/g, "").trim().slice(0, 80) || undefined;
  }

  const firstLine = normalizeDocumentDraftSample(value)
    .split("\n")
    .map((line) => line.replace(/[#*`|]/g, "").trim())
    .find(Boolean);
  if (!firstLine || !/(需求文档|需求说明书|产品需求文档|PRD)/i.test(firstLine)) {
    return undefined;
  }
  return firstLine.slice(0, 80);
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

function extractFileParts(message: ChatStreamDto["message"]) {
  if (!message?.parts?.length) return [];
  return message.parts
    .filter((part) => part.type === "file" && typeof part.fileId === "string" && part.fileId.trim())
    .map((part) => ({
      type: "file" as const,
      fileId: part.fileId!.trim(),
      name: part.name?.trim() || "file",
      mediaType: part.mediaType?.trim() || "application/octet-stream",
      size: typeof part.size === "number" ? part.size : undefined,
    }));
}

export function isCanvasDocumentMode(value: unknown): boolean {
  return value === "canvas";
}

export function buildCanvasDocumentRuntimePrompt(userPrompt: string): string {
  const trimmed = userPrompt.trim();
  return [
    trimmed,
    "",
    "请在 Canvas 模式下处理上述输入：直接生成一份结构完整、可评审的产品需求文档（PRD/需求说明书）。",
    "要求最终动作必须是 review_prd，并将完整正文写入 prdDocumentDraft 或 prd_markdown artifact；不要只输出普通聊天建议。",
    "除非用户明确要求原型，否则不要生成原型；不要把工具日志、运行过程或隐藏推理写进需求文档正文。",
  ].join("\n");
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

function buildConversationContextForDeerFlow(session: {
  conversationDesignState?: unknown;
  prd?: unknown;
  prototype?: unknown;
}) {
  const state = asRecord(session.conversationDesignState);
  const prd = asRecord(session.prd);
  const prototype = asRecord(session.prototype);

  return {
    currentConversationDesignState: state
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

export function buildFallbackPrdFinalAction(userPrompt: string): DeerFlowFinalAction {
  const subject = extractPrdSubject(userPrompt);
  const title = `${subject}需求说明书`;
  const section = (
    id: string,
    sectionTitle: string,
    type: string,
    level: 1 | 2 | 3,
    order: number,
    content: string,
  ) => ({
    id,
    title: sectionTitle,
    type,
    level,
    order,
    content,
    sourcePaths: ["fallback.final_action"],
  });
  const designStateDraft = {
    title: subject,
    summary: `围绕${subject}建立可评审、可验收的产品需求闭环。`,
    businessGoal: `完成${subject}的核心业务流程、页面能力、异常处理和验收口径定义。`,
    targetUsers: [
      { id: "target_user", name: "目标用户", description: "使用该能力完成核心业务操作的 C 端用户或运营人员。" },
    ],
    userScenarios: [
      { id: "scenario_main", title: "主流程使用", description: `用户进入${subject}相关页面后完成浏览、选择、确认和结果查看。` },
    ],
    pages: [
      { id: "page_entry", name: `${subject}入口页`, purpose: "承接用户访问并展示核心信息。" },
      { id: "page_detail", name: `${subject}详情/确认页`, purpose: "展示明细、校验条件并提交操作。" },
      { id: "page_record", name: `${subject}记录页`, purpose: "展示操作结果、状态和历史记录。" },
    ],
    features: [
      { id: "feature_entry", title: "入口与列表展示", description: "展示核心对象、状态、筛选和分页加载能力。" },
      { id: "feature_submit", title: "确认与提交", description: "提交前完成资格、库存、余额、权限等必要校验。" },
      { id: "feature_record", title: "结果与记录", description: "展示成功、失败、处理中等状态，并支持用户追踪结果。" },
    ],
    backendConfigs: [
      { id: "config_business", title: "业务配置", description: "支持对象配置、状态管理、上下线控制和基础审计。" },
    ],
    frontendRules: [
      { id: "frontend_empty_error", title: "空态与异常态", description: "接口失败、无数据、无权限和处理中均给出明确提示。" },
    ],
    businessRules: [
      { id: "rule_idempotent", title: "提交幂等", description: "重复点击或请求重试不得造成重复扣减、重复发放或重复创建记录。" },
      { id: "rule_state", title: "状态一致", description: "前端展示状态必须以后端最终状态为准。" },
    ],
    stateRules: [
      { id: "state_flow", title: "状态流转", description: "草稿/可用/处理中/成功/失败/关闭等状态需要有明确入口和退出条件。" },
    ],
    exceptionScenarios: [
      { id: "exception_timeout", title: "接口超时", description: "提示用户稍后查看结果，后端保证幂等。" },
      { id: "exception_no_permission", title: "无权限", description: "隐藏不可用入口或展示无权限说明。" },
    ],
    acceptanceCriteria: [
      { id: "ac_canvas", title: "PRD 可评审", description: "需求文档应在右侧画布完整展示，包含目标、流程、功能、验收标准。" },
      { id: "ac_error", title: "异常可理解", description: "失败、超时、空态、无权限均有用户可理解提示。" },
    ],
    assumptions: [
      { id: "assumption_1", content: "具体页面路径、字段名称、接口地址和运营规则需以后续评审结论为准。", status: "pending" },
    ],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
  };
  const sections = [
    section("intro", "1 引言", "overview", 2, 1, `本文档用于定义${subject}的业务目标、范围、核心流程、功能要求、异常处理、验收标准和安全基线。`),
    section("background", "1.1 项目背景", "background", 3, 2, `${subject}需要形成从用户访问、业务校验、操作提交到结果追踪的完整闭环，降低沟通成本并支撑研发、测试、运营评审。`),
    section("scope", "1.2 文档范围", "scope", 3, 3, `本次范围覆盖${subject}的前端页面、后端配置、关键业务规则、接口联动口径、异常降级、验收标准和安全基线；不包含真实接口地址、密钥、生产账号或不可逆发布操作。`),
    section("scenario", "1.3 使用场景（必填）", "user_scenarios", 3, 4, `用户进入${subject}入口，浏览核心信息，完成必要选择和确认；系统完成资格、状态和风控校验后返回结果，用户可在记录页查看处理进度和最终状态。`),
    section("business", "2 业务需求", "business_goal", 2, 5, designStateDraft.businessGoal),
    section("links", "2.1 页面链接", "page_requirements", 3, 6, [
      `页面入口以实际产品路由为准，至少包含${subject}入口页、${subject}详情/确认页、${subject}记录页。`,
      `${subject}入口页用于承接用户访问并展示核心对象、状态、筛选和空态。`,
      `${subject}详情/确认页用于展示明细、完成资格/库存/权限校验并提交操作。`,
      `${subject}记录页用于展示处理中、成功、失败、取消等状态和历史结果。`,
      "管理后台入口需支持配置、上下线、查询和审计。",
    ].join("\n")),
    section("features", "2.2 核心业务规则/功能说明", "business_rules", 3, 7, [
      "入口页展示核心对象、状态、筛选条件、分页和空态。",
      "提交前校验用户资格、对象状态、库存/额度/权限等关键条件。",
      "提交动作必须幂等，重复点击、网络重试或页面刷新不得产生重复业务结果。",
      "结果页或记录页展示处理中、成功、失败、取消等状态，并提供下一步操作指引。",
    ].join("\n")),
    section("flow", "2.3 核心流程/状态/页面要求", "state_rules", 3, 8, `主流程：访问入口 → 查看列表/详情 → 选择或确认 → 提交 → 系统校验 → 返回结果 → 记录页追踪。状态流转需覆盖草稿、可用、处理中、成功、失败、关闭。`),
    section("interfaces", "2.4 接口能力/联动口径", "backend_configs", 3, 9, "涉及查询、详情、提交、状态查询、记录列表、后台配置等接口能力。具体接口地址以技术方案和联调结果为准；每个接口需明确调用方、触发条件、关键入参、成功结果、失败处理和日志口径。"),
    section("acceptance", "2.5 验收标准", "acceptance_criteria", 3, 10, [
      "需求文档在右侧画布完整展示，运行说明不写入需求正文。",
      "核心页面、状态、异常、权限和空态均可被测试用例覆盖。",
      "接口成功、失败、超时、重复提交和无权限场景均有明确提示和日志。",
      "QA 仅对当前产物范围给出阻塞或补充项，不因未请求的后续产物误判失败。",
    ].join("\n")),
    section("fallback", "3 业务降级方案（必填）", "exception_scenarios", 2, 11, "查询失败时展示空态和重试入口；提交超时时提示用户不要重复提交并到记录页确认结果；后台配置失败时保留原配置并提示运营重试；关键状态以后端最终结果为准。"),
    section("security", "4 需求安全基线要求（必填）", "appendix", 2, 12, [
      "| 序号 | 安全基线内容 | 是否涉及 |",
      "| --- | --- | --- |",
      "| 1 | 是否涉及新增或变更接口 | 是 |",
      "| 2 | 是否涉及用户信息展示或查询 | 是 |",
      "| 3 | 是否涉及第三方跳转或数据共享 | 不涉及 |",
      "| 4 | 是否需要操作日志和异常审计 | 是 |",
      "| 5 | 是否需要权限控制和接口鉴权 | 是 |",
    ].join("\n")),
  ];

  return {
    type: "review_prd",
    message: "已根据当前输入生成结构化 PRD 草稿。",
    intent: "generate_prd",
    requirementMode: "one_sentence_completion",
    parsed: true,
    raw: {
      type: "review_prd",
      designStateDraft,
      prdDocumentDraft: {
        title,
        sections,
        validationNotes: ["DeerFlow 未返回最终动作时由工作台生成的结构化 PRD 草稿，需结合业务细节继续确认。"],
      },
      assumptions: designStateDraft.assumptions,
      knowledgeRefsUsed: [],
      validationNotes: ["fallback_prd_final_action"],
    },
  };
}

function extractPrdSubject(userPrompt: string) {
  const normalized = userPrompt.replace(/\s+/g, " ").trim();
  const explicitSubject = normalized.match(
    /(?:请|帮我|给我|生成|创建|新建|写|撰写|编写|起草|输出|制定|整理|完善|补全|只生成|仅生成|一份|一个|\s)*([^，。,.;；:：!?？]{2,60}?)(?:\s*(?:prd|PRD|需求文档|需求说明书|产品需求文档))/,
  )?.[1];

  const compact = (explicitSubject ?? normalized)
    .replace(/\s+/g, " ")
    .replace(/(不要|无需|不需要|不用|别|先别|禁止|不必|不要再|不)(生成|创建|新建|写|撰写|编写|起草|输出|制定|整理|完善|补全|产出)?原型/gi, "")
    .replace(/要求包含.+$/gi, "")
    .replace(/包含.+$/gi, "")
    .replace(/请|帮我|给我|生成|创建|新建|写|撰写|编写|起草|输出|制定|整理|一份|一个|简短但结构完整的/gi, "")
    .replace(/只生成需求文档|只|仅|包含目标、用户流程、功能需求、验收标准|包含目标|用户流程|功能需求|验收标准|prd|需求文档|需求说明书/gi, "")
    .replace(/[，。,.;；:：]/g, " ")
    .trim();
  return cleanPrdSubject(compact).slice(0, 40) || "产品需求方案";
}

function cleanPrdSubject(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/[的之关于围绕]+$/g, "")
    .replace(/[－\-—_ ]+$/g, "")
    .trim();
}

function isKnowledgeInventoryQuestion(value: string) {
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (!/(知识库|知识|规则库|素材库)/.test(compact)) return false;
  return /(有哪些|有什么|有什么内容|哪些内容|列出|列表|目录|清单|盘点|收录|包含什么|都有什么)/.test(compact);
}

function requiresExplicitFinalAction(value: string) {
  const compact = value.replace(/\s+/g, "").toLowerCase();
  return (
    hasPositiveArtifactIntent(compact, DOCUMENT_ARTIFACT_PATTERN) ||
    hasPositiveArtifactIntent(compact, PROTOTYPE_ARTIFACT_PATTERN) ||
    hasPositiveArtifactIntent(compact, EXPORT_ARTIFACT_PATTERN)
  );
}

export function formatQaOutcome(report: QAReport) {
  if (report.status === "passed") return "QA 通过";
  if (report.status === "warning") return "QA 通过，有待补充项";
  if (report.status === "failed") return "QA 未通过";
  return `QA ${report.status}`;
}

function qaBlockingSummary(report: QAReport) {
  const blocking = report.issues.filter((issue) => issue.severity === "blocking");
  if (blocking.length === 0) return undefined;
  return blocking.slice(0, 3).map((issue) => issue.title).join("；");
}

export function isDocumentGenerationRequest(value: string) {
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (!/(需求文档|需求说明书|产品需求文档|prd|prd文档)/i.test(compact)) {
    return false;
  }
  if (hasNegatedArtifactIntent(compact, DOCUMENT_ARTIFACT_PATTERN)) {
    return false;
  }
  if (/(生成|创建|新建|写|撰写|编写|起草|输出|制定|整理|完善|补全|给我)/.test(compact)) {
    return true;
  }
  if (/(为什么|怎么|如何|哪些|有哪些|风险|问题|评价|检查|审查|对比|原因|吗|？|\?)/.test(compact)) {
    return false;
  }
  return true;
}

const DOCUMENT_ARTIFACT_PATTERN = "(prd|prd文档|需求文档|需求说明书|产品需求文档)";
const PROTOTYPE_ARTIFACT_PATTERN = "(原型|prototype)";
const EXPORT_ARTIFACT_PATTERN = "(导出|下载|export)";

function hasPositiveArtifactIntent(compact: string, artifactPattern: string) {
  return new RegExp(artifactPattern, "i").test(compact)
    && !hasNegatedArtifactIntent(compact, artifactPattern);
}

function hasNegatedArtifactIntent(compact: string, artifactPattern: string) {
  const artifactAction =
    "(生成|创建|新建|写|撰写|编写|起草|输出|制定|整理|完善|补全|产出|触发|打开|唤起)";
  const negationOnly = "(不要|无需|不需要|不用|别|先别|禁止|不必|不要再)";
  const negatedAction = `(${negationOnly}${artifactAction}|不${artifactAction})`;
  const sameClauseGap = "[^，。；;,.!?！？、]{0,16}";

  return (
    new RegExp(`${negatedAction}${sameClauseGap}${artifactPattern}`, "i").test(compact) ||
    new RegExp(`${negationOnly}${sameClauseGap}${artifactAction}${sameClauseGap}${artifactPattern}`, "i").test(compact) ||
    new RegExp(`${artifactPattern}${sameClauseGap}${negatedAction}`, "i").test(compact) ||
    new RegExp(`${artifactPattern}${sameClauseGap}${negationOnly}${sameClauseGap}${artifactAction}`, "i").test(compact) ||
    new RegExp(`(不是|并非)${sameClauseGap}${artifactAction}${sameClauseGap}${artifactPattern}`, "i").test(compact)
  );
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
      ? `\n\n还有 ${output.selectedCount - lines.length} 条已作为执行摘要保留。`
      : "";

  return [
    `我查询到 ${output.selectedCount} 条可用知识（总命中 ${output.matchedCount} 条），摘要如下。`,
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
