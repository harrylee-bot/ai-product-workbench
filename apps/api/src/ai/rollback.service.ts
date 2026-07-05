import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ConversationStatus,
  RollbackRecordStatus,
  RollbackType,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type { RollbackRecord } from "./ai-vibe.types";
import { ConversationDesignStateService } from "./conversation-design-state.service";

type RollbackRecordRow = {
  id: string;
  conversationId: string;
  rollbackType: RollbackType;
  fromConversationDesignStateVersion: number;
  toConversationDesignStateVersion: number;
  beforePrdDocumentId: string | null;
  afterPrdDocumentId: string | null;
  beforePrototypeArtifactId: string | null;
  afterPrototypeArtifactId: string | null;
  reason: string | null;
  status: RollbackRecordStatus;
  generatedByRunId: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class RollbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ConversationDesignStateService,
  ) {}

  async listConversationRollbackRecords(user: AuthenticatedUser, conversationId: string) {
    await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    const items = await this.prisma.rollbackRecord.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { items: items.map((item) => this.toRollbackRecord(item as RollbackRecordRow)) };
  }

  toRollbackRecord(row: RollbackRecordRow): RollbackRecord {
    return {
      id: row.id,
      conversationId: row.conversationId,
      rollbackType: row.rollbackType,
      fromConversationDesignStateVersion: row.fromConversationDesignStateVersion,
      toConversationDesignStateVersion: row.toConversationDesignStateVersion,
      beforePrdDocumentId: row.beforePrdDocumentId ?? undefined,
      afterPrdDocumentId: row.afterPrdDocumentId ?? undefined,
      beforePrototypeArtifactId: row.beforePrototypeArtifactId ?? undefined,
      afterPrototypeArtifactId: row.afterPrototypeArtifactId ?? undefined,
      reason: row.reason ?? undefined,
      status: row.status,
      generatedByRunId: row.generatedByRunId ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
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
      throw new ForbiddenException("ROLLBACK_FORBIDDEN");
    }
    return conversation;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接回滚用户会话");
    }
  }
}
