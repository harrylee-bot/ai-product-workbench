import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConversationStatus, PatchRecordStatus, Prisma, ProjectStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { Phase1User } from "../../modules/auth/auth.types";
import type { PatchOperation } from "../decision-engine/decision.types";
import type { PatchDraft } from "./patch-builder.service";
import { ConstraintService } from "../../constraint/constraint.service";

export type PreviewSession = {
  id: string;
  patchRecordId: string;
  patchDraftId: string;
  strategyId: string;
  status: string;
  before: unknown;
  after: unknown;
  diff: unknown;
  riskPanel: {
    level?: string;
    requiresConfirmation?: boolean;
    versionedApply?: boolean;
    checks?: Record<string, boolean>;
  };
  operations: PatchOperation[];
  targetDomains: PatchDraft["targetDomains"];
  message: string;
  createdAt: string;
};

@Injectable()
export class PatchPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly constraints: ConstraintService,
  ) {}

  async createPreview(input: {
    user: Phase1User;
    projectId: string;
    conversationId: string;
    draft: PatchDraft;
    sourceMessageId?: string;
    userInstruction?: string;
  }): Promise<PreviewSession> {
    if (!input.draft.operations.length) {
      throw new BadRequestException("补丁草稿必须包含操作列表");
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.projectId !== input.projectId || conversation.deletedAt) {
      throw new NotFoundException("会话不存在");
    }
    if (
      conversation.status !== ConversationStatus.active ||
      conversation.project.status === ProjectStatus.deleted ||
      conversation.project.deletedAt
    ) {
      throw new ForbiddenException("当前项目或会话不可用");
    }
    if (input.user.role !== UserRole.admin && conversation.project.ownerId !== input.user.id) {
      throw new ForbiddenException("无权访问该项目");
    }

    const latestState = await this.prisma.productDesignState.findFirst({
      where: { projectId: input.projectId },
      orderBy: { version: "desc" },
    });
    const beforeSnapshot = buildBeforeSnapshot(latestState);
    const afterSnapshot = buildAfterSnapshot(beforeSnapshot, input.draft.operations);
    const diff = buildPreviewDiff(input.draft, beforeSnapshot, afterSnapshot);
    const constraintChecks = input.draft.constraints
      ? this.constraints.validatePatchPlan(input.draft.constraints, input.draft.operations)
      : { constraintsApplied: false };
    const riskPanel = {
      ...buildRiskPanel(input.draft),
      checks: {
        ...buildRiskPanel(input.draft).checks,
        ...constraintChecks,
      },
    };
    const patchPlan = {
      phase: "triple_system_fusion",
      draftId: input.draft.id,
      strategyId: input.draft.strategyId,
      constraints: input.draft.constraints,
      targetDomains: input.draft.targetDomains,
      operations: input.draft.operations,
      requiresPreview: true,
      executable: false,
    };

    const preview = await this.prisma.$transaction(async (tx) => {
      const patchRecord = await tx.patchRecord.create({
        data: {
          projectId: input.projectId,
          conversationId: input.conversationId,
          instructionMessageId: input.sourceMessageId,
          selectedRegion: {
            source: "phase2_decision_system",
            targetDomains: input.draft.targetDomains,
          } as Prisma.InputJsonValue,
          userInstruction: input.userInstruction ?? "第二阶段决策补丁草稿",
          patchPlan: patchPlan as Prisma.InputJsonValue,
          operations: input.draft.operations as Prisma.InputJsonValue,
          status: PatchRecordStatus.needs_confirmation,
          beforeProductDesignStateVersion: latestState?.version ?? 0,
          createdBy: input.user.id,
        },
      });

      return tx.patchPreview.create({
        data: {
          projectId: input.projectId,
          patchRecordId: patchRecord.id,
          status: "ready",
          beforeProductDesignStateVersion: latestState?.version ?? 0,
          beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
          diff: diff as Prisma.InputJsonValue,
          riskPanel: riskPanel as Prisma.InputJsonValue,
          patchPlan: patchPlan as Prisma.InputJsonValue,
          operations: input.draft.operations as Prisma.InputJsonValue,
          message: "补丁预览已生成，等待用户确认后才能执行。",
          createdBy: input.user.id,
        },
      });
    });

    return {
      id: preview.id,
      patchRecordId: preview.patchRecordId,
      patchDraftId: input.draft.id,
      strategyId: input.draft.strategyId,
      status: preview.status,
      before: preview.beforeSnapshot,
      after: preview.afterSnapshot,
      diff: preview.diff,
      riskPanel,
      operations: input.draft.operations,
      targetDomains: input.draft.targetDomains,
      message: preview.message ?? "补丁预览已生成。",
      createdAt: preview.createdAt.toISOString(),
    };
  }
}

function buildBeforeSnapshot(state: { id: string; version: number; title: string; businessGoal: string | null; pages: Prisma.JsonValue; businessRules: Prisma.JsonValue } | null) {
  if (!state) {
    return {
      productDesignStateId: null,
      version: 0,
      title: "",
      businessGoal: "",
      pages: [],
      rules: [],
    };
  }

  return {
    productDesignStateId: state.id,
    version: state.version,
    title: state.title,
    businessGoal: state.businessGoal,
    pages: state.pages,
    rules: state.businessRules,
  };
}

function buildAfterSnapshot(beforeSnapshot: unknown, operations: PatchOperation[]) {
  return {
    ...(isRecord(beforeSnapshot) ? beforeSnapshot : {}),
    previewOnly: true,
    pendingOperations: operations,
    note: "仅用于预览投影。第二阶段预览不会修改产品设计状态。",
  };
}

function buildPreviewDiff(draft: PatchDraft, beforeSnapshot: unknown, afterSnapshot: unknown) {
  return {
    summary: `补丁草稿 ${draft.id} 将影响 ${draft.targetDomains.map(domainLabel).join("、")}。`,
    operations: draft.operations,
    beforeVersion: isRecord(beforeSnapshot) ? beforeSnapshot.version : 0,
    afterPreviewOnly: isRecord(afterSnapshot) ? afterSnapshot.previewOnly === true : true,
  };
}

function domainLabel(domain: "prd" | "prototype" | "state") {
  if (domain === "prd") return "需求文档";
  if (domain === "prototype") return "原型";
  return "产品状态";
}

function buildRiskPanel(draft: PatchDraft) {
  const touchesState = draft.targetDomains.includes("state");
  const touchesPrototype = draft.targetDomains.includes("prototype");
  const level = draft.operations.length >= 3 || touchesState ? "medium" : "low";

  return {
    level,
    requiresConfirmation: true,
    versionedApply: true,
    checks: {
      blocksDirectStateMutation: true,
      requiresPatchPreview: true,
      requiresPrdRegeneration: draft.targetDomains.includes("prd"),
      requiresPrototypeRegeneration: touchesPrototype,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
