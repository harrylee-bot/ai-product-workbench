import { BadRequestException } from "@nestjs/common";
import { ProjectStatus, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvolutionEngineService } from "../src/ai/evolution-engine.service";
import { InteractionCaptureService } from "../src/ai/interaction-capture.service";
import { PatchExecutionEngineService } from "../src/ai/patch-execution-engine.service";
import { ProductMemoryService } from "../src/ai/product-memory.service";

describe("Product evolution modules", () => {
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  const prisma = {
    project: {
      findUnique: vi.fn(),
    },
    productInteractionEvent: {
      create: vi.fn(),
    },
    productInsight: {
      findMany: vi.fn(),
    },
    productReviewReport: {
      findFirst: vi.fn(),
    },
    evolutionPlan: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    evolutionPatchExecution: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    patchRecord: {
      findFirst: vi.fn(),
    },
    productDesignVersion: {
      findFirst: vi.fn(),
    },
    productMemory: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  };
  const modelGateway = {
    generateJson: vi.fn(),
  };
  const stateService = {
    getCurrentState: vi.fn(),
  };
  const patchService = {
    applyEvolutionPlanForUser: vi.fn(),
  };
  const rollbackService = {
    rollbackProductDesignStateForUser: vi.fn(),
  };
  const productMemory = {
    recordPatchExecutionMemory: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findUnique.mockResolvedValue(baseProject());
    productMemory.recordPatchExecutionMemory.mockResolvedValue({
      id: "memory-1",
      projectId: "project-1",
      version: 3,
      category: "flow",
      changeReason: "修复流程阻塞",
      createdAt: "2026-06-21T08:10:00.000Z",
    });
  });

  it("records only explicit interaction feedback and rejects analytics metadata", async () => {
    const service = new InteractionCaptureService(prisma as never);
    prisma.productInteractionEvent.create.mockImplementation(async ({ data }) => ({
      id: "event-1",
      ...data,
      targetId: data.targetId ?? null,
      content: data.content ?? null,
      metadata: data.metadata ?? null,
      createdAt: new Date("2026-06-21T08:00:00Z"),
    }));

    const created = await service.createForUser(user, {
      projectId: "project-1",
      type: "feedback",
      targetType: "prototype",
      content: "这个流程卡住了，不知道下一步点哪里。",
      metadata: { source: "workspace_feedback_panel" },
    });

    expect(created.event).toEqual(
      expect.objectContaining({
        id: "event-1",
        type: "feedback",
        targetType: "prototype",
        createdBy: "user-1",
      }),
    );
    await expect(
      service.createForUser(user, {
        projectId: "project-1",
        type: "feedback",
        targetType: "prototype",
        content: "统计一下转化漏斗",
        metadata: { funnel: "signup" },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("creates an EvolutionPlan with ProductDesignState-only patch operations", async () => {
    const service = new EvolutionEngineService(prisma as never, stateService as never, modelGateway as never);
    stateService.getCurrentState.mockResolvedValue(baseState());
    prisma.productInsight.findMany.mockResolvedValue([
      {
        id: "insight-1",
        projectId: "project-1",
        issueType: "flow",
        severity: "high",
        affectedArea: ["prototype", "page_home"],
        rootCause: "用户反馈流程卡住",
        suggestion: "补充下一步引导",
        sourceEvents: ["event-1"],
        generatedBy: "user-1",
        createdAt: new Date("2026-06-21T08:00:00Z"),
      },
    ]);
    prisma.productReviewReport.findFirst.mockResolvedValue({
      id: "review-1",
      projectId: "project-1",
      issues: [],
      conflicts: [],
      improvements: ["补充下一步引导"],
      consensusScore: 0.82,
      agentOutputs: {},
      generatedBy: "user-1",
      createdAt: new Date("2026-06-21T08:00:00Z"),
    });
    modelGateway.generateJson.mockResolvedValue({
      data: {
        reason: "修复反馈中的流程阻塞",
        priority: "high",
        patchOperations: [
          {
            type: "add",
            targetPath: "userScenarios",
            value: { id: "scenario_next_step", title: "下一步引导" },
          },
        ],
        impactedAreas: ["userScenarios"],
      },
    });
    prisma.evolutionPlan.create.mockImplementation(async ({ data }) => ({
      id: "evolution-1",
      ...data,
      sourceReviewId: data.sourceReviewId ?? null,
      executedAt: null,
      createdAt: new Date("2026-06-21T08:05:00Z"),
    }));

    const result = await service.runForUser(user, { projectId: "project-1" });

    expect(result.evolutionPlan.priority).toBe("high");
    expect(result.evolutionPlan.patchOperations[0]).toEqual(
      expect.objectContaining({ type: "add", targetPath: "userScenarios" }),
    );
    expect(prisma.evolutionPlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        patchOperations: expect.arrayContaining([
          expect.objectContaining({ targetPath: "userScenarios" }),
        ]),
      }),
    });
  });

  it("executes an existing EvolutionPlan through PatchService and writes Patch Log", async () => {
    const service = new PatchExecutionEngineService(
      prisma as never,
      patchService as never,
      rollbackService as never,
      productMemory as never,
    );
    prisma.evolutionPlan.findFirst.mockResolvedValue({
      id: "evolution-1",
      projectId: "project-1",
      reason: "修复流程阻塞",
      priority: "high",
      patchOperations: [
        {
          type: "add",
          targetPath: "userScenarios",
          value: { id: "scenario_next_step", title: "下一步引导" },
        },
      ],
      prdChanges: [],
      prototypeChanges: [],
      impactedAreas: ["userScenarios"],
      sourceInsightIds: ["insight-1"],
      sourceReviewId: "review-1",
      generatedBy: "user-1",
      executedAt: null,
      createdAt: new Date("2026-06-21T08:05:00Z"),
    });
    patchService.applyEvolutionPlanForUser.mockResolvedValue({
      patchRecord: {
        id: "patch-1",
        afterProductDesignStateVersion: 3,
      },
      result: {
        productDesignState: { id: "state-1", version: 3 },
        prdDocument: { id: "prd-1" },
        prototypeArtifact: { id: "artifact-1" },
        qaReport: { id: "qa-1" },
      },
      runId: "run-1",
    });
    prisma.evolutionPatchExecution.create.mockImplementation(async ({ data }) => ({
      id: "execution-1",
      ...data,
      patchRecordId: data.patchRecordId ?? null,
      newStateVersion: data.newStateVersion ?? null,
      rollbackId: data.rollbackId ?? null,
      errorMessage: null,
      createdAt: new Date("2026-06-21T08:10:00Z"),
    }));
    prisma.evolutionPlan.update.mockResolvedValue({});

    const result = await service.applyForUser(user, {
      projectId: "project-1",
      evolutionPlanId: "evolution-1",
    });

    expect(result.success).toBe(true);
    expect(result.productMemory).toEqual(expect.objectContaining({ id: "memory-1", version: 3 }));
    expect(result.patchResult).toEqual(
      expect.objectContaining({
        success: true,
        newStateVersion: 3,
        rollbackId: "patch-1",
      }),
    );
    expect(patchService.applyEvolutionPlanForUser).toHaveBeenCalledWith(
      user,
      "project-1",
      expect.objectContaining({
        evolutionPlanId: "evolution-1",
        operations: expect.arrayContaining([
          expect.objectContaining({ targetPath: "userScenarios" }),
        ]),
      }),
    );
    expect(prisma.evolutionPatchExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        result: "success",
        patchRecordId: "patch-1",
        newStateVersion: 3,
      }),
    });
    expect(productMemory.recordPatchExecutionMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        evolutionPlanId: "evolution-1",
        patchExecutionId: "execution-1",
        patchRecordId: "patch-1",
      }),
    );
  });

  it("saves ProductMemory from execution records without mutating ProductDesignState or creating patches", async () => {
    const service = new ProductMemoryService(prisma as never);
    prisma.evolutionPatchExecution.findFirst.mockResolvedValue({
      id: "execution-1",
      projectId: "project-1",
      evolutionPlanId: "evolution-1",
      patchRecordId: "patch-1",
      result: "success",
      appliedOperations: [{ type: "add", targetPath: "userScenarios" }],
      newStateVersion: 3,
      rollbackId: "patch-1",
      errorMessage: null,
      createdBy: "user-1",
      createdAt: new Date("2026-06-21T08:10:00Z"),
    });
    prisma.evolutionPlan.findFirst.mockResolvedValue({
      id: "evolution-1",
      projectId: "project-1",
      reason: "修复流程阻塞",
      priority: "high",
      patchOperations: [{ type: "add", targetPath: "userScenarios" }],
      prdChanges: [],
      prototypeChanges: [],
      impactedAreas: ["userScenarios"],
      sourceInsightIds: ["insight-1"],
      sourceReviewId: "review-1",
      generatedBy: "user-1",
      executedAt: new Date("2026-06-21T08:10:00Z"),
      createdAt: new Date("2026-06-21T08:05:00Z"),
    });
    prisma.patchRecord.findFirst.mockResolvedValue({
      id: "patch-1",
      projectId: "project-1",
      beforeProductDesignStateVersion: 2,
      afterProductDesignStateVersion: 3,
      patchPlan: {},
      operations: [{ op: "add", path: "userScenarios" }],
      status: "applied",
      errorMessage: null,
      createdBy: "user-1",
      createdAt: new Date("2026-06-21T08:10:00Z"),
    });
    prisma.productInsight.findMany.mockResolvedValue([
      {
        id: "insight-1",
        projectId: "project-1",
        issueType: "flow",
        severity: "medium",
        affectedArea: ["prototype"],
        rootCause: "用户反馈流程卡住",
        suggestion: "补充下一步引导",
        sourceEvents: ["event-1"],
        generatedBy: "user-1",
        createdAt: new Date("2026-06-21T08:00:00Z"),
      },
    ]);
    prisma.productReviewReport.findFirst.mockResolvedValue({
      id: "review-1",
      projectId: "project-1",
      issues: [],
      conflicts: [],
      improvements: ["补充下一步引导"],
      consensusScore: 0.82,
      agentOutputs: {},
      generatedBy: "user-1",
      createdAt: new Date("2026-06-21T08:00:00Z"),
    });
    prisma.productDesignVersion.findFirst.mockImplementation(async ({ where }) => ({
      version: where.version,
      snapshot: { ...baseState(), version: where.version },
    }));
    prisma.productMemory.create.mockImplementation(async ({ data }) => ({
      id: "memory-1",
      ...data,
      category: data.category ?? null,
      evolutionPlanId: data.evolutionPlanId ?? null,
      patchExecutionId: data.patchExecutionId ?? null,
      patchRecordId: data.patchRecordId ?? null,
      createdAt: new Date("2026-06-21T08:11:00Z"),
    }));

    const result = await service.saveForUser(user, {
      projectId: "project-1",
      patchExecutionId: "execution-1",
    });

    expect(result.memory).toEqual(
      expect.objectContaining({
        id: "memory-1",
        projectId: "project-1",
        version: 3,
        category: "flow",
        evolutionPlanId: "evolution-1",
        patchExecutionId: "execution-1",
        patchRecordId: "patch-1",
      }),
    );
    expect(prisma.productMemory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changeReason: "修复流程阻塞",
        version: 3,
        beforeState: expect.objectContaining({ version: 2 }),
        afterState: expect.objectContaining({ version: 3 }),
      }),
    });
    expect(patchService.applyEvolutionPlanForUser).not.toHaveBeenCalled();
    expect(stateService.getCurrentState).not.toHaveBeenCalled();
  });
});

function baseProject() {
  return {
    id: "project-1",
    ownerId: "user-1",
    title: "签到活动",
    description: null,
    status: ProjectStatus.prototype_ready,
    currentConversationId: "conversation-1",
    currentProductDesignStateId: "state-1",
    currentPrdDocumentId: "prd-1",
    currentPrototypeArtifactId: "artifact-1",
    latestQaReportId: "qa-1",
    deletedAt: null,
  };
}

function baseState() {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 2,
    title: "签到活动",
    businessGoal: "提升用户活跃",
    targetUsers: [],
    userScenarios: [],
    pages: [],
    features: [],
    backendConfigs: [],
    frontendRules: [],
    businessRules: [],
    stateRules: [],
    exceptionScenarios: [],
    acceptanceCriteria: [],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "prototype_ready",
    createdBy: "user-1",
    createdAt: "2026-06-21T08:00:00.000Z",
    updatedAt: "2026-06-21T08:00:00.000Z",
  };
}
