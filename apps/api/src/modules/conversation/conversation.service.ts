import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { Phase1User } from "../auth/auth.types";
import { ProjectService } from "../project/project.service";
import type { CreateConversationDto } from "./dto";

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectService,
  ) {}

  async create(user: Phase1User, dto: CreateConversationDto) {
    const project = await this.projects.getAccessibleProject(user, dto.projectId);
    const conversation = await this.prisma.conversation.create({
      data: {
        projectId: project.id,
        ownerId: project.ownerId,
        title: dto.title?.trim() || "默认会话",
      },
    });

    if (!project.currentConversationId) {
      await this.prisma.project.update({
        where: { id: project.id },
        data: { currentConversationId: conversation.id },
      });
    }

    return { conversation: this.projects.toConversation(conversation) };
  }

  async listByProject(user: Phase1User, projectId: string) {
    await this.projects.getAccessibleProject(user, projectId);
    const conversations = await this.prisma.conversation.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return { items: conversations.map((conversation) => this.projects.toConversation(conversation)) };
  }
}
