import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConversationStatus, UserRole } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type { ConversationVersionTimelineItem } from "./ai-vibe.types";

@Injectable()
export class VersionHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listConversationTimeline(user: AuthenticatedUser, conversationId: string) {
    await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    return this.listTimeline(conversationId);
  }

  async listTimeline(conversationId: string) {
    const [stateVersions, prdVersions, prototypeVersions, qaReports, rollbackRecords] =
      await this.prisma.$transaction([
        this.prisma.conversationDesignVersion.findMany({
          where: { conversationId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.requirementDocumentVersion.findMany({
          where: { conversationId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.prototypeVersion.findMany({
          where: { conversationId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.qAReport.findMany({
          where: { conversationId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.rollbackRecord.findMany({
          where: { conversationId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
      ]);

    const items: ConversationVersionTimelineItem[] = [
      ...stateVersions.map((item) => ({
        id: item.id,
        type: "conversation_design_state" as const,
        version: item.version,
        title: `ConversationDesignState v${item.version}`,
        description: item.reason ?? undefined,
        relatedId: item.stateId,
        createdAt: item.createdAt.toISOString(),
        createdBy: item.createdBy,
      })),
      ...prdVersions.map((item) => ({
        id: item.id,
        type: "prd" as const,
        version: item.version,
        title: `PRD v${item.version}`,
        description: item.reason ?? undefined,
        relatedId: item.documentId,
        createdAt: item.createdAt.toISOString(),
        createdBy: item.createdBy,
      })),
      ...prototypeVersions.map((item) => ({
        id: item.id,
        type: "prototype" as const,
        version: item.version,
        title: `HTML 原型 v${item.version}`,
        description: item.reason ?? undefined,
        relatedId: item.artifactId,
        createdAt: item.createdAt.toISOString(),
        createdBy: item.createdBy,
      })),
      ...qaReports.map((item) => ({
        id: item.id,
        type: "qa" as const,
        title: `QA ${item.status}`,
        description: item.summary,
        relatedId: item.id,
        createdAt: item.createdAt.toISOString(),
        createdBy: item.createdBy,
      })),
      ...rollbackRecords.map((item) => ({
        id: item.id,
        type: "rollback" as const,
        title: `回滚 ${item.status}`,
        description: item.reason ?? `v${item.fromConversationDesignStateVersion} -> v${item.toConversationDesignStateVersion}`,
        relatedId: item.id,
        createdAt: item.createdAt.toISOString(),
        createdBy: item.createdBy,
      })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 100);

    return { items };
  }

  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    if (!options.allowArchived && conversation.status === ConversationStatus.archived) {
      throw new ForbiddenException("会话已归档，请先恢复后再继续操作");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("VERSION_FORBIDDEN");
    }
    return conversation;
  }
}
