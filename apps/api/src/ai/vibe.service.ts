import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { MessageType, ProductDesignStateStatus, ProjectStatus, UserIntent, UserRole } from "@prisma/client";
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

@Injectable()
export class VibeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messageService: MessageService,
    private readonly fileAssetService: FileAssetService,
    private readonly runLogService: RuntimeRunLogService,
    private readonly stateService: ProductDesignStateService,
    private readonly streamService: VibeStreamService,
    private readonly documentService: RequirementDocumentService,
    private readonly deerFlowRuntime: DeerFlowRuntimeService,
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

    const userMessage = await this.messageService.createUserMessage({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      content: dto.message.trim(),
      attachments: attachmentSummaries.length ? attachmentSummaries : undefined,
      metadata: dto.selectedRegion ? { selectedRegion: dto.selectedRegion } : undefined,
    });

    await this.fileAssetService.attachFilesToMessage(
      attachmentSummaries.map((item) => item.fileId),
      userMessage.id,
      project.id,
      conversation.id,
    );
    const runtimeAttachmentFiles = await this.fileAssetService.getRuntimeAttachmentFiles(fileIds, project.id);

    const run = await this.runLogService.createRun({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      userInput: dto.message.trim(),
    });

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

    const confirmMessage = await this.messageService.createUserMessage({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      content: "确认 PRD，继续生成原型。",
    });

    const run = await this.runLogService.createRun({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      userInput: "确认 PRD，继续生成原型。",
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
    void this.runDeerFlowTurn(input).catch(async (error) => {
      await this.runLogService.failRun(input.runId, error);
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
      onEvent: async (event) => {
        if (event.toolName) {
          await this.streamService.emit({
            runId: input.runId,
            projectId: input.projectId,
            type: "message_delta",
            content: `DeerFlow 正在调用能力：${event.toolName}`,
            data: event,
          });
          return;
        }

        if (event.content) {
          await this.streamService.emit({
            runId: input.runId,
            projectId: input.projectId,
            type: "message_delta",
            content: event.content,
            data: event,
          });
        }
      },
    });

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
      nextAction: { type: result.finalAction.type },
    };

    await this.runLogService.completeRun(input.runId, runResult, result.finalAction.message);
    await this.streamService.emit({
      runId: input.runId,
      projectId: input.projectId,
      type: "run_completed",
      content: result.finalAction.message,
      data: runResult,
    });
  }
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
