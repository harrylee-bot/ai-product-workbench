import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ProjectStatus, UserRole } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type { ProjectVersionTimelineItem } from "./ai-vibe.types";

@Injectable()
export class VersionHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listProjectTimeline(user: AuthenticatedUser, projectId: string) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    return this.listTimeline(projectId);
  }

  async listTimeline(projectId: string) {
    const [stateVersions, prdVersions, prototypeVersions, qaReports, rollbackRecords] =
      await this.prisma.$transaction([
        this.prisma.productDesignVersion.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.requirementDocumentVersion.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.prototypeVersion.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.qAReport.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.rollbackRecord.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
      ]);

    const items: ProjectVersionTimelineItem[] = [
      ...stateVersions.map((item) => ({
        id: item.id,
        type: "product_design_state" as const,
        version: item.version,
        title: `ProductDesignState v${item.version}`,
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
        description: item.reason ?? `v${item.fromProductDesignStateVersion} -> v${item.toProductDesignStateVersion}`,
        relatedId: item.id,
        createdAt: item.createdAt.toISOString(),
        createdBy: item.createdBy,
      })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 100);

    return { items };
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
      throw new ForbiddenException("VERSION_FORBIDDEN");
    }
    return project;
  }
}
