import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  MessageType,
  ProductDesignStateStatus,
  ProjectStatus,
  RuntimeRunStatus,
  UserIntent,
  UserRole,
} from "@prisma/client";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import type { AuthenticatedUser } from "../auth/auth.types";
import { FileAssetService } from "../files/file-asset.service";
import type { RuntimeAttachmentFile } from "../files/file.types";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeRunLogService } from "./runtime-run-log.service";
import type { HandleVibeMessageDto, ConfirmPrdDto } from "./dto";
import { ProductDesignStateService } from "./product-design-state.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { VibeStreamService } from "./vibe-stream.service";
import { toInputJson } from "./ai-vibe.helpers";
import { DeerFlowRuntimeService, type DeerFlowFinalAction } from "./deerflow-runtime.service";
import { FinalActionApplierService } from "./final-action-applier.service";

@Injectable()
export class VibeService {
  private readonly activeRunControllers = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly messageService: MessageService,
    private readonly fileAssetService: FileAssetService,
    private readonly runLogService: RuntimeRunLogService,
    private readonly stateService: ProductDesignStateService,
    private readonly streamService: VibeStreamService,
    private readonly documentService: RequirementDocumentService,
    private readonly deerFlowRuntime: DeerFlowRuntimeService,
    private readonly finalActionApplier: FinalActionApplierService,
  ) {}

  async handleMessage(user: AuthenticatedUser, dto: HandleVibeMessageDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      include: {
        conversations: {
          where: { id: dto.conversationId },
          take: 1,
        },
      },
    });

    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }

    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该项目");
    }

    if (user.role === UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("管理员不可直接发送用户项目消息");
    }

    if (project.status === ProjectStatus.archived) {
      throw new ForbiddenException("项目已归档，请先恢复后再继续操作");
    }

    const conversation = project.conversations[0];
    if (!conversation || conversation.deletedAt) {
      throw new NotFoundException("会话不存在");
    }

    const fileIds = [...new Set(dto.fileIds ?? [])];
    const attachmentSummaries = await this.fileAssetService.getAttachmentSummaries(fileIds, project.id);
    if (fileIds.length !== attachmentSummaries.length) {
      throw new ForbiddenException("附件不存在或无权访问");
    }

    const run = await this.runLogService.createRun({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      userInput: dto.message.trim(),
    });

    const userMessage = await this.messageService.createUserMessage({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      content: dto.message.trim(),
      attachments: attachmentSummaries.length ? attachmentSummaries : undefined,
      metadata: dto.selectedRegion ? { selectedRegion: dto.selectedRegion } : undefined,
      relatedRunId: run.id,
    });

    await this.fileAssetService.attachFilesToMessage(
      attachmentSummaries.map((item) => item.fileId),
      userMessage.id,
      project.id,
      conversation.id,
    );
    const runtimeAttachmentFiles = await this.fileAssetService.getRuntimeAttachmentFiles(fileIds, project.id);

    if (this.deerFlowRuntime.isEnabled()) {
      this.executeDeerFlowTurn({
        runId: run.id,
        projectId: project.id,
        conversationId: conversation.id,
        userId: user.id,
        message: dto.message.trim(),
        fallbackIntent: UserIntent.general_question,
        attachments: attachmentSummaries,
        attachmentFiles: runtimeAttachmentFiles,
        selectedRegion: dto.selectedRegion,
        previewMode: dto.previewMode,
      });

      return {
        projectId: project.id,
        conversationId: conversation.id,
        userMessage,
        assistantMessage: null,
        runId: run.id,
        status: "running",
      };
    }

    const assistantMessage = await this.finishPendingDeerFlowTurn({
      runId: run.id,
      projectId: project.id,
      conversationId: conversation.id,
      intent: UserIntent.general_question,
      message: "DeerFlow 2.0 流程大脑尚未接入；旧的自研生成链路已停用。本轮已安全结束，不会生成或改写 PRD、原型和产品状态。",
    });

    return {
      projectId: project.id,
      conversationId: conversation.id,
      userMessage,
      assistantMessage,
      runId: run.id,
      status: "completed",
    };
  }

  /**
   * 确认门 A（FR-1.3）：用户确认 PRD 后继续生成原型。
   * 在一个新的 run 上从原型阶段恢复——暂停状态来自已持久化的 ProductDesignState。
   */
  async confirmPrd(user: AuthenticatedUser, dto: ConfirmPrdDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      include: {
        conversations: { where: { id: dto.conversationId }, take: 1 },
      },
    });

    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该项目");
    }
    if (user.role === UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("管理员不可直接操作用户项目");
    }
    if (project.status === ProjectStatus.archived) {
      throw new ForbiddenException("项目已归档，请先恢复后再继续操作");
    }

    const conversation = project.conversations[0];
    if (!conversation || conversation.deletedAt) {
      throw new NotFoundException("会话不存在");
    }

    const productDesignState = await this.stateService.getCurrentState(project.id);
    if (!productDesignState) {
      throw new NotFoundException("找不到待确认的产品设计状态");
    }
    if (!productDesignState.prdDocument) {
      throw new ForbiddenException("当前还没有可确认的 PRD 文档");
    }
    if (productDesignState.prototypeSpec) {
      throw new ForbiddenException("当前项目已生成原型，不能重复触发 PRD 确认门");
    }
    if (
      productDesignState.status !== ProductDesignStateStatus.doc_ready &&
      productDesignState.status !== ProductDesignStateStatus.doc_confirmed
    ) {
      throw new ForbiddenException("当前 PRD 不在待确认状态，不能继续生成原型");
    }
    const confirmedState = productDesignState.status === ProductDesignStateStatus.doc_confirmed &&
      productDesignState.prdDocument.status === "confirmed"
      ? productDesignState
      : (await this.documentService.confirmForPrototypeGate(
          user,
          productDesignState.prdDocument.id,
          "用户确认 PRD，继续生成原型",
        )).productDesignState;

    const run = await this.runLogService.createRun({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      userInput: "确认 PRD，继续生成原型。",
    });

    const confirmMessage = await this.messageService.createUserMessage({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      content: "确认 PRD，继续生成原型。",
      relatedRunId: run.id,
    });

    if (this.deerFlowRuntime.isEnabled()) {
      this.executeDeerFlowTurn({
        runId: run.id,
        projectId: project.id,
        conversationId: conversation.id,
        userId: user.id,
        message: "确认 PRD，继续生成原型。",
        fallbackIntent: UserIntent.generate_prototype,
        resumeReason: "user_confirmed_prd",
        productDesignState: confirmedState,
      });

      return {
        projectId: project.id,
        conversationId: conversation.id,
        runId: run.id,
        assistantMessage: null,
        status: "running",
      };
    }

    const assistantMessage = await this.finishPendingDeerFlowTurn({
      runId: run.id,
      projectId: project.id,
      conversationId: conversation.id,
      intent: UserIntent.generate_prototype,
      message: "PRD 确认已记录。DeerFlow 2.0 流程大脑接入前，旧的后端自研原型生成链路已停用；本轮不会继续生成原型。",
      productDesignState: confirmedState,
    });

    return {
      projectId: project.id,
      conversationId: conversation.id,
      runId: run.id,
      assistantMessage,
      status: "completed",
    };
  }

  async getRun(user: AuthenticatedUser, runId: string) {
    await this.assertRunAccess(user, runId);
    return this.runLogService.getRun(runId);
  }

  async cancelRun(user: AuthenticatedUser, runId: string, reason?: string) {
    const run = await this.assertRunCancellationAccess(user, runId);
    const normalizedReason = normalizeCancelReason(reason);

    const result = await this.runLogService.cancelRun({
      runId,
      canceledBy: user.id,
      reason: normalizedReason,
    });
    const currentStatus = result?.run.status ?? run.status;
    if (result?.changed) {
      this.activeRunControllers.get(runId)?.abort();
    }

    if (result?.changed) {
      await this.streamService.emit({
        runId,
        projectId: run.projectId,
        type: "run_canceled",
        content: "执行已停止。",
        data: {
          runId,
          status: RuntimeRunStatus.cancelled,
          reason: normalizedReason,
          messageStatus: "not_created",
        },
      });
    }

    return {
      runId,
      projectId: run.projectId,
      conversationId: run.conversationId,
      status: currentStatus,
      reason: normalizedReason,
      messageStatus: "not_created",
      canceled: currentStatus === RuntimeRunStatus.cancelled,
    };
  }

  streamRun(runId: string): Observable<MessageEvent> {
    return this.streamService.stream(runId);
  }

  async assertRunAccess(user: AuthenticatedUser, runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
      include: { project: true },
    });

    if (!run || run.project.deletedAt || run.project.status === ProjectStatus.deleted) {
      throw new NotFoundException("执行记录不存在");
    }

    if (user.role !== UserRole.admin && run.project.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该执行记录");
    }
  }

  private async assertRunCancellationAccess(user: AuthenticatedUser, runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
      include: { project: true, conversation: true },
    });

    if (
      !run ||
      run.project.deletedAt ||
      run.project.status === ProjectStatus.deleted ||
      run.conversation.deletedAt ||
      run.conversation.projectId !== run.projectId
    ) {
      throw new NotFoundException("执行记录不存在");
    }

    if (run.userId !== user.id || run.project.ownerId !== user.id || run.conversation.ownerId !== user.id) {
      throw new ForbiddenException("你无权停止该执行记录");
    }

    return run;
  }

  private async finishPendingDeerFlowTurn(input: {
    runId: string;
    projectId: string;
    conversationId: string;
    intent: UserIntent;
    message: string;
    productDesignState?: unknown;
  }) {
    const runtimeAdapter = {
      status: "not_configured",
      provider: "deerflow",
      mode: "deerflow_first",
    };

    await this.runLogService.markRunIntent(input.runId, input.intent);
    await this.streamService.emit({
      runId: input.runId,
      projectId: input.projectId,
      type: "message_delta",
      content: input.message,
      data: { runtimeAdapter },
    });

    const assistantMessage = await this.messageService.createAssistantMessage({
      projectId: input.projectId,
      conversationId: input.conversationId,
      content: input.message,
      type: MessageType.agent_summary,
      metadata: toInputJson({
        runId: input.runId,
        intent: input.intent,
        runtimeAdapter,
        productDesignState: input.productDesignState,
      }),
      relatedRunId: input.runId,
    });

    const result = {
      runId: input.runId,
      projectId: input.projectId,
      intent: {
        intent: input.intent,
        confidence: 1,
        reason: "旧自研编排已停用，等待 DeerFlow 2.0 lead agent 接管 turn decision。",
        requiresSelection: false,
        isAmbiguous: false,
      },
      message: input.message,
      runtimeAdapter,
      productDesignState: input.productDesignState,
      nextAction: { type: "answer" },
    };

    await this.runLogService.completeRun(input.runId, result, input.message);
    await this.streamService.emit({
      runId: input.runId,
      projectId: input.projectId,
      type: "run_completed",
      content: input.message,
      data: result,
    });

    return assistantMessage;
  }

  private executeDeerFlowTurn(input: {
    runId: string;
    projectId: string;
    conversationId: string;
    userId: string;
    message: string;
    fallbackIntent: UserIntent;
    attachments?: unknown[];
    attachmentFiles?: RuntimeAttachmentFile[];
    selectedRegion?: unknown;
    previewMode?: string;
    resumeReason?: string;
    productDesignState?: unknown;
  }) {
    const controller = new AbortController();
    this.activeRunControllers.set(input.runId, controller);
    void this.runDeerFlowTurn(input).catch(async (error) => {
      if (await this.runLogService.isRunCancelled(input.runId)) return;
      const changed = await this.runLogService.failRun(input.runId, error);
      if (!changed) return;
      const message = error instanceof Error ? error.message : "DeerFlow runtime 执行失败";
      await this.streamService.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "run_failed",
        content: message,
        data: { provider: "deerflow", errorMessage: message },
      });
      await this.messageService.createAssistantMessage({
        projectId: input.projectId,
        conversationId: input.conversationId,
        content: `DeerFlow 执行失败：${message}`,
        type: MessageType.error,
        metadata: toInputJson({
          runId: input.runId,
          provider: "deerflow",
          errorMessage: message,
        }),
        relatedRunId: input.runId,
      });
    }).finally(() => {
      if (this.activeRunControllers.get(input.runId) === controller) {
        this.activeRunControllers.delete(input.runId);
      }
    });
  }

  private async runDeerFlowTurn(input: {
    runId: string;
    projectId: string;
    conversationId: string;
    userId: string;
    message: string;
    fallbackIntent: UserIntent;
    attachments?: unknown[];
    attachmentFiles?: RuntimeAttachmentFile[];
    selectedRegion?: unknown;
    previewMode?: string;
    resumeReason?: string;
    productDesignState?: unknown;
  }) {
    const signal = this.activeRunControllers.get(input.runId)?.signal;
    await this.streamService.emit({
      runId: input.runId,
      projectId: input.projectId,
      type: "step_started",
      step: "requirement_packaging",
      content: "正在把请求交给 DeerFlow 2.0 lead agent。",
      data: { provider: "deerflow" },
    });

    const result = await this.deerFlowRuntime.runTurn({
      runId: input.runId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      userId: input.userId,
      message: input.message,
      attachments: input.attachments,
      attachmentFiles: input.attachmentFiles,
      selectedRegion: input.selectedRegion,
      previewMode: input.previewMode,
      resumeReason: input.resumeReason,
      productDesignState: input.productDesignState,
      signal,
      onEvent: async (event) => {
        if (signal?.aborted || !(await this.runLogService.isRunRunning(input.runId))) return;
        const runtimeStatus = deerFlowRuntimeStatusMessage(event);
        if (!runtimeStatus) return;
        await this.streamService.emit({
          runId: input.runId,
          projectId: input.projectId,
          type: "message_delta",
          content: runtimeStatus,
          data: event,
        });
      },
    });

    if (signal?.aborted || !(await this.runLogService.isRunRunning(input.runId))) return;

    await this.streamService.emit({
      runId: input.runId,
      projectId: input.projectId,
      type: "step_completed",
      step: "requirement_packaging",
      content: "DeerFlow lead agent 已完成本轮执行。",
      data: { provider: "deerflow", threadId: result.threadId },
    });

    const intent = toUserIntent(result.finalAction.intent) ?? input.fallbackIntent;
    await this.runLogService.markRunIntent(input.runId, intent);

    if (signal?.aborted || !(await this.runLogService.isRunRunning(input.runId))) return;

    // pipe-6：finalAction 未解析时不再静默降级。若 DeerFlow 产出了 artifact 但动作块未识别，
    // emit step_failed 告警，避免「本轮已完成」却无产物、无确认门的静默失败。
    if (!result.finalAction.parsed && result.artifacts.length > 0) {
      await this.streamService.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "step_failed",
        step: "requirement_packaging",
        content: "未识别到 DeerFlow 的最终动作（final action 解析失败），本轮无确认门。",
        data: { provider: "deerflow", finalActionParsed: false, artifactCount: result.artifacts.length },
      });
    }

    const assistantMessage = await this.messageService.createAssistantMessage({
      projectId: input.projectId,
      conversationId: input.conversationId,
      content: result.finalAction.message,
      type: messageTypeForFinalAction(result.finalAction.type),
      metadata: toInputJson({
        runId: input.runId,
        provider: "deerflow",
        threadId: result.threadId,
        finalAction: result.finalAction,
        uploads: result.uploads,
        artifacts: result.artifacts,
        finalState: result.finalState,
      }),
      relatedRunId: input.runId,
    });

    // 落库桥接（审计 P0 根因修复）：把 DeerFlow 产物写入 RequirementDocument /
    // PrototypeArtifact / ProductDesignState，并 emit prd_updated / prototype_updated。
    let applied: { prdDocument?: unknown; prototypeArtifact?: unknown; state?: unknown } = {};
    try {
      applied = await this.finalActionApplier.apply({
        projectId: input.projectId,
        userId: input.userId,
        runId: input.runId,
        finalAction: result.finalAction,
        artifacts: result.artifacts,
      });
    } catch (applyError) {
      // 落库失败不阻断 run 完成，但需可观测：emit step_failed 并记录。
      const applyErrorMessage = applyError instanceof Error ? applyError.message : "DeerFlow 产物落库失败";
      await this.streamService.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "step_failed",
        step: result.finalAction.type === "review_prototype" ? "prototype_code_generation" : "prd_generation",
        content: `产物落库失败：${applyErrorMessage}`,
        data: { provider: "deerflow", errorMessage: applyErrorMessage },
      });
    }

    if (applied.prdDocument) {
      await this.streamService.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "prd_updated",
        content: "PRD 已生成并更新到右侧预览区。",
        // data 直接是 document 对象（前端 normalizePrdPreview 读 record.sections）。
        data: applied.prdDocument,
      });
    }
    if (applied.prototypeArtifact) {
      await this.streamService.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "prototype_updated",
        content: "原型已生成并更新到右侧预览区。",
        // data 直接是 artifact 对象（前端 asRecord(payload.prototypeArtifact) ?? payload 兜底）。
        data: applied.prototypeArtifact,
      });
    }

    const runResult = {
      runId: input.runId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      provider: "deerflow",
      threadId: result.threadId,
      finalAction: result.finalAction,
      uploads: result.uploads,
      artifacts: result.artifacts,
      finalState: result.finalState,
      assistantMessageId: assistantMessage.id,
      prdDocument: applied.prdDocument,
      prototypeArtifact: applied.prototypeArtifact,
      nextAction: { type: result.finalAction.type },
    };

    const completed = await this.runLogService.completeRun(input.runId, runResult, result.finalAction.message);
    if (!completed) return;
    await this.streamService.emit({
      runId: input.runId,
      projectId: input.projectId,
      type: "run_completed",
      content: result.finalAction.message,
      data: runResult,
    });
  }
}

function normalizeCancelReason(reason: string | undefined) {
  const trimmed = reason?.trim();
  return trimmed ? trimmed.slice(0, 200) : "user_requested";
}

function toUserIntent(value: string | undefined): UserIntent | undefined {
  if (!value) return undefined;
  if (value in UserIntent) return UserIntent[value as keyof typeof UserIntent];
  return Object.values(UserIntent).includes(value as UserIntent) ? value as UserIntent : undefined;
}

function messageTypeForFinalAction(type: DeerFlowFinalAction["type"]) {
  if (type === "answer") return MessageType.text;
  if (type === "ask_clarification") return MessageType.clarification;
  return MessageType.agent_summary;
}

function deerFlowRuntimeStatusMessage(event: { event: string; content?: string; toolName?: string }) {
  if (event.toolName) return `DeerFlow 正在调用能力：${event.toolName}`;
  if (event.event.startsWith("gateway-")) return event.content;
  if (event.event === "status" || event.event === "runtime-status" || event.event === "authorization") {
    return event.content;
  }
  if (event.event === "error") return event.content ?? "DeerFlow runtime 返回错误事件。";
  return undefined;
}
