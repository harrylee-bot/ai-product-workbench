import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ProjectStatus, UserRole } from "@prisma/client";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import type { AuthenticatedUser } from "../auth/auth.types";
import { FileAssetService } from "../files/file-asset.service";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentRunLogService } from "./agent-run-log.service";
import { AiOrchestratorService } from "./ai-orchestrator.service";
import type { SelectedRegion } from "./ai-vibe.types";
import type { HandleVibeMessageDto, ConfirmPrdDto } from "./dto";
import { ProductDesignStateService } from "./product-design-state.service";
import { VibeStreamService } from "./vibe-stream.service";
import { AgentSkillRegistryService } from "./agent-skill-registry.service";

@Injectable()
export class VibeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messageService: MessageService,
    private readonly fileAssetService: FileAssetService,
    private readonly runLogService: AgentRunLogService,
    private readonly stateService: ProductDesignStateService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly streamService: VibeStreamService,
    private readonly skillRegistry: AgentSkillRegistryService,
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

    const run = await this.runLogService.createRun({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      userInput: dto.message.trim(),
    });

    await this.prisma.project.update({
      where: { id: project.id },
      data: {
        status: ProjectStatus.designing,
        lastActivityAt: new Date(),
      },
    });

    const recentMessages = await this.messageService.getRecentMessages(conversation.id, 20);
    const productDesignState = await this.stateService.getCurrentState(project.id);

    void this.orchestrator
      .run({
        userMessageId: userMessage.id,
        attachments: attachmentSummaries,
        context: {
          runId: run.id,
          projectId: project.id,
          conversationId: conversation.id,
          userId: user.id,
          userInput: dto.message.trim(),
          selectedRegion: dto.selectedRegion as SelectedRegion | undefined,
          previewMode: dto.previewMode,
          recentMessages,
          attachments: attachmentSummaries,
          productDesignState,
          currentProjectStatus: project.status,
          traceId: run.traceId,
        },
      })
      .catch(() => undefined);

    return {
      projectId: project.id,
      conversationId: conversation.id,
      userMessage,
      assistantMessage: null,
      runId: run.id,
      status: "running",
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

    await this.prisma.project.update({
      where: { id: project.id },
      data: { status: ProjectStatus.designing, lastActivityAt: new Date() },
    });

    const recentMessages = await this.messageService.getRecentMessages(conversation.id, 20);

    void this.orchestrator
      .confirmPrdAndContinue({
        userMessageId: confirmMessage.id,
        attachments: [],
        context: {
          runId: run.id,
          projectId: project.id,
          conversationId: conversation.id,
          userId: user.id,
          userInput: "确认 PRD，继续生成原型。",
          recentMessages,
          attachments: [],
          productDesignState,
          currentProjectStatus: project.status,
          traceId: run.traceId,
        },
      })
      .catch(() => undefined);

    return {
      projectId: project.id,
      conversationId: conversation.id,
      runId: run.id,
      status: "running",
    };
  }

  async getRun(user: AuthenticatedUser, runId: string) {
    await this.assertRunAccess(user, runId);
    return this.runLogService.getRun(runId);
  }
  streamRun(runId: string): Observable<MessageEvent> {
    return this.streamService.stream(runId);
  }

  async listSkills() {
    const skills = await this.skillRegistry.listSkills();
    return {
      items: skills,
      count: skills.length,
      source: "kepano/obsidian-skills",
    };
  }

  async assertRunAccess(user: AuthenticatedUser, runId: string) {
    const run = await this.prisma.agentRunLog.findUnique({
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
}
