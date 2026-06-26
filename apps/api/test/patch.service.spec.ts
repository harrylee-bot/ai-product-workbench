import { PatchRecordStatus, ProjectStatus, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchPlan } from "../src/ai/ai-vibe.types";
import { PatchService } from "../src/ai/patch.service";

describe("PatchService", () => {
  const now = new Date("2026-06-20T08:00:00Z");
  const prisma = {
    project: {
      findUnique: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
    },
    patchRecord: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    patchPreview: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const service = new PatchService(prisma as never);
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findUnique.mockResolvedValue(baseProject());
    prisma.conversation.findFirst.mockResolvedValue({ id: "conversation-1", projectId: "project-1" });
    prisma.patchRecord.findMany.mockResolvedValue([patchRecordRow({ id: "patch-1" })]);
    prisma.patchRecord.count.mockResolvedValue(1);
    prisma.patchRecord.update.mockImplementation(async ({ data }) =>
      patchRecordRow({ id: "patch-1", ...data }),
    );
    prisma.patchPreview.findUnique.mockResolvedValue(null);
    prisma.patchPreview.create.mockImplementation(async ({ data }) =>
      patchPreviewRow({ id: "preview-1", ...data }),
    );
    prisma.$transaction.mockImplementation(async (items) => Promise.all(items));
  });

  it("rejects new Patch planning until DeerFlow owns the patch graph", async () => {
    await expect(
      service.createPatchForUser(user, "project-1", {
        conversationId: "conversation-1",
        selectedRegion: {
          type: "prototype",
          targetId: "artifact-1",
          componentId: "page_home_primary_action",
        },
        userInstruction: "按钮文案改成立即签到。",
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PATCH_RUNTIME_DISABLED_DEERFLOW_FIRST" }),
    });

    expect(prisma.project.findUnique).toHaveBeenCalledWith({ where: { id: "project-1" } });
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: "conversation-1", projectId: "project-1", deletedAt: null },
    });
    expect(prisma.patchRecord.update).not.toHaveBeenCalled();
  });

  it("rejects runtime-created Patch candidates until the DeerFlow integration is rebuilt", async () => {
    await expect(
      service.createPatchCandidateFromRun({
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInstruction: "更新按钮",
        selectedRegion: { type: "prototype", targetId: "artifact-1" },
        attachments: [],
        runId: "run-1",
        traceId: "trace-1",
        instructionMessageId: "message-1",
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PATCH_RUNTIME_DISABLED_DEERFLOW_FIRST" }),
    });
  });

  it("lists historical Patch records without invoking generation", async () => {
    const result = await service.listForProject(user, "project-1", { page: 1, pageSize: 20 });

    expect(result).toEqual(expect.objectContaining({
      total: 1,
      page: 1,
      pageSize: 20,
    }));
    expect(result.items[0]).toEqual(expect.objectContaining({
      id: "patch-1",
      status: PatchRecordStatus.needs_confirmation,
    }));
    expect(prisma.patchRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: "project-1" },
      orderBy: { createdAt: "desc" },
    }));
  });

  it("builds previews from historical Patch records", async () => {
    prisma.patchRecord.findUnique.mockResolvedValue({
      ...patchRecordRow({
        id: "patch-preview-1",
        status: PatchRecordStatus.needs_confirmation,
      }),
      project: baseProject(),
    });

    const result = await service.previewForUser(user, "patch-preview-1");

    expect(result.patchPreview).toEqual(expect.objectContaining({
      patchId: "patch-preview-1",
      status: PatchRecordStatus.needs_confirmation,
      previewOnly: true,
      requiresConfirmation: true,
      operations: basePatchPlan().operations,
      message: "补丁预览来自历史记录。新的 Patch 规划将由 DeerFlow 2.0 接管。",
    }));
    expect(prisma.patchPreview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        patchRecordId: "patch-preview-1",
        riskPanel: expect.objectContaining({
          requiresConfirmation: true,
          versionedApply: true,
        }),
      }),
    });
  });

  it("can cancel historical planned Patch records", async () => {
    prisma.patchRecord.findUnique.mockResolvedValue({
      ...patchRecordRow({
        id: "patch-1",
        status: PatchRecordStatus.needs_confirmation,
      }),
      project: baseProject(),
    });

    const result = await service.cancelForUser(user, "patch-1");

    expect(result.patchRecord.status).toBe(PatchRecordStatus.cancelled);
    expect(prisma.patchRecord.update).toHaveBeenCalledWith({
      where: { id: "patch-1" },
      data: { status: PatchRecordStatus.cancelled },
    });
  });

  it("rejects applying historical Patch records until DeerFlow owns apply/regeneration", async () => {
    prisma.patchRecord.findUnique.mockResolvedValue({
      ...patchRecordRow({
        id: "patch-1",
        status: PatchRecordStatus.needs_confirmation,
      }),
      project: baseProject(),
    });

    await expect(service.confirmForUser(user, "patch-1", "确认应用"))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: "PATCH_APPLY_DISABLED_DEERFLOW_FIRST" }),
      });

    expect(prisma.patchRecord.update).not.toHaveBeenCalled();
  });
});

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    ownerId: "user-1",
    status: ProjectStatus.draft,
    deletedAt: null,
    ...overrides,
  };
}

