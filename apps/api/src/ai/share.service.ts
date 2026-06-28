import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ProductDesignStateStatus,
  ProjectStatus,
  PrototypeArtifactStatus,
  RequirementDocumentStatus,
  ShareLinkStatus,
  ShareScope,
  UserRole,
} from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { ProductDesignStateService } from "./product-design-state.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { PrototypeService, sanitizePrototypeHtml } from "./prototype.service";

type CreateShareInput = {
  projectId: string;
  scope?: ShareScope;
  expiresInDays?: number;
};

type ShareLinkRecord = {
  id: string;
  token: string;
  projectId: string;
  scope: ShareScope;
  status: ShareLinkStatus;
  title: string | null;
  prdDocumentId: string | null;
  prototypeArtifactId: string | null;
  productDesignStateId: string | null;
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
 * - 创建/吊销/列举：仅项目 owner（走 JwtAuthGuard）。
 * - 公开解析：免登录、只读；不可下载文档、不可编辑原型（产品层软约束 FR-4.4）。
 * - token 不可枚举（crypto 随机），可设有效期、可吊销（FR-4.5）。
 */
@Injectable()
export class ShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ProductDesignStateService,
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
  ) {}

  async createForUser(user: AuthenticatedUser, input: CreateShareInput) {
    const project = await this.assertProjectAccess(user, input.projectId);
    this.assertOwnerMutation(user, project.ownerId);

    const scope = input.scope ?? ShareScope.both;
    const state = await this.stateService.getCurrentState(input.projectId);
    if (!state) throw new NotFoundException("SHARE_NO_PRODUCT_DESIGN_STATE");

    // 仅允许分享已确认无误的产物：文档需存在、原型需已就绪（FR-4.1）。
    const needsPrd = scope === ShareScope.prd || scope === ShareScope.both;
    const needsPrototype = scope === ShareScope.prototype || scope === ShareScope.both;

    const prdDocument = needsPrd
      ? (await this.documentService.getCurrentForProject(input.projectId)).document
      : null;
    if (needsPrd && !prdDocument) {
      throw new BadRequestException("SHARE_PRD_NOT_READY");
    }
    if (needsPrd && prdDocument?.status !== RequirementDocumentStatus.confirmed) {
      throw new BadRequestException("SHARE_PRD_NOT_CONFIRMED");
    }

    const prototype = needsPrototype
      ? await this.prototypeService.getCurrentForProject(input.projectId).catch(() => null)
      : null;
    const prototypeArtifact = prototype?.artifact ?? null;
    if (needsPrototype && (!prototypeArtifact || prototypeArtifact.status !== PrototypeArtifactStatus.ready)) {
      throw new BadRequestException("SHARE_PROTOTYPE_NOT_READY");
    }
    if (needsPrototype && state.status !== ProductDesignStateStatus.confirmed) {
      throw new BadRequestException("SHARE_PROTOTYPE_NOT_CONFIRMED");
    }

    const expiresAt = input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const created = await this.prisma.shareLink.create({
      data: {
        token: this.generateToken(),
        projectId: input.projectId,
        scope,
        status: ShareLinkStatus.active,
        title: state.title ?? project.title,
        prdDocumentId: prdDocument?.id ?? null,
        prototypeArtifactId: prototypeArtifact?.id ?? null,
        productDesignStateId: state.id,
        expiresAt,
        createdBy: user.id,
      },
    });

    return { share: this.toShareItem(created as ShareLinkRecord) };
  }

  async listForUser(user: AuthenticatedUser, projectId: string) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const items = await this.prisma.shareLink.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return { items: items.map((item) => this.toShareItem(item as ShareLinkRecord)) };
  }

  async revokeForUser(user: AuthenticatedUser, shareId: string) {
    const share = await this.prisma.shareLink.findUnique({
      where: { id: shareId },
      include: { project: true },
    });
    if (!share) throw new NotFoundException("SHARE_NOT_FOUND");
    if (user.role !== UserRole.admin && share.project.ownerId !== user.id) {
      throw new ForbiddenException("SHARE_FORBIDDEN");
    }
    this.assertOwnerMutation(user, share.project.ownerId);
    const updated = await this.prisma.shareLink.update({
      where: { id: shareId },
      data: { status: ShareLinkStatus.revoked, revokedAt: new Date() },
    });
    return { share: this.toShareItem(updated as ShareLinkRecord) };
  }

  /**
   * 公开解析（免登录、只读）。返回访客可见的文档/原型只读快照。
   * 不暴露任何编辑/导出能力；原型仅返回经安全校验的 HTML。
   */
  async resolvePublic(token: string, options: { incrementView?: boolean } = {}) {
    const incrementView = options.incrementView ?? true;
    const now = new Date();
    const { share, project } = await this.prisma.$transaction(async (tx) => {
      const current = await tx.shareLink.findUnique({ where: { token } });
      if (!current) throw new NotFoundException("SHARE_NOT_FOUND");
      if (current.status !== ShareLinkStatus.active) throw new NotFoundException("SHARE_REVOKED");
      if (current.expiresAt && current.expiresAt.getTime() < now.getTime()) {
        throw new NotFoundException("SHARE_EXPIRED");
      }

      const currentProject = await tx.project.findUnique({ where: { id: current.projectId } });
      if (!currentProject || currentProject.deletedAt || currentProject.status === ProjectStatus.deleted) {
        throw new NotFoundException("SHARE_PROJECT_UNAVAILABLE");
      }

      const resolvedShare = incrementView
        ? await tx.shareLink.update({
            where: { id: current.id },
            data: { viewCount: { increment: 1 }, lastViewedAt: now },
          })
        : current;

      return { share: resolvedShare, project: currentProject };
    });

    const scope = share.scope;
    const wantsPrd = scope === ShareScope.prd || scope === ShareScope.both;
    const wantsPrototype = scope === ShareScope.prototype || scope === ShareScope.both;

    const prd = wantsPrd ? await this.loadPublicPrd(share as ShareLinkRecord) : null;
    const prototype = wantsPrototype ? await this.loadPublicPrototype(share as ShareLinkRecord) : null;

    return {
      title: share.title ?? project.title,
      scope,
      readOnly: true,
      allowDownload: false,
      allowEdit: false,
      prd,
      prototype,
    };
  }

  /** 仅返回原型 HTML（免登录），用于 iframe 预览。 */
  async resolvePublicPrototypeHtml(token: string) {
    const result = await this.resolvePublic(token, { incrementView: false });
    if (!result.prototype?.html) throw new NotFoundException("SHARE_PROTOTYPE_NOT_AVAILABLE");
    return result.prototype.html;
  }

  private async loadPublicPrd(share: ShareLinkRecord) {
    // 严格只返回分享创建时固化的 prdDocumentId 指向的记录，不 fallback 到项目最新文档。
    // 否则分享后被分享文档删除/降级，会静默返回另一份未在分享时刻确认的内容（share-1）。
    if (!share.prdDocumentId) return null;
    const document = await this.prisma.requirementDocument.findFirst({
      where: { id: share.prdDocumentId, projectId: share.projectId },
    });
    if (!document) return null;
    return {
      title: document.title,
      sections: Array.isArray(document.sections) ? document.sections : [],
      updatedAt: document.updatedAt.toISOString(),
    };
  }

  private async loadPublicPrototype(share: ShareLinkRecord) {
    // 严格只返回分享创建时固化的 prototypeArtifactId 指向的记录，不 fallback。
    if (!share.prototypeArtifactId) return null;
    const artifact = await this.prisma.prototypeArtifact.findFirst({
      where: { id: share.prototypeArtifactId, projectId: share.projectId },
    });
    if (!artifact || artifact.status !== PrototypeArtifactStatus.ready || !artifact.htmlContent) {
      return null;
    }
    return {
      title: artifact.title,
      html: sanitizePrototypeHtml(artifact.htmlContent),
      pageCount: artifact.pageCount,
      updatedAt: artifact.updatedAt.toISOString(),
    };
  }

  private generateToken() {
    // 32 字节随机 → base64url，不可枚举（FR-4 安全）。
    return randomBytes(32).toString("base64url");
  }

  private async assertProjectAccess(
    user: AuthenticatedUser,
    projectId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    if (!options.allowArchived && project.status === ProjectStatus.archived) {
      throw new ForbiddenException("项目已归档，请先恢复后再继续操作");
    }
    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该项目");
    }
    return project;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接为用户项目创建分享链接");
    }
  }

  private toShareItem(share: ShareLinkRecord) {
    return {
      id: share.id,
      token: share.token,
      projectId: share.projectId,
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
