import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  PatchRecordStatus as PrismaPatchRecordStatus,
  ProjectStatus,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type { PatchPlan, PatchRecord, SelectedRegion } from "./ai-vibe.types";

type CreatePatchInput = {
  conversationId: string;
  selectedRegion: Record<string, unknown>;
  userInstruction: string;
  attachmentFileIds?: string[];
};

type CreatePatchCandidateInput = CreatePatchInput & {
  source?: "prd_edit" | "prd_rewrite" | "prd_diff" | "prototype_edit" | "prototype_restructure" | "prototype_flow_update" | "inline_edit";
  interactionEvent?: Record<string, unknown>;
};

type CreatePatchCandidateFromRunInput = {
  projectId: string;
  conversationId: string;
  userId: string;
  userInstruction: string;
  selectedRegion: SelectedRegion | Record<string, unknown>;
  attachments: unknown[];
  runId: string;
  traceId: string;
  instructionMessageId: string;
};

type PatchRecordRow = {
  id: string;
  projectId: string;
  conversationId: string;
  instructionMessageId: string | null;
  selectedRegion: unknown;
  userInstruction: string;
  patchPlan: unknown;
  operations: unknown;
  status: PrismaPatchRecordStatus;
  beforeProductDesignStateVersion: number;
  afterProductDesignStateVersion: number | null;
  affectedPrdDocumentId: string | null;
  affectedPrototypeArtifactId: string | null;
  relatedQaReportId: string | null;
  generatedByRunId: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type PatchPreviewRow = {
  id: string;
  projectId: string;
  patchRecordId: string;
  status: string;
  beforeProductDesignStateVersion: number;
  afterProductDesignStateVersion: number | null;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  diff: unknown;
  riskPanel: unknown;
  patchPlan: unknown;
  operations: unknown;
  message: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class PatchService {
  constructor(private readonly prisma: PrismaService) {}

  async createPatchForUser(user: AuthenticatedUser, projectId: string, input: CreatePatchInput) {
    await this.assertPatchMutationAllowed(user, projectId, input.conversationId, input.userInstruction);
    throw deerFlowFirstDisabled("PATCH_RUNTIME_DISABLED_DEERFLOW_FIRST");
  }

  async createPatchCandidateForUser(
    user: AuthenticatedUser,
    projectId: string,
    input: CreatePatchCandidateInput,
  ) {
    await this.assertPatchMutationAllowed(user, projectId, input.conversationId, input.userInstruction);
    throw deerFlowFirstDisabled("PATCH_RUNTIME_DISABLED_DEERFLOW_FIRST");
  }

  async createPatchCandidateFromRun(_input: CreatePatchCandidateFromRunInput) {
    throw deerFlowFirstDisabled("PATCH_RUNTIME_DISABLED_DEERFLOW_FIRST");
  }

  async listForProject(
    user: AuthenticatedUser,
    projectId: string,
    query: { status?: PrismaPatchRecordStatus; page?: number; pageSize?: number },
  ) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const where = {
      projectId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.patchRecord.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.patchRecord.count({ where }),
    ]);
    return {
      items: items.map((item) => this.toPatchRecord(item as PatchRecordRow)),
      total,
      page,
      pageSize,
    };
  }

  async getPatchForUser(user: AuthenticatedUser, patchId: string) {
    const row = await this.getAccessiblePatch(user, patchId);
    return { patchRecord: this.toPatchRecord(row as PatchRecordRow) };
  }

  async previewForUser(user: AuthenticatedUser, patchId: string) {
    const row = await this.getAccessiblePatch(user, patchId);
    const patchRecord = this.toPatchRecord(row as PatchRecordRow);
    const preview = await this.ensurePatchPreview(row as PatchRecordRow, patchRecord.patchPlan);
    return {
      patchPreview: this.toPatchPreview(preview as PatchPreviewRow, patchRecord),
    };
  }

  async cancelForUser(user: AuthenticatedUser, patchId: string) {
    const row = await this.getAccessiblePatch(user, patchId);
    this.assertOwnerMutation(user, row.project.ownerId);
    if (row.status !== PrismaPatchRecordStatus.planned && row.status !== PrismaPatchRecordStatus.needs_confirmation) {
      throw new BadRequestException("PATCH_CANNOT_CANCEL");
    }
    const updated = await this.prisma.patchRecord.update({
      where: { id: patchId },
      data: { status: PrismaPatchRecordStatus.cancelled },
    });
    return { patchRecord: this.toPatchRecord(updated as PatchRecordRow) };
  }

  async confirmForUser(user: AuthenticatedUser, patchId: string, _confirmation: string) {
    const row = await this.getAccessiblePatch(user, patchId);
    this.assertOwnerMutation(user, row.project.ownerId);
    if (row.status !== PrismaPatchRecordStatus.needs_confirmation) {
      throw new BadRequestException("PATCH_CONFIRMATION_NOT_REQUIRED");
    }
    throw deerFlowFirstDisabled("PATCH_APPLY_DISABLED_DEERFLOW_FIRST");
  }

  private async assertPatchMutationAllowed(
    user: AuthenticatedUser,
    projectId: string,
    conversationId: string,
    instruction: string,
  ) {
    const project = await this.assertProjectAccess(user, projectId);
    this.assertOwnerMutation(user, project.ownerId);
    await this.assertConversation(projectId, conversationId);
    if (!instruction.trim()) throw new BadRequestException("PATCH_INSTRUCTION_EMPTY");
  }

  private async ensurePatchPreview(row: PatchRecordRow, plan: PatchPlan) {
    const existing = await this.prisma.patchPreview.findUnique({
      where: { patchRecordId: row.id },
    });
    if (existing) return existing;

    const operations = Array.isArray(row.operations)
      ? row.operations as PatchPlan["operations"]
      : plan.operations ?? [];
    return this.prisma.patchPreview.create({
      data: {
        projectId: row.projectId,
        patchRecordId: row.id,
        status: "ready",
        beforeProductDesignStateVersion: row.beforeProductDesignStateVersion,
        afterProductDesignStateVersion: row.afterProductDesignStateVersion,
        beforeSnapshot: toInputJson({
          productDesignStateVersion: row.beforeProductDesignStateVersion,
          immutable: true,
        }),
        afterSnapshot: toInputJson({
          productDesignStateVersion: row.afterProductDesignStateVersion,
          projectedOperations: operations,
          requiresApply: true,
        }),
        diff: toInputJson(buildPatchPreviewDiff(plan, operations)),
        riskPanel: toInputJson(buildPatchPreviewRiskPanel(plan)),
        patchPlan: toInputJson(plan),
        operations: toInputJson(operations),
        message: "补丁预览来自历史记录。新的 Patch 规划将由 DeerFlow 2.0 接管。",
        createdBy: row.createdBy,
      },
    });
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
      throw new ForbiddenException("PATCH_FORBIDDEN");
    }
    return project;
  }

  private async assertConversation(projectId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, projectId, deletedAt: null },
    });
    if (!conversation) throw new NotFoundException("PATCH_CONVERSATION_NOT_FOUND");
    return conversation;
  }

  private async getAccessiblePatch(user: AuthenticatedUser, patchId: string) {
    const patch = await this.prisma.patchRecord.findUnique({
      where: { id: patchId },
      include: { project: true },
    });
    if (!patch || patch.project.deletedAt || patch.project.status === ProjectStatus.deleted) {
      throw new NotFoundException("PATCH_RECORD_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && patch.project.ownerId !== user.id) {
      throw new ForbiddenException("PATCH_FORBIDDEN");
    }
    return patch;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户项目 Patch");
    }
  }

  private toPatchRecord(row: PatchRecordRow): PatchRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      conversationId: row.conversationId,
      instructionMessageId: row.instructionMessageId ?? undefined,
      selectedRegion: row.selectedRegion as SelectedRegion,
      userInstruction: row.userInstruction,
      patchPlan: row.patchPlan as PatchPlan,
      operations: Array.isArray(row.operations) ? row.operations as PatchPlan["operations"] : [],
      status: row.status,
      beforeProductDesignStateVersion: row.beforeProductDesignStateVersion,
      afterProductDesignStateVersion: row.afterProductDesignStateVersion ?? undefined,
      affectedPrdDocumentId: row.affectedPrdDocumentId ?? undefined,
      affectedPrototypeArtifactId: row.affectedPrototypeArtifactId ?? undefined,
      generatedByRunId: row.generatedByRunId ?? undefined,
      relatedQaReportId: row.relatedQaReportId ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toPatchPreview(row: PatchPreviewRow, patchRecord: PatchRecord) {
    const plan = row.patchPlan as PatchPlan;
    const operations = Array.isArray(row.operations)
      ? row.operations as PatchPlan["operations"]
      : patchRecord.operations;
    return {
      id: row.id,
      patchId: row.patchRecordId,
      status: patchRecord.status,
      previewStatus: row.status,
      selectedRegion: patchRecord.selectedRegion,
      patchPlan: plan,
      operations,
      targetNodes: plan.targetNodes ?? [],
      impactScope: plan.impactScope ?? [],
      risks: plan.risks ?? [],
      regenerationPlan: plan.regenerationPlan,
      diff: row.diff,
      before: row.beforeSnapshot,
      after: row.afterSnapshot,
      riskPanel: row.riskPanel,
      beforeProductDesignStateVersion: row.beforeProductDesignStateVersion,
      afterProductDesignStateVersion: row.afterProductDesignStateVersion ?? undefined,
      previewOnly: patchRecord.status === PrismaPatchRecordStatus.needs_confirmation,
      requiresConfirmation: patchRecord.status === PrismaPatchRecordStatus.needs_confirmation,
      message: row.message ?? "补丁预览来自历史记录。新的 Patch 规划将由 DeerFlow 2.0 接管。",
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function buildPatchPreviewDiff(plan: PatchPlan, operations: PatchPlan["operations"]) {
  return {
    mode: "product_design_state",
    summary: plan.summary,
    reason: plan.reason,
    operations: operations.map((operation) => ({
      op: operation.op,
      path: operation.path,
      before: null,
      after: operation.value ?? null,
      reason: operation.reason,
    })),
    impacted: {
      targetNodes: plan.targetNodes ?? [],
      impactScope: plan.impactScope ?? [],
      affectedStatePaths: plan.impactAnalysis?.affectedStatePaths ?? operations.map((operation) => operation.path),
      affectedPrdSectionIds: plan.impactAnalysis?.affectedPrdSectionIds ?? [],
      affectedPrototypePageIds: plan.impactAnalysis?.affectedPrototypePageIds ?? [],
      affectedPrototypeComponentIds: plan.impactAnalysis?.affectedPrototypeComponentIds ?? [],
    },
  };
}

function buildPatchPreviewRiskPanel(plan: PatchPlan) {
  const risks = plan.risks ?? [];
  const regenerationPlan = plan.regenerationPlan;
  const touchesPrototype = regenerationPlan?.prototypeSpec !== "none" || regenerationPlan?.htmlPrototype !== "none";
  const touchesPrd = regenerationPlan?.prd !== "none";
  const level = risks.some((risk) => risk.level === "high")
    ? "high"
    : risks.some((risk) => risk.level === "medium")
      ? "medium"
      : touchesPrototype && touchesPrd
        ? "medium"
        : "low";
  return {
    level,
    requiresConfirmation: true,
    versionedApply: true,
    items: risks,
    checks: {
      stateOnlyOperations: true,
      requiresPrdRegeneration: touchesPrd,
      requiresPrototypeRegeneration: touchesPrototype,
      requiresQaCheck: regenerationPlan?.qa !== "none",
    },
  };
}

function deerFlowFirstDisabled(message: string) {
  return new BadRequestException({
    code: message,
    message: "旧的后端自研 Patch 生成/应用链路已停用，等待 DeerFlow 2.0 接管。",
  });
}
