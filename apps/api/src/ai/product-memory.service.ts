import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import {
  arrayOfText,
  assertProjectAccess,
  json,
  normalizeIssueType,
  normalizePriority,
  normalizeSeverity,
} from "./product-evolution.helpers";
import type {
  EvolutionPatchOperation,
  EvolutionPlanItem,
  ProductInsightItem,
  ProductMemoryCategory,
  ProductMemoryItem,
  ProductMemoryTimelineItem,
  ProductReviewReportItem,
} from "./product-evolution.types";

type EvolutionPlanRow = {
  id: string;
  projectId: string;
  reason: string;
  priority: string;
  patchOperations: unknown;
  prdChanges: unknown;
  prototypeChanges: unknown;
  impactedAreas: unknown;
  sourceInsightIds: unknown;
  sourceReviewId: string | null;
  generatedBy: string;
  executedAt: Date | null;
  createdAt: Date;
};

type EvolutionPatchExecutionRow = {
  id: string;
  projectId: string;
  evolutionPlanId: string;
  patchRecordId: string | null;
  result: string;
  appliedOperations: unknown;
  newStateVersion: number | null;
  rollbackId: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
};

type PatchRecordRow = {
  id: string;
  projectId: string;
  beforeProductDesignStateVersion: number;
  afterProductDesignStateVersion: number | null;
  patchPlan: unknown;
  operations: unknown;
  status: string;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
};

type ProductInsightRow = {
  id: string;
  projectId: string;
  issueType: string;
  severity: string;
  affectedArea: unknown;
  rootCause: string;
  suggestion: string;
  sourceEvents: unknown;
  generatedBy: string;
  createdAt: Date;
};

type ProductReviewReportRow = {
  id: string;
  projectId: string;
  issues: unknown;
  conflicts: unknown;
  improvements: unknown;
  consensusScore: number;
  agentOutputs: unknown;
  generatedBy: string;
  createdAt: Date;
};

type ProductMemoryRow = {
  id: string;
  projectId: string;
  version: number;
  category: string | null;
  changeReason: string;
  evolutionPlan: unknown;
  patchResult: unknown;
  beforeState: unknown;
  afterState: unknown;
  insights: unknown;
  agentReport: unknown;
  evolutionPlanId: string | null;
  patchExecutionId: string | null;
  patchRecordId: string | null;
  createdBy: string;
  createdAt: Date;
};

type ProductDesignVersionRow = {
  version: number;
  snapshot: unknown;
};

