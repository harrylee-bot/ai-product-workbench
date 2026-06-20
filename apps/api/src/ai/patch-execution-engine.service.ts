import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { PatchService } from "./patch.service";
import { RollbackService } from "./rollback.service";
import {
  arrayOfText,
  assertOwnerMutation,
  assertProjectAccess,
  assertStateOnlyPatchOperations,
  json,
} from "./product-evolution.helpers";
import type {
  EvolutionPatchExecutionItem,
  EvolutionPatchOperation,
  EvolutionPlanItem,
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

@Injectable()
export class PatchExecutionEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly patchService: PatchService,
    private readonly rollbackService: RollbackService,
  ) {}

  async applyForUser(
    user: AuthenticatedUser,
    input: { projectId: string; evolutionPlanId: string; conversationId?: string },
  ) {
    const project = await assertProjectAccess(this.prisma, user, input.projectId);
    assertOwnerMutation(user, project.ownerId, "管理员不可直接执行用户项目进化 Patch");
    const plan = await this.prisma.evolutionPlan.findFirst({
      where: { id: input.evolutionPlanId, projectId: input.projectId },
    });
    if (!plan) throw new NotFoundException("EVOLUTION_PLAN_NOT_FOUND");
    const evolutionPlan = this.toEvolutionPlanItem(plan as EvolutionPlanRow);
    assertStateOnlyPatchOperations(evolutionPlan.patchOperations);

    try {
      const result = await this.patchService.applyEvolutionPlanForUser(user, input.projectId, {
        evolutionPlanId: input.evolutionPlanId,
        conversationId: input.conversationId,
        reason: evolutionPlan.reason,
        operations: evolutionPlan.patchOperations,
        impactedAreas: evolutionPlan.impactedAreas,
      });
      const patchRecord = result.patchRecord;
      const execution = await this.prisma.evolutionPatchExecution.create({
        data: {
          projectId: input.projectId,
          evolutionPlanId: input.evolutionPlanId,
          patchRecordId: patchRecord.id,
          result: "success",
          appliedOperations: json(evolutionPlan.patchOperations)!,
          newStateVersion: patchRecord.afterProductDesignStateVersion,
          rollbackId: patchRecord.id,
          createdBy: user.id,
        },
      });
      await this.prisma.evolutionPlan.update({
        where: { id: input.evolutionPlanId },
        data: { executedAt: new Date() },
      });

      return {
        success: true,
        patchResult: {
          success: true,
          appliedOperations: evolutionPlan.patchOperations,
          newStateVersion: patchRecord.afterProductDesignStateVersion ?? 0,
          rollbackId: patchRecord.id,
        },
        patchExecution: this.toExecutionItem(execution as EvolutionPatchExecutionRow),
        patchRecord,
        productDesignState: result.result.productDesignState,
        prdDocument: result.result.prdDocument,
        prototypeArtifact: result.result.prototypeArtifact,
        qaReport: result.result.qaReport,
        runId: result.runId,
      };
    } catch (error) {
      const execution = await this.prisma.evolutionPatchExecution.create({
        data: {
          projectId: input.projectId,
          evolutionPlanId: input.evolutionPlanId,
          result: "failed",
          appliedOperations: json([])!,
          errorMessage: error instanceof Error ? error.message : "PATCH_EXECUTION_FAILED",
          createdBy: user.id,
        },
      });
      return {
        success: false,
        patchResult: {
          success: false,
          appliedOperations: [],
          newStateVersion: 0,
          rollbackId: execution.id,
        },
        patchExecution: this.toExecutionItem(execution as EvolutionPatchExecutionRow),
        errorMessage: error instanceof Error ? error.message : "PATCH_EXECUTION_FAILED",
      };
    }
  }

  async listForProject(user: AuthenticatedUser, projectId: string) {
    await assertProjectAccess(this.prisma, user, projectId, { allowArchived: true });
    const executions = await this.prisma.evolutionPatchExecution.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      items: executions.map((item) => this.toExecutionItem(item as EvolutionPatchExecutionRow)),
      total: executions.length,
    };
  }

  async rollbackForUser(user: AuthenticatedUser, input: { projectId: string; targetVersion: number; reason?: string }) {
    return this.rollbackService.rollbackProductDesignStateForUser(user, input.projectId, {
      targetVersion: input.targetVersion,
      reason: input.reason ?? `Patch Execution Engine 回滚到 ProductDesignState v${input.targetVersion}`,
    });
  }

  toExecutionItem(row: EvolutionPatchExecutionRow): EvolutionPatchExecutionItem {
    return {
      id: row.id,
      projectId: row.projectId,
      evolutionPlanId: row.evolutionPlanId,
      patchRecordId: row.patchRecordId ?? undefined,
      result: row.result === "success" ? "success" : "failed",
      appliedOperations: normalizeEvolutionPatchOperations(row.appliedOperations),
      newStateVersion: row.newStateVersion ?? undefined,
      rollbackId: row.rollbackId ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toEvolutionPlanItem(row: EvolutionPlanRow): EvolutionPlanItem {
    return {
      id: row.id,
      projectId: row.projectId,
      reason: row.reason,
      priority: row.priority === "high" || row.priority === "low" ? row.priority : "medium",
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
