import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ProjectStatus,
  RollbackRecordStatus,
  RollbackType,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type { RollbackRecord } from "./ai-vibe.types";
import { ProductDesignStateService } from "./product-design-state.service";

type RollbackRecordRow = {
  id: string;
  projectId: string;
  rollbackType: RollbackType;
  fromProductDesignStateVersion: number;
  toProductDesignStateVersion: number;
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
    private readonly stateService: ProductDesignStateService,
  ) {}

  async listProjectRollbackRecords(user: AuthenticatedUser, projectId: string) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const items = await this.prisma.rollbackRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { items: items.map((item) => this.toRollbackRecord(item as RollbackRecordRow)) };
  }

  toRollbackRecord(row: RollbackRecordRow): RollbackRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      rollbackType: row.rollbackType,
      fromProductDesignStateVersion: row.fromProductDesignStateVersion,
      toProductDesignStateVersion: row.toProductDesignStateVersion,
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
      throw new ForbiddenException("ROLLBACK_FORBIDDEN");
    }
    return project;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接回滚用户项目");
    }
  }
}
