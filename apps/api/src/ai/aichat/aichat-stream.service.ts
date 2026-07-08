import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { KnowledgeType, MessageType, Prisma, type RuntimeRunLog } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { resolveSelectedRuntimeModelName } from "../../common/runtime-model-config";
import { ConversationService } from "../../modules/conversation/conversation.service";
import { KnowledgeRetrievalService } from "../../knowledge/knowledge-retrieval.service";
import { FileAssetService } from "../../files/file-asset.service";
import { MessageService } from "../../conversations/message.service";
import { DeerFlowRuntimeService } from "../deerflow-runtime.service";
import type {
  DeerFlowFinalAction,
  DeerFlowResolvedArtifact,
  DeerFlowKnowledgeReference,
  DeerFlowRuntimeEvent,
  DeerFlowTurnResult,
} from "../deerflow-runtime.service";
import { FinalActionApplierService } from "../final-action-applier.service";
import { ExternalResearchService, type ExternalResearchContext } from "../external-research.service";
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
  finishReasoning,
  finishText,
  getPersistedToolParts,
  recordToolInputAvailable,
  recordToolOutputAvailable,
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
    private readonly externalResearch: ExternalResearchService,
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
    const selectedModelName = resolveSelectedRuntimeModelName(dto.selectedChatModel);

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
        selectedChatModel: dto.selectedChatModel,
        selectedModelName,
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
            hasExistingState: hasExistingDesignContext(conversationContext),
          });

          // 知识库检索结果摘要事件——告诉用户检索了哪些知识
          publishRuntimeEvent(createRuntimeEvent({
            runId: run.id,
            id: `${run.id}:knowledge-complete`,
            kind: "knowledge",
            label: knowledgeContext.length > 0
              ? `已用知识库打底，命中 ${knowledgeContext.length} 条`
              : "知识库未命中，已停止伪装引用",
            detail: knowledgeContext.length > 0
              ? knowledgeContext
                  .slice(0, 5)
                  .map((k) => `· ${k.title}${k.relatedPath ? `（${k.relatedPath}）` : ""}`)
                  .join("\n")
              : "本轮不会假装基于知识库；需要继续时会用模型能力和可用联网能力补齐通用信息。",
            status: "completed",
          }));

          const externalResearchContext = await this.externalResearch.research({
            message: runtimeContent,
            knowledgeHitCount: knowledgeContext.length,
            signal: controller.signal,
          }).catch((error) => ({
            status: "failed" as const,
            fetchedAt: new Date().toISOString(),
            searchQueries: [],
            refs: [],
            failures: [{ error: serializeError(error) }],
            privacyBoundary: [],
          }));
          publishRuntimeEvent(createRuntimeEvent(buildExternalResearchRuntimeEvent({
            runId: run.id,
            context: externalResearchContext,
          })));

          publishRuntimeEvent(createRuntimeEvent(buildModelEnrichmentStartedRuntimeEvent(run.id)));
          const stopModelHeartbeat = startModelHeartbeat(streamWriter, run.id, () =>
            clientClosed || controller.signal.aborted,
          );
          const modelController = createChildAbortController(controller.signal);
          let modelTimedOut = false;
          const modelTimeout = setTimeout(() => {
            modelTimedOut = true;
            modelController.abort(new Error("MODEL_ENRICHMENT_TIMEBOX_EXCEEDED"));
          }, readModelTimeboxMs());
          modelTimeout.unref?.();
          let result: DeerFlowTurnResult;
          try {
            result = await this.deerFlow.runTurn({
              runId: run.id,
              conversationId,
              userId: user.id,
              message: runtimeContent,
              attachments: fileParts,
              attachmentFiles,
              selectedModelName,
              previewMode: "prd",
              conversationDesignState: conversationContext,
              knowledgeContext,
              externalResearchContext,
              signal: modelController.signal,
              onEvent: (event) => {
                if (controller.signal.aborted) return;
                const previousTextLength = ctx.textBuffer.length;
                for (const runtimeEvent of runtimeEventsFromDeerFlow(event, ctx, run.id, {
                  exposeToolEvents: false,
                })) {
                  publishRuntimeEvent(runtimeEvent);
                }
                const routedDocumentDelta = routeAssistantDocumentDelta(event, streamWriter, documentStream);
                if (!routedDocumentDelta.suppressChat) {
                  emitDeerFlowEvent(event, streamWriter, ctx, {
                    exposeToolParts: false,
                  });
                } else {
                  emitDeerFlowEvent({ ...event, chunk: "", content: "" }, streamWriter, ctx, {
                    exposeToolParts: false,
                  });
                }
                if (ctx.textBuffer.length > previousTextLength) {
                  void assistantDraft.persist();
                }
              },
            });
          } catch (error) {
            if (!modelTimedOut || controller.signal.aborted) throw error;
            publishRuntimeEvent(createRuntimeEvent(buildModelTimeboxFallbackRuntimeEvent(run.id)));
            result = buildTimeboxedFallbackTurnResult({
              runId: run.id,
              message: runtimeContent,
              knowledgeContext,
              externalResearchContext,
            });
          } finally {
            clearTimeout(modelTimeout);
            stopModelHeartbeat();
          }
          publishRuntimeEvent(createRuntimeEvent(buildModelEnrichmentRuntimeEvent({
            runId: run.id,
            finalAction: result.finalAction,
          })));

          // 收尾文本/步骤 part
          finishReasoning(streamWriter, ctx);
          finishText(streamWriter, ctx);
          await assistantDraft.persist(true);

          let finalAction = result.finalAction;
          let artifacts = result.artifacts;
          let assistantText = result.assistantText;
          let prdGenerationFailureReason = getPrdGenerationFailureReason({
            finalAction,
            artifacts,
            expectsPrdDocument: forceCanvasDocument || isDocumentGenerationRequest(runtimeContent),
          });
          if (prdGenerationFailureReason) {
            publishRuntimeEvent(createRuntimeEvent({
              runId: run.id,
              id: "model-final-action-fallback",
              kind: "knowledge",
              label: "模型未返回完整产物，已先生成可编辑初稿",
              detail: `${prdGenerationFailureReason}；系统已基于知识库命中和公开资料补齐生成 PRD 与原型初稿。`,
              status: "completed",
            }));
            result = buildTimeboxedFallbackTurnResult({
              runId: run.id,
              message: runtimeContent,
              knowledgeContext,
              externalResearchContext,
            });
            finalAction = result.finalAction;
            artifacts = result.artifacts;
            assistantText = result.assistantText;
            prdGenerationFailureReason = getPrdGenerationFailureReason({
              finalAction,
              artifacts,
              expectsPrdDocument: forceCanvasDocument || isDocumentGenerationRequest(runtimeContent),
            });
            if (prdGenerationFailureReason) {
              publishRuntimeEvent(createRuntimeEvent({
                runId: run.id,
                id: "prd-generation-failed",
                kind: "error",
                label: "需求文档生成失败",
                detail: `${prdGenerationFailureReason}，请重试。`,
                status: "failed",
              }));
              throw new PrdGenerationFailedError(prdGenerationFailureReason);
            }
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

          if (applied.prdDocument && applied.prototypeArtifact) {
            const qaReport = await this.qaService.runForConversation(conversationId, user.id, {
              trigger: "initial_generation",
              runId: run.id,
              prdDocument: applied.prdDocument,
              prototypeArtifact: applied.prototypeArtifact,
            });
            const combinedChatMessage = formatArtifactReadyMessage({
              prdTitle: applied.prdDocument.title,
              prototypeTitle: applied.prototypeArtifact.title,
              qaReport,
            });
            publishRuntimeEvent(createRuntimeEvent({
              runId: run.id,
              id: "apply-final-action",
              kind: "document",
              label: "PRD 和原型已写入工作台",
            }));
            emitStaticText(combinedChatMessage, streamWriter, ctx);
            finishReasoning(streamWriter, ctx);
            finishText(streamWriter, ctx);
            finishDocumentStream(streamWriter, documentStream);
            emitPrdArtifact(applied.prdDocument, streamWriter);
            emitPrdDocumentPreview(applied.prdDocument, streamWriter);
            emitPrototypeArtifact(applied.prototypeArtifact, streamWriter);
            emitPrototypeDocumentPreview(applied.prototypeArtifact, streamWriter);
            publishRuntimeEvent(createRuntimeEvent({
              runId: run.id,
              id: "prd-and-prototype-ready",
              kind: "document",
              label: "PRD 和原型已生成，正在唤起右侧画布",
              detail: `${applied.prdDocument.title} / ${applied.prototypeArtifact.title}`,
              artifact: {
                id: applied.prototypeArtifact.id,
                title: applied.prototypeArtifact.title || "原型",
                kind: "prototype",
              },
            }));
            deliveredUserVisibleResult = true;
            await assistantDraft.finalize({
              conversationId,
              userId: user.id,
              content: combinedChatMessage,
              type: MessageType.agent_summary,
              metadata: toInputJson({
                source: "aichat",
                runId: run.id,
                prdDocumentId: applied.prdDocument.id,
                prdDocumentTitle: applied.prdDocument.title,
                prototypeArtifactId: applied.prototypeArtifact.id,
                prototypeArtifactTitle: applied.prototypeArtifact.title,
                qaReportId: qaReport.id,
                qaStatus: qaReport.status,
                qaBlockingSummary: qaBlockingSummary(qaReport),
                finalActionType: finalAction.type,
                threadId: result.threadId,
              }),
              relatedRunId: run.id,
              relatedPrdDocumentId: applied.prdDocument.id,
              relatedPrototypeArtifactId: applied.prototypeArtifact.id,
              relatedQaReportId: qaReport.id,
            });
            await this.completeRunBestEffort(
              run.id,
              {
                status: "success",
                threadId: result.threadId,
                finalAction,
                prdDocument: applied.prdDocument,
                prototypeArtifact: applied.prototypeArtifact,
                qaReport,
              },
              combinedChatMessage,
            );
            publishRuntimeFinish("succeeded");
          } else if (applied.prdDocument) {
            const qaReport = await this.qaService.runForConversation(conversationId, user.id, {
              trigger: "initial_generation",
              runId: run.id,
              prdDocument: applied.prdDocument,
              checkTypes: PRD_GENERATION_QA_CHECK_TYPES,
            });
            const prdChatMessage = formatArtifactReadyMessage({
              prdTitle: applied.prdDocument.title,
              qaReport,
            });
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
            const prototypeChatMessage = formatArtifactReadyMessage({
              prototypeTitle: applied.prototypeArtifact.title,
              qaReport,
            });
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
            const userVisibleFailureMessage = userVisibleGenerationFailureMessage(error);
            await assistantDraft.finalize({
              conversationId,
              userId: user.id,
              content: userVisibleFailureMessage || ctx.textBuffer.trim() || "生成失败，请重试",
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
            streamWriter.write({ type: "error", errorText: userVisibleFailureMessage || "生成失败，请重试" });
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
    hasExistingState: boolean;
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
      relatedPath: ref.relatedPath,
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
    recordToolInputAvailable(
      {
        toolCallId,
        toolName: "listKnowledgeBase",
        input: toolInput,
      },
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
    recordToolOutputAvailable({ toolCallId, output }, input.ctx);

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
    hasExistingState?: boolean;
  }) {
    const requirementMode: RequirementMode = classifyRequirementMode(input.message, {
      hasExistingState: input.hasExistingState ?? false,
    });
    return this.knowledgeRetrieval.search({
      conversationId: input.conversationId,
      runId: input.runId,
      runtimeName: "runtime_generation",
      query: buildKnowledgeSearchQuery(input.message, requirementMode),
      limit: input.limit ?? 10,
      requirementMode,
      vaultPolicy: "always",
      preferredTypes: [
        KnowledgeType.strong_rule,
        KnowledgeType.default_rule,
        KnowledgeType.design_pattern,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.prototype_rule,
        KnowledgeType.business_concept,
        KnowledgeType.reference_case,
        KnowledgeType.product_architecture,
        KnowledgeType.page_inventory,
        KnowledgeType.ui_style_guide,
        KnowledgeType.prototype_asset_ref,
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

const PRD_GENERATION_RETRY_MESSAGE = "生成失败，请重试";

class PrdGenerationFailedError extends Error {
  readonly userMessage = PRD_GENERATION_RETRY_MESSAGE;

  constructor(reason: string) {
    super(`PRD_GENERATION_FAILED: ${reason}`);
    this.name = "PrdGenerationFailedError";
  }
}

export function getPrdGenerationFailureReason(input: {
  finalAction: DeerFlowFinalAction;
  artifacts: DeerFlowResolvedArtifact[];
  expectsPrdDocument: boolean;
}): string | undefined {
  if (!input.expectsPrdDocument) return undefined;
  if (!input.finalAction.parsed) return "模型未返回可解析的最终动作";
  const canCarryPrd =
    input.finalAction.type === "review_prd" ||
    input.finalAction.type === "review_prototype";
  if (!canCarryPrd) return "模型未返回需求文档最终动作";
  if (!hasUsablePrdDocumentPayload(input.finalAction, input.artifacts)) {
    return "模型未返回完整需求文档正文";
  }
  return undefined;
}

function hasUsablePrdDocumentPayload(
  finalAction: DeerFlowFinalAction,
  artifacts: DeerFlowResolvedArtifact[],
) {
  const raw = asRecord(finalAction.raw);
  const prdDraft = asRecord(raw?.prdDocumentDraft);
  if (hasUsablePrdSections(prdDraft?.sections)) return true;
  return artifacts.some((artifact) => {
    if (artifact.status === "failed") return false;
    if (!artifact.text?.trim()) return false;
    const descriptor = [
      artifact.kind,
      artifact.title,
      artifact.contentType,
      artifact.path,
      artifact.artifactUrl,
    ].filter(Boolean).join(" ").toLowerCase();
    return descriptor.includes("prd") || descriptor.includes("markdown");
  });
}

function hasUsablePrdSections(value: unknown) {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    const section = asRecord(item);
    if (!section) return false;
    if (typeof section.content === "string" && section.content.trim().length >= 20) return true;
    return Array.isArray(section.blocks) && section.blocks.length > 0;
  });
}

function userVisibleGenerationFailureMessage(error: unknown) {
  if (error instanceof PrdGenerationFailedError) return error.userMessage;
  return undefined;
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

function hasExistingDesignContext(context: ReturnType<typeof buildConversationContextForDeerFlow>) {
  return Boolean(
    context.currentConversationDesignState ||
      context.currentPrdDocument ||
      context.currentPrototypeArtifact,
  );
}

export function buildKnowledgeSearchQuery(message: string, requirementMode: RequirementMode) {
  const compact = message.replace(/\s+/g, "");
  const expansions = [
    `需求模式:${requirementMode}`,
    "产品能力地图 端到端业务流程 Agent任务分类与补全规则",
  ];

  if (/(需求文档|需求说明书|产品需求文档|prd)/i.test(compact)) {
    expansions.push("PRD标准结构 按业务域写作规则 验收风险清单");
  }

  if (/(原型|prototype|页面|界面|交互)/i.test(compact)) {
    expansions.push("原型生成总规则 前后台页面框架 字段接口状态表达");
  }

  if (/(活动|签到|打卡|积分|奖励|奖品|权益|领券|抽奖|模板|发布|审核|报表)/.test(compact)) {
    expansions.push("活动发布与模板配置 奖品券与资损核销 权益履约 库存 核销 资损 审核发布 数据报表");
  }

  if (/(签到|打卡|连续|积分|每日)/.test(compact)) {
    expansions.push("每日签到 连续签到 签到奖励 积分发放 重复领取限制 用户参与态 已签到 未签到 补签");
  }

  return [message, ...expansions].join("\n");
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

export function formatArtifactReadyMessage(input: {
  prdTitle?: string;
  prototypeTitle?: string;
  qaReport: QAReport;
}) {
  const parts = [
    input.prdTitle ? `PRD《${cleanArtifactTitle(input.prdTitle, "需求文档")}》` : undefined,
    input.prototypeTitle ? `原型《${cleanArtifactTitle(input.prototypeTitle, "原型")}》` : undefined,
  ].filter(Boolean);
  const subject = parts.length ? parts.join("和") : "产物";
  return `${subject}已生成，${formatQaOutcome(input.qaReport)}。请在右侧画布查看和继续修改。`;
}

export function buildExternalResearchRuntimeEvent(input: {
  runId: string;
  context: ExternalResearchContext;
}) {
  const refs = input.context.refs.slice(0, 4);
  if (refs.length) {
    return {
      runId: input.runId,
      id: "external-research-complete",
      kind: "knowledge" as const,
      label: `已用公开资料补齐 ${input.context.refs.length} 条`,
      detail: refs.map((item) => `· ${cleanRuntimeEventText(item.title)}`).join("\n"),
      status: "completed" as const,
    };
  }

  if (input.context.status === "skipped_not_needed") {
    return {
      runId: input.runId,
      id: "external-research-skipped",
      kind: "knowledge" as const,
      label: "本轮未使用公开资料补齐",
      detail: "知识库未命中或当前需求不需要联网补充；系统不会伪装外部引用。",
      status: "completed" as const,
    };
  }

  return {
    runId: input.runId,
    id: "external-research-unavailable",
    kind: "knowledge" as const,
    label: "公开资料补齐暂不可用，已继续生成",
    detail: "联网失败不会阻塞生成；外部资料缺失时会按知识库和模型补齐继续，并在文档里标明状态。",
    status: "completed" as const,
  };
}

export function buildModelEnrichmentStartedRuntimeEvent(runId: string) {
  return {
    runId,
    id: "model-enrichment-start",
    kind: "knowledge" as const,
    label: "正在用模型补齐业务细节",
    detail: "基于知识库和公开资料，补齐默认流程、页面状态、异常处理和验收口径。",
    status: "running" as const,
  };
}

export function buildModelTimeboxFallbackRuntimeEvent(runId: string) {
  return {
    runId,
    id: "model-enrichment-timebox-fallback",
    kind: "knowledge" as const,
    label: "模型生成超时，已先生成可编辑初稿",
    detail: "避免用户空等；初稿基于知识库命中、公开资料补齐和明确标注的默认假设生成，可继续让模型细化。",
    status: "completed" as const,
  };
}

export function buildModelEnrichmentRuntimeEvent(input: {
  runId: string;
  finalAction: DeerFlowFinalAction;
}) {
  const raw = input.finalAction.raw && typeof input.finalAction.raw === "object" && !Array.isArray(input.finalAction.raw)
    ? input.finalAction.raw as Record<string, unknown>
    : {};
  const notes = Array.isArray(raw.enrichmentNotes)
    ? raw.enrichmentNotes
        .map((item) => cleanRuntimeEventText(String(item ?? "")))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  return {
    runId: input.runId,
    id: "model-enrichment-complete",
    kind: "knowledge" as const,
    label: "已用模型补齐业务细节",
    detail: notes.length
      ? notes.map((item) => `· ${item}`).join("\n")
      : "已补齐默认流程、状态、异常处理和待确认项；本地知识库规则仍作为优先依据。",
    status: "completed" as const,
  };
}

function startModelHeartbeat(
  writer: UIMessageStreamWriter,
  runId: string,
  shouldStop: () => boolean,
) {
  let sequence = 0;
  const timer = setInterval(() => {
    if (shouldStop()) return;
    try {
      writer.write({
        type: "data-runtime-heartbeat",
        data: {
          runId,
          phase: "model_enrichment",
          label: "模型仍在生成中",
          sequence: ++sequence,
          at: new Date().toISOString(),
        },
        transient: true,
      });
    } catch {
      // heartbeat 只用于保持线上 SSE 活性，失败不影响主流程。
    }
  }, 10_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function buildTimeboxedFallbackTurnResult(input: {
  runId: string;
  message: string;
  knowledgeContext: DeerFlowKnowledgeReference[];
  externalResearchContext: ExternalResearchContext;
}): DeerFlowTurnResult {
  const title = inferFallbackActivityTitle(input.message);
  const prdTitle = `${title}需求说明书`;
  const prototypeTitle = `${title}原型`;
  const knowledgeRefsUsed = input.knowledgeContext
    .slice(0, 8)
    .map((item) => item.relatedPath ? `${item.title}（${item.relatedPath}）` : item.title);
  const externalRefsUsed = input.externalResearchContext.refs
    .slice(0, 5)
    .map((item) => `${item.title} ${item.url}`);
  const boundary = input.externalResearchContext.privacyBoundary.length
    ? input.externalResearchContext.privacyBoundary.join("；")
    : "公开资料只补充通用经验，不发送内部路径、附件原文、真实接口或密钥，不覆盖本地知识库规则。";
  const enrichmentNotes = [
    "知识库命中后优先复用活动配置闭环、奖品券与资损核销、PRD结构和原型规范。",
    "模型生成超过时间盒，系统先按通用产品推理补齐默认签到状态、异常处理、验收口径和待确认项。",
    input.externalResearchContext.refs.length
      ? `联网补齐使用 ${input.externalResearchContext.refs.length} 条公开资料；${boundary}`
      : `联网补齐状态：${input.externalResearchContext.status}；${boundary}`,
  ];
  const externalEvidenceText = externalRefsUsed.length
    ? externalRefsUsed.join("\n")
    : "本轮未取得可引用公开来源，后续可继续补充。";
  const sections = [
    {
      id: "intro",
      title: "1 引言",
      type: "overview",
      level: 1,
      order: 1,
      content: [
        `1.1 项目背景：面向活动运营人员和前台用户，建设${title}，通过每日签到发放积分，提升用户活跃和连续访问。`,
        "1.2 文档范围：覆盖后台活动配置、审核发布、用户签到、积分发放、异常补偿、数据报表和安全风控。",
        "1.3 使用场景：运营创建活动并配置积分规则；用户每日进入活动页完成签到；系统校验资格并发放积分；运营查看报表并处理异常。",
      ].join("\n"),
      sourcePaths: knowledgeRefsUsed,
    },
    {
      id: "business",
      title: "2 业务需求",
      type: "requirement",
      level: 1,
      order: 2,
      content: [
        "2.1 页面链接：后台包含活动配置、规则配置、奖品/积分权益配置、审核发布、数据报表；前台包含活动首页、立即签到、已签到、连续签到奖励、失败补偿和无资格状态。",
        "2.2 核心业务规则：同一用户按自然日每日只允许成功签到一次，重复签到不得重复发放积分；支持基础积分、连续签到阶梯奖励、活动周期、参与人群、每日总额度和用户领取上限。",
        "2.3 状态与流程：草稿配置 -> 预览校验 -> 提交审核 -> 发布上线 -> 用户签到 -> 积分发放 -> 数据报表 -> 下线归档。签到状态包括未开始、可签到、已签到、连续奖励达成、额度不足、发放失败待补偿、活动结束。",
        "2.4 验收标准：后台可完成活动配置和发布；前台能展示立即签到和已签到状态；重复签到不重复发积分；额度不足、发放失败、无资格均有明确提示；报表可查看签到人数、发放成功、发放失败、补偿中和资损风险。",
      ].join("\n"),
      sourcePaths: knowledgeRefsUsed,
    },
    {
      id: "degrade",
      title: "3 业务降级方案",
      type: "risk",
      level: 1,
      order: 3,
      content: [
        "积分发放失败时先记录待补偿，不向用户展示成功到账；支持自动重试和人工补偿。",
        "积分系统不可用时，签到记录可先落待处理状态，前台提示“积分稍后到账”。",
        "活动额度或库存不足时停止发放奖励，保留签到记录并提示奖励已抢完或稍后处理。",
        "报表延迟时展示最近一次统计时间，避免运营误判实时数据。",
      ].join("\n"),
      sourcePaths: knowledgeRefsUsed,
    },
    {
      id: "security",
      title: "4 需求安全基线要求",
      type: "risk",
      level: 1,
      order: 4,
      content: [
        "资损控制：积分发放必须有幂等键、额度校验、重复领取限制和对账记录。",
        "权限控制：活动配置、审核、发布、补偿和下线需要分角色授权。",
        "风控要求：异常频次、批量签到、设备/账号风险、积分发放失败率需要进入监控。",
        `联网补齐证据：外部补充状态：${input.externalResearchContext.status}。\n${externalEvidenceText}\n边界：${boundary}`,
      ].join("\n"),
      sourcePaths: knowledgeRefsUsed,
    },
  ];
  const html = buildFallbackPrototypeHtml({
    title,
    prototypeTitle,
    externalTitles: input.externalResearchContext.refs.map((item) => item.title),
  });
  const raw = {
    type: "review_prototype",
    intent: "one_sentence_completion",
    requirementMode: "one_sentence_completion",
    designStateDraft: {
      title,
      summary: `${title}覆盖后台配置、前台签到、积分发放、异常补偿和数据报表。`,
      businessGoal: "用签到激励提升活跃，同时控制积分资损和运营配置风险。",
      targetUsers: [{ role: "运营人员" }, { role: "前台用户" }],
      pages: [{ name: "活动配置" }, { name: "用户签到页" }, { name: "数据报表" }],
      features: [{ name: "每日签到" }, { name: "积分发放" }, { name: "补偿重试" }],
      businessRules: [{ name: "每日一次" }, { name: "幂等发放" }, { name: "额度库存控制" }],
      exceptionScenarios: [{ name: "发放失败" }, { name: "额度不足" }, { name: "重复签到" }],
    },
    prdDocumentDraft: {
      title: prdTitle,
      sections,
      validationNotes: [
        "模型生成超过时间盒，本初稿用于保证用户可立即得到可编辑产物。",
      ],
    },
    prototypeSpec: {
      title: prototypeTitle,
      targetDevice: "both",
      pages: [
        { name: "活动配置" },
        { name: "用户签到页" },
        { name: "数据报表" },
      ],
      interactions: [
        { name: "提交审核" },
        { name: "立即签到" },
        { name: "补偿重试" },
      ],
    },
    assumptions: [
      "默认按自然日限制每日一次签到。",
      "默认积分发放需要幂等、额度和补偿记录。",
      "默认后台配置需要审核发布闭环。",
    ],
    knowledgeRefsUsed,
    externalRefsUsed,
    externalResearchStatus: input.externalResearchContext.status,
    enrichmentNotes,
    artifacts: [
      {
        kind: "prototype_html",
        title: prototypeTitle,
        path: "generated://timeboxed-fallback/index.html",
        artifactUrl: "generated://timeboxed-fallback/index.html",
        contentType: "text/html",
      },
    ],
  };

  return {
    threadId: `timeboxed-fallback-${input.runId}`,
    assistantText: `${prdTitle}和${prototypeTitle}已生成。`,
    finalAction: {
      type: "review_prototype",
      message: `${prdTitle}和${prototypeTitle}已生成。`,
      intent: "one_sentence_completion",
      requirementMode: "one_sentence_completion",
      knowledgeRefsUsed,
      externalRefsUsed,
      enrichmentNotes,
      externalResearchStatus: input.externalResearchContext.status,
      artifacts: raw.artifacts,
      raw,
      parsed: true,
    },
    uploads: [],
    artifacts: [
      {
        kind: "prototype_html",
        title: prototypeTitle,
        path: "generated://timeboxed-fallback/index.html",
        artifactUrl: "generated://timeboxed-fallback/index.html",
        contentType: "text/html",
        status: "fetched",
        size: Buffer.byteLength(html),
        text: html,
      },
    ],
    rawEvents: [],
    finalState: raw,
  };
}

function buildFallbackPrototypeHtml(input: {
  title: string;
  prototypeTitle: string;
  externalTitles: string[];
}) {
  const evidence = input.externalTitles.slice(0, 4).map((title) => `<li>${escapeHtml(title)}</li>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.prototypeTitle)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2937; background: #f4f7fb; }
    main { display: grid; grid-template-columns: 320px 1fr; min-height: 100vh; }
    aside { background: #102033; color: #f8fafc; padding: 28px 24px; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 26px; line-height: 1.25; }
    h2 { font-size: 18px; margin-bottom: 14px; }
    h3 { font-size: 16px; margin-bottom: 8px; }
    .side-note { margin-top: 18px; color: #cbd5e1; line-height: 1.7; font-size: 14px; }
    .content { padding: 28px; display: grid; gap: 18px; }
    .toolbar { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; }
    .tab, button { border: 1px solid #cbd5e1; background: #fff; color: #1f2937; border-radius: 6px; padding: 9px 12px; font-size: 14px; }
    .tab.active, button.primary { background: #176b87; color: white; border-color: #176b87; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    section, .panel { background: white; border: 1px solid #dbe3ef; border-radius: 8px; padding: 18px; box-shadow: 0 8px 20px rgba(15, 23, 42, 0.04); }
    label { display: block; font-size: 13px; color: #64748b; margin: 10px 0 6px; }
    input, select { width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; font-size: 14px; }
    .phone { width: 280px; min-height: 520px; border: 10px solid #111827; border-radius: 28px; background: #fff; margin: 0 auto; overflow: hidden; }
    .phone-head { background: #176b87; color: white; padding: 18px; }
    .sign-card { margin: 16px; padding: 18px; border-radius: 8px; background: #e8f7f4; border: 1px solid #9bd4c5; }
    .status-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
    .status { padding: 10px; border-radius: 6px; background: #f1f5f9; text-align: center; font-size: 12px; }
    .metric { display: flex; justify-content: space-between; border-bottom: 1px solid #e2e8f0; padding: 10px 0; }
    .warning { background: #fff7ed; border-color: #fed7aa; }
    ul { margin: 8px 0 0; padding-left: 18px; line-height: 1.7; }
    @media (max-width: 920px) { main { grid-template-columns: 1fr; } .grid { grid-template-columns: 1fr; } .phone { width: 100%; max-width: 320px; } }
  </style>
</head>
<body>
  <main>
    <aside>
      <h1>${escapeHtml(input.title)}</h1>
      <p class="side-note">知识库打底，公开资料补齐。模型生成超过时间盒时，系统先产出可编辑初稿，避免用户空等。</p>
      <div class="side-note">核心闭环：活动配置 -> 提交审核 -> 发布上线 -> 立即签到 -> 积分发放 -> 数据报表。</div>
    </aside>
    <div class="content">
      <div class="toolbar">
        <div class="tabs"><span class="tab active">后台配置</span><span class="tab">前台签到</span><span class="tab">数据报表</span><span class="tab">补齐策略</span></div>
        <button class="primary">提交审核</button>
      </div>
      <div class="grid">
        <section>
          <h2>活动配置</h2>
          <label>活动名称</label><input value="${escapeHtml(input.title)}" />
          <label>活动周期</label><input value="2026-07-10 至 2026-08-10" />
          <label>参与人群</label><select><option>全部登录用户</option><option>指定标签用户</option></select>
          <label>积分规则</label><input value="每日签到 +10，连续 7 天额外 +50" />
        </section>
        <section>
          <h2>用户签到页</h2>
          <div class="phone">
            <div class="phone-head"><h3>签到领积分</h3><p>连续签到 3 天</p></div>
            <div class="sign-card">
              <h3>今日可领取 10 积分</h3>
              <button class="primary">立即签到</button>
              <div class="status-row"><div class="status">未签到</div><div class="status">已签到</div><div class="status">连续奖励</div></div>
            </div>
            <div class="sign-card warning">异常状态：额度不足、发放失败、无资格、积分稍后到账。</div>
          </div>
        </section>
        <section>
          <h2>数据报表</h2>
          <div class="metric"><span>签到人数</span><strong>12,480</strong></div>
          <div class="metric"><span>积分发放成功</span><strong>118,900</strong></div>
          <div class="metric"><span>发放失败</span><strong>36</strong></div>
          <div class="metric"><span>补偿中</span><strong>18</strong></div>
          <div class="metric"><span>资损风险</span><strong>低</strong></div>
        </section>
      </div>
      <section>
        <h2>补齐策略</h2>
        <ul>
          <li>每日一次与重复签到幂等：同一用户同一自然日只发一次积分。</li>
          <li>额度库存与资损控制：校验活动总额度、用户上限、发放流水和对账。</li>
          <li>积分失败补偿降级：失败进入待补偿，前台展示稍后到账。</li>
          ${evidence || "<li>公开资料未取得时，只使用知识库和默认假设，不伪装引用。</li>"}
        </ul>
      </section>
    </div>
  </main>
</body>
</html>`;
}

function inferFallbackActivityTitle(message: string) {
  if (/签到|打卡/.test(message) && /积分/.test(message)) return "签到领积分活动";
  const compact = message.replace(/请根据知识库内容生成需求文档和原型/g, "").replace(/[，。,.]/g, " ").trim();
  const candidate = compact.match(/(?:我想做|做一个|生成一个|创建一个)?\s*([^\s]{2,24}(?:活动|系统|功能|工具|页面|应用))/)?.[1];
  return candidate || "活动方案";
}

function createChildAbortController(parentSignal: AbortSignal) {
  const child = new AbortController();
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason);
    return child;
  }
  parentSignal.addEventListener("abort", () => child.abort(parentSignal.reason), { once: true });
  return child;
}

function readModelTimeboxMs() {
  const raw = Number(process.env.AICHAT_MODEL_TIMEBOX_MS ?? "");
  if (Number.isFinite(raw) && raw >= 10_000) return raw;
  return 90_000;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanArtifactTitle(value: string, fallback: string) {
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !looksLikeUserVisibleRuntimeNoise(item));
  return (line || fallback).replace(/[《》]/g, "").slice(0, 80);
}

function looksLikeUserVisibleRuntimeNoise(value: string) {
  return /Context from AI Product Workbench|Updated todo list|read_file|write_todos|write_file|tool-input|tool-output|messages-tuple/i.test(value);
}

function cleanRuntimeEventText(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !looksLikeUserVisibleRuntimeNoise(line))
    .join(" ")
    .slice(0, 160);
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