function basePatchPlan(): PatchPlan {
  return {
    id: "patch-plan-1",
    projectId: "project-1",
    intent: "copy_change",
    selectedRegion: {
      type: "prototype",
      targetId: "artifact-1",
      pageId: "page_home",
      componentId: "page_home_primary_action",
      label: "签到按钮",
      sourcePaths: ["frontendRules"],
    },
    patchType: "prototype",
    targetNodes: ["page_home_primary_action"],
    impactScope: ["frontendRules", "prdDocument", "prototypeSpec"],
    operations: [
      {
        op: "add",
        path: "frontendRules",
        value: { id: "patch_button_copy", title: "按钮文案", description: "按钮文案改为立即签到" },
        reason: "用户要求修改按钮文案。",
      },
    ],
    impactAnalysis: {
      affectedStatePaths: ["frontendRules"],
      affectedPrdSectionIds: ["frontend_rules"],
      affectedPrototypePageIds: ["page_home"],
      affectedPrototypeComponentIds: ["page_home_primary_action"],
      affectedAcceptanceCriteriaIds: [],
      requiresPrdRegeneration: true,
      requiresPrototypeRegeneration: true,
      requiresQaCheck: true,
      reason: "按钮文案影响 PRD 与原型。",
    },
    regenerationPlan: {
      prd: "full",
      prototypeSpec: "full",
      htmlPrototype: "full",
      qa: "basic",
    },
    risks: [],
    needUserConfirm: true,
    needsUserConfirmation: true,
    reason: "局部修改按钮文案。",
    summary: "更新按钮文案。",
  };
}

function patchRecordRow(input: Record<string, unknown>) {
  return {
    id: String(input.id ?? "patch-1"),
    projectId: String(input.projectId ?? "project-1"),
    conversationId: String(input.conversationId ?? "conversation-1"),
    instructionMessageId: input.instructionMessageId ? String(input.instructionMessageId) : null,
    selectedRegion: input.selectedRegion ?? basePatchPlan().selectedRegion,
    userInstruction: String(input.userInstruction ?? "按钮文案改成立即签到。"),
    patchPlan: input.patchPlan ?? basePatchPlan(),
    operations: input.operations ?? basePatchPlan().operations,
    status: input.status ?? PatchRecordStatus.needs_confirmation,
    beforeProductDesignStateVersion: Number(input.beforeProductDesignStateVersion ?? 1),
    afterProductDesignStateVersion: input.afterProductDesignStateVersion ? Number(input.afterProductDesignStateVersion) : null,
    affectedPrdDocumentId: input.affectedPrdDocumentId ? String(input.affectedPrdDocumentId) : null,
    affectedPrototypeArtifactId: input.affectedPrototypeArtifactId ? String(input.affectedPrototypeArtifactId) : null,
    relatedQaReportId: input.relatedQaReportId ? String(input.relatedQaReportId) : null,
    generatedByRunId: input.generatedByRunId ? String(input.generatedByRunId) : null,
    errorMessage: input.errorMessage ? String(input.errorMessage) : null,
    createdBy: String(input.createdBy ?? "user-1"),
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-20T08:00:00Z"),
    updatedAt: input.updatedAt instanceof Date ? input.updatedAt : new Date("2026-06-20T08:00:00Z"),
  };
}

function patchPreviewRow(input: Record<string, unknown>) {
  return {
    id: String(input.id ?? "preview-1"),
    projectId: String(input.projectId ?? "project-1"),
    patchRecordId: String(input.patchRecordId ?? "patch-1"),
    status: String(input.status ?? "ready"),
    beforeProductDesignStateVersion: Number(input.beforeProductDesignStateVersion ?? 1),
    afterProductDesignStateVersion: input.afterProductDesignStateVersion ? Number(input.afterProductDesignStateVersion) : null,
    beforeSnapshot: input.beforeSnapshot ?? { productDesignStateVersion: 1 },
    afterSnapshot: input.afterSnapshot ?? { productDesignStateVersion: null },
    diff: input.diff ?? {},
    riskPanel: input.riskPanel ?? {},
    patchPlan: input.patchPlan ?? basePatchPlan(),
    operations: input.operations ?? basePatchPlan().operations,
    message: input.message ? String(input.message) : null,
    createdBy: String(input.createdBy ?? "user-1"),
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-20T08:00:00Z"),
    updatedAt: input.updatedAt instanceof Date ? input.updatedAt : new Date("2026-06-20T08:00:00Z"),
  };
}
