import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ConversationDesignStateStatus,
  ConversationStatus,
  PrototypeArtifactStatus,
  RequirementDocumentStatus,
  ShareLinkStatus,
  ShareScope,
  UserRole,
} from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationDesignStateService } from "./conversation-design-state.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { PrototypeService, sanitizePrototypeDocumentHtml } from "./prototype.service";

type CreateShareInput = {
  conversationId: string;
  scope?: ShareScope;
  expiresInDays?: number;
};

type ShareLinkRecord = {
  id: string;
  token: string;
  conversationId: string;
  scope: ShareScope;
  status: ShareLinkStatus;
  title: string | null;
  prdDocumentId: string | null;
  prototypeArtifactId: string | null;
  conversationDesignStateId: string | null;
  expiresAt: Date | null;
  viewCount: number;
  lastViewedAt: Date | null;
  revokedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 只读分享链接（FR-4）。
 * - 创建/吊销/列举：仅对话 owner（走 JwtAuthGuard）。
 * - 分享访问需登录，只读；不可下载文档、不可编辑原型（分享层软约束 FR-4.4）。
 * - token 不可枚举（crypto 随机），可设有效期、可吊销（FR-4.5）。
 */
@Injectable()
export class ShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ConversationDesignStateService,
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
  ) {}

  async createForUser(user: AuthenticatedUser, input: CreateShareInput) {
    const conversation = await this.assertConversationAccess(user, input.conversationId);
    this.assertOwnerMutation(user, conversation.ownerId);

    const scope = input.scope ?? ShareScope.both;
    const state = await this.stateService.getCurrentState(input.conversationId);
    if (!state) throw new NotFoundException("SHARE_NO_DESIGN_STATE");

    // 仅允许分享已确认无误的产物：文档需存在、原型需已就绪（FR-4.1）。
    const needsPrd = scope === ShareScope.prd || scope === ShareScope.both;
    const needsPrototype = scope === ShareScope.prototype || scope === ShareScope.both;

    const prdDocument = needsPrd
      ? (await this.documentService.getCurrentForConversation(input.conversationId)).document
      : null;
    if (needsPrd && !prdDocument) {
      throw new BadRequestException("SHARE_PRD_NOT_READY");
    }
    if (needsPrd && prdDocument?.status !== RequirementDocumentStatus.confirmed) {
      throw new BadRequestException("SHARE_PRD_NOT_CONFIRMED");
    }

    const prototype = needsPrototype
      ? await this.prototypeService.getCurrentForConversation(input.conversationId).catch(() => null)
      : null;
    const prototypeArtifact = prototype?.artifact ?? null;
    if (needsPrototype && (!prototypeArtifact || prototypeArtifact.status !== PrototypeArtifactStatus.ready)) {
      throw new BadRequestException("SHARE_PROTOTYPE_NOT_READY");
    }
    if (needsPrototype && state.status !== ConversationDesignStateStatus.confirmed) {
      throw new BadRequestException("SHARE_PROTOTYPE_NOT_CONFIRMED");
    }

    const expiresAt = input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const created = await this.prisma.shareLink.create({
      data: {
        token: this.generateToken(),
        conversationId: input.conversationId,
        scope,
        status: ShareLinkStatus.active,
        title: state.title ?? conversation.title,
        prdDocumentId: prdDocument?.id ?? null,
        prototypeArtifactId: prototypeArtifact?.id ?? null,
        conversationDesignStateId: state.id,
        expiresAt,
        createdBy: user.id,
      },
    });

    return { share: this.toShareItem(created as ShareLinkRecord) };
  }

  async listForUser(user: AuthenticatedUser, conversationId: string) {
    await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    const items = await this.prisma.shareLink.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
    });
    return { items: items.map((item) => this.toShareItem(item as ShareLinkRecord)) };
  }

  async revokeForUser(user: AuthenticatedUser, shareId: string) {
    const share = await this.prisma.shareLink.findUnique({
      where: { id: shareId },
      include: { conversation: true },
    });
    if (!share) throw new NotFoundException("SHARE_NOT_FOUND");
    if (user.role !== UserRole.admin && share.conversation.ownerId !== user.id) {
      throw new ForbiddenException("SHARE_FORBIDDEN");
    }
    this.assertOwnerMutation(user, share.conversation.ownerId);
    const updated = await this.prisma.shareLink.update({
      where: { id: shareId },
      data: { status: ShareLinkStatus.revoked, revokedAt: new Date() },
    });
    return { share: this.toShareItem(updated as ShareLinkRecord) };
  }

  /**
   * 分享解析（控制器层要求登录、只读）。返回可见的文档/原型只读快照。
   * 不暴露任何编辑/导出能力；原型仅返回经安全校验的 HTML。
   */
  async resolveAuthenticatedShare(token: string, options: { incrementView?: boolean } = {}) {
    const incrementView = options.incrementView ?? true;
    const now = new Date();
    const { share, conversation } = await this.prisma.$transaction(async (tx) => {
      const current = await tx.shareLink.findUnique({ where: { token } });
      if (!current) throw new NotFoundException("SHARE_NOT_FOUND");
      if (current.status !== ShareLinkStatus.active) throw new NotFoundException("SHARE_REVOKED");
      if (current.expiresAt && current.expiresAt.getTime() < now.getTime()) {
        throw new NotFoundException("SHARE_EXPIRED");
      }

      const currentConversation = await tx.conversation.findUnique({ where: { id: current.conversationId } });
      if (
        !currentConversation ||
        currentConversation.deletedAt ||
        currentConversation.status !== ConversationStatus.active
      ) {
        throw new NotFoundException("SHARE_CONVERSATION_UNAVAILABLE");
      }

      const resolvedShare = incrementView
        ? await tx.shareLink.update({
            where: { id: current.id },
            data: { viewCount: { increment: 1 }, lastViewedAt: now },
          })
        : current;

      return { share: resolvedShare, conversation: currentConversation };
    });

    const scope = share.scope;
    const wantsPrd = scope === ShareScope.prd || scope === ShareScope.both;
    const wantsPrototype = scope === ShareScope.prototype || scope === ShareScope.both;

    const prd = wantsPrd ? await this.loadAuthenticatedPrd(share as ShareLinkRecord) : null;
    const prototype = wantsPrototype ? await this.loadAuthenticatedPrototype(share as ShareLinkRecord, token) : null;

    return {
      title: share.title ?? conversation.title,
      scope,
      readOnly: true,
      allowDownload: false,
      allowEdit: false,
      prd,
      prototype,
    };
  }

  /** 仅返回原型 HTML，用于 iframe 预览。 */
  async resolveAuthenticatedPrototypeHtml(token: string) {
    const result = await this.resolveAuthenticatedShare(token, { incrementView: false });
    if (!result.prototype?.html) throw new NotFoundException("SHARE_PROTOTYPE_NOT_AVAILABLE");
    return result.prototype.html;
  }

  private async loadAuthenticatedPrd(share: ShareLinkRecord) {
    // 严格只返回分享创建时固化的 prdDocumentId 指向的记录，不 fallback 到会话最新文档。
    // 否则分享后被分享文档删除/降级，会静默返回另一份未在分享时刻确认的内容（share-1）。
    if (!share.prdDocumentId) return null;
    const document = await this.prisma.requirementDocument.findFirst({
      where: { id: share.prdDocumentId, conversationId: share.conversationId },
    });
    if (!document) return null;
    return {
      title: document.title,
      sections: Array.isArray(document.sections) ? document.sections : [],
      updatedAt: document.updatedAt.toISOString(),
    };
  }

  private async loadAuthenticatedPrototype(share: ShareLinkRecord, token: string) {
    // 严格只返回分享创建时固化的 prototypeArtifactId 指向的记录，不 fallback。
    if (!share.prototypeArtifactId) return null;
    const artifact = await this.prisma.prototypeArtifact.findFirst({
      where: { id: share.prototypeArtifactId, conversationId: share.conversationId },
    });
    if (!artifact || artifact.status !== PrototypeArtifactStatus.ready || !artifact.htmlContent) {
      return null;
    }
    return {
      title: artifact.title,
      html: sanitizePrototypeDocumentHtml(artifact.htmlContent, artifact.title),
      previewUrl: `/api/authenticated-share/${token}/prototype`,
      pageCount: artifact.pageCount,
      updatedAt: artifact.updatedAt.toISOString(),
    };
  }

  private generateToken() {
    // 32 字节随机 → base64url，不可枚举（FR-4 安全）。
    return randomBytes(32).toString("base64url");
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
      throw new ForbiddenException("你无权访问该会话");
    }
    return conversation;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接为用户会话创建分享链接");
    }
  }

  private toShareItem(share: ShareLinkRecord) {
    return {
      id: share.id,
      token: share.token,
      conversationId: share.conversationId,
      scope: share.scope,
      status: share.status,
      title: share.title ?? undefined,
      url: `/share/${share.token}`,
      expiresAt: share.expiresAt ? share.expiresAt.toISOString() : undefined,
      viewCount: share.viewCount,
      lastViewedAt: share.lastViewedAt ? share.lastViewedAt.toISOString() : undefined,
      revokedAt: share.revokedAt ? share.revokedAt.toISOString() : undefined,
      createdAt: share.createdAt.toISOString(),
    };
  }
}
