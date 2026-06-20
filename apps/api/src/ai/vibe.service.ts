import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { MessageType, ProjectStatus, UserRole } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import type { HandleVibeMessageDto } from "./dto";

@Injectable()
export class VibeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messageService: MessageService,
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

    const userMessage = await this.messageService.createUserMessage({
      projectId: project.id,
      conversationId: conversation.id,
      userId: user.id,
      content: dto.message.trim(),
      metadata: dto.selectedRegion ? { selectedRegion: dto.selectedRegion } : undefined,
    });

    const assistantMessage = await this.messageService.createAssistantMessage({
      projectId: project.id,
      conversationId: conversation.id,
      content:
        "已收到你的需求。模块 6 接入后这里会返回真实多 Agent 生成结果；当前已先保存项目会话消息。",
      type: MessageType.agent_summary,
    });

    await this.prisma.project.update({
      where: { id: project.id },
      data: {
        status: ProjectStatus.designing,
        lastActivityAt: new Date(),
      },
    });

    return {
      projectId: project.id,
      conversationId: conversation.id,
      userMessage,
      assistantMessage,
      runId: null,
    };
  }
}