@Injectable()
export class ProductMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  async saveForUser(
    user: AuthenticatedUser,
    input: { projectId: string; evolutionPlanId?: string; patchExecutionId?: string; patchRecordId?: string },
  ) {
    await assertProjectAccess(this.prisma, user, input.projectId, { allowArchived: true });
    if (!input.evolutionPlanId && !input.patchExecutionId && !input.patchRecordId) {
      throw new BadRequestException("PRODUCT_MEMORY_SOURCE_REQUIRED");
    }
    const memory = await this.saveFromSources({
      projectId: input.projectId,
      evolutionPlanId: input.evolutionPlanId,
      patchExecutionId: input.patchExecutionId,
      patchRecordId: input.patchRecordId,
      createdBy: user.id,
    });
    return { memory };
  }

  async recordPatchExecutionMemory(input: {
    projectId: string;
    evolutionPlanId: string;
    patchExecutionId: string;
    patchRecordId?: string;
    patchResult: unknown;
    createdBy: string;
    afterStateFallback?: unknown;
  }) {
    return this.saveFromSources(input);
  }

  async listForProject(user: AuthenticatedUser, projectId: string) {
    await assertProjectAccess(this.prisma, user, projectId, { allowArchived: true });
    const memories = await this.prisma.productMemory.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: memories.map((memory) => this.toItem(memory as ProductMemoryRow)),
      total: memories.length,
    };
  }

  async timelineForProject(user: AuthenticatedUser, projectId: string) {
    await assertProjectAccess(this.prisma, user, projectId, { allowArchived: true });
    const memories = await this.prisma.productMemory.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: memories.map((memory) => this.toTimelineItem(memory as ProductMemoryRow)),
      total: memories.length,
    };
  }

  private async saveFromSources(input: {
    projectId: string;
    evolutionPlanId?: string;
    patchExecutionId?: string;
    patchRecordId?: string;
    patchResult?: unknown;
    createdBy: string;
    afterStateFallback?: unknown;
  }): Promise<ProductMemoryItem> {
    const execution = await this.loadPatchExecution(input);
    const evolutionPlanId = input.evolutionPlanId ?? execution?.evolutionPlanId;
    if (!evolutionPlanId) throw new BadRequestException("PRODUCT_MEMORY_EVOLUTION_PLAN_REQUIRED");
    const plan = await this.prisma.evolutionPlan.findFirst({
      where: { id: evolutionPlanId, projectId: input.projectId },
    });
    if (!plan) throw new NotFoundException("EVOLUTION_PLAN_NOT_FOUND");

    const patchRecordId = input.patchRecordId ?? execution?.patchRecordId ?? undefined;
    const patchRecord = patchRecordId
      ? await this.prisma.patchRecord.findFirst({
          where: { id: patchRecordId, projectId: input.projectId },
        })
      : null;
    if (patchRecordId && !patchRecord) throw new NotFoundException("PATCH_RECORD_NOT_FOUND");

    const planItem = this.toEvolutionPlanItem(plan as EvolutionPlanRow);
    const insights = await this.loadInsights(input.projectId, planItem.sourceInsightIds);
    const review = await this.loadReview(input.projectId, planItem.sourceReviewId);
    const patchResult = input.patchResult ?? this.patchResultFromRows(execution, patchRecord);
    const versions = this.resolveVersions(execution, patchRecord);
    const latestState = versions.before || versions.after
      ? null
      : await this.loadLatestStateSnapshot(input.projectId);
    const beforeState = await this.loadStateSnapshot(input.projectId, versions.before) ?? latestState?.snapshot;
    const afterState =
      await this.loadStateSnapshot(input.projectId, versions.after)
      ?? input.afterStateFallback
      ?? beforeState
      ?? latestState?.snapshot;
    if (!beforeState || !afterState) {
      throw new BadRequestException("PRODUCT_MEMORY_STATE_SNAPSHOT_REQUIRED");
    }
    const memoryVersion = versions.after ?? versions.before ?? latestState?.version;
    if (!memoryVersion) throw new BadRequestException("PRODUCT_MEMORY_STATE_VERSION_REQUIRED");

    const created = await this.prisma.productMemory.create({
      data: {
        projectId: input.projectId,
        version: memoryVersion,
        category: inferCategory(insights, planItem),
        changeReason: planItem.reason,
        evolutionPlan: json(planItem)!,
        patchResult: json(patchResult)!,
        beforeState: toInputJson(beforeState),
        afterState: toInputJson(afterState),
        insights: json(insights)!,
        agentReport: json(review ?? {})!,
        evolutionPlanId: planItem.id,
        patchExecutionId: execution?.id,
        patchRecordId: patchRecord?.id ?? patchRecordId,
        createdBy: input.createdBy,
      },
    });

    return this.toItem(created as ProductMemoryRow);
  }

  private async loadPatchExecution(input: {
    projectId: string;
    evolutionPlanId?: string;
    patchExecutionId?: string;
    patchRecordId?: string;
  }) {
    if (input.patchExecutionId) {
      const execution = await this.prisma.evolutionPatchExecution.findFirst({
        where: { id: input.patchExecutionId, projectId: input.projectId },
      });
      if (!execution) throw new NotFoundException("PATCH_EXECUTION_NOT_FOUND");
      return execution as EvolutionPatchExecutionRow;
    }
    if (input.patchRecordId) {
      return await this.prisma.evolutionPatchExecution.findFirst({
        where: { patchRecordId: input.patchRecordId, projectId: input.projectId },
        orderBy: { createdAt: "desc" },
      }) as EvolutionPatchExecutionRow | null;
    }
    if (input.evolutionPlanId) {
      return await this.prisma.evolutionPatchExecution.findFirst({
        where: { evolutionPlanId: input.evolutionPlanId, projectId: input.projectId },
        orderBy: { createdAt: "desc" },
      }) as EvolutionPatchExecutionRow | null;
    }
    return null;
  }

  private async loadInsights(projectId: string, insightIds: string[]) {
    if (!insightIds.length) return [];
    const rows = await this.prisma.productInsight.findMany({
      where: { projectId, id: { in: insightIds } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => this.toInsightItem(row as ProductInsightRow));
  }

  private async loadReview(projectId: string, reviewId?: string): Promise<ProductReviewReportItem | null> {
    if (!reviewId) return null;
    const row = await this.prisma.productReviewReport.findFirst({
      where: { id: reviewId, projectId },
    });
    if (!row) return null;
    const review = row as ProductReviewReportRow;
    return {
      id: review.id,
      projectId: review.projectId,
      issues: Array.isArray(review.issues) ? review.issues as ProductReviewReportItem["issues"] : [],
      conflicts: arrayOfText(review.conflicts),
      improvements: arrayOfText(review.improvements),
      consensusScore: review.consensusScore,
      agentOutputs: review.agentOutputs as ProductReviewReportItem["agentOutputs"],
      generatedBy: review.generatedBy,
      createdAt: review.createdAt.toISOString(),
    };
  }

  private async loadStateSnapshot(projectId: string, version?: number | null) {
    if (!version) return null;
    const row = await this.prisma.productDesignVersion.findFirst({
      where: { projectId, version },
      orderBy: { createdAt: "desc" },
    });
    return row ? (row as ProductDesignVersionRow).snapshot : null;
  }

  private async loadLatestStateSnapshot(projectId: string) {
    const row = await this.prisma.productDesignVersion.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    if (!row) return null;
    const version = row as ProductDesignVersionRow;
    return {
      version: version.version,
      snapshot: version.snapshot,
    };
  }

  private resolveVersions(execution: EvolutionPatchExecutionRow | null, patchRecord: unknown) {
    const patch = patchRecord as PatchRecordRow | null;
    const before = patch?.beforeProductDesignStateVersion ?? execution?.newStateVersion ?? undefined;
    const after = patch?.afterProductDesignStateVersion ?? execution?.newStateVersion ?? before;
    return { before, after };
  }

  private patchResultFromRows(execution: EvolutionPatchExecutionRow | null, patchRecord: unknown) {
    const patch = patchRecord as PatchRecordRow | null;
    return {
      success: execution?.result === "success" || patch?.status === "applied",
      appliedOperations: normalizeEvolutionPatchOperations(execution?.appliedOperations ?? patch?.operations),
      newStateVersion: execution?.newStateVersion ?? patch?.afterProductDesignStateVersion ?? undefined,
      rollbackId: execution?.rollbackId ?? patch?.id ?? undefined,
      errorMessage: execution?.errorMessage ?? patch?.errorMessage ?? undefined,
      patchRecordStatus: patch?.status,
    };
  }

  private toEvolutionPlanItem(row: EvolutionPlanRow): EvolutionPlanItem {
    return {
      id: row.id,
      projectId: row.projectId,
      reason: row.reason,
      priority: normalizePriority(row.priority),
      patchOperations: normalizeEvolutionPatchOperations(row.patchOperations),
      prdChanges: Array.isArray(row.prdChanges) ? row.prdChanges : [],
      prototypeChanges: Array.isArray(row.prototypeChanges) ? row.prototypeChanges : [],
      impactedAreas: arrayOfText(row.impactedAreas),
      sourceInsightIds: arrayOfText(row.sourceInsightIds),
      sourceReviewId: row.sourceReviewId ?? undefined,
      generatedBy: row.generatedBy,
      executedAt: row.executedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toInsightItem(row: ProductInsightRow): ProductInsightItem {
    return {
      id: row.id,
      projectId: row.projectId,
      issueType: normalizeIssueType(row.issueType),
      severity: normalizeSeverity(row.severity),
      affectedArea: arrayOfText(row.affectedArea),
      rootCause: row.rootCause,
      suggestion: row.suggestion,
      sourceEvents: arrayOfText(row.sourceEvents),
      generatedBy: row.generatedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  toItem(row: ProductMemoryRow): ProductMemoryItem {
    const category = normalizeMemoryCategory(row.category);
    return {
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      category,
      changeReason: row.changeReason,
      evolutionPlan: row.evolutionPlan,
      patchResult: row.patchResult,
      beforeState: row.beforeState,
      afterState: row.afterState,
      insights: row.insights,
      agentReport: row.agentReport,
      evolutionPlanId: row.evolutionPlanId ?? undefined,
      patchExecutionId: row.patchExecutionId ?? undefined,
      patchRecordId: row.patchRecordId ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toTimelineItem(row: ProductMemoryRow): ProductMemoryTimelineItem {
    const category = normalizeMemoryCategory(row.category);
    return {
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      category,
      title: `ProductDesignState v${row.version}`,
      description: row.changeReason,
      evolutionPlanId: row.evolutionPlanId ?? undefined,
      patchExecutionId: row.patchExecutionId ?? undefined,
      patchRecordId: row.patchRecordId ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function normalizeEvolutionPatchOperations(value: unknown): EvolutionPatchOperation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): EvolutionPatchOperation[] => {
    const record = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
    if (!record) return [];
    const targetPath = typeof record.targetPath === "string"
      ? record.targetPath
      : typeof record.path === "string"
        ? record.path
        : "";
    if (!targetPath) return [];
    return [{
      type: record.type === "delete" ? "delete" : record.type === "update" ? "update" : "add",
      targetPath,
      value: record.value,
      reason: typeof record.reason === "string" ? record.reason : undefined,
    }];
  });
}

function inferCategory(insights: ProductInsightItem[], plan: EvolutionPlanItem): ProductMemoryCategory {
  if (insights.some((insight) => insight.issueType === "logic" || insight.severity === "high")) return "risk";
  if (insights.some((insight) => insight.issueType === "flow")) return "flow";
  if (insights.some((insight) => insight.issueType === "ux" || insight.issueType === "content")) return "ux";
  if (plan.impactedAreas.some((area) => /business|goal|rule|conversion|growth|商业|转化|目标/.test(area))) {
    return "business";
  }
  return "business";
}

function normalizeMemoryCategory(value: string | null): ProductMemoryCategory | undefined {
  if (value === "ux" || value === "flow" || value === "business" || value === "risk") return value;
  return undefined;
}
