import { KnowledgeType, ProjectStatus, QAReportStatus, QAReportTrigger, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";
import { QaRuleCheckService } from "../src/ai/qa-rule-check.service";
import { QaService } from "../src/ai/qa.service";

describe("Module 13 QA services", () => {
  it("creates blocking issues for missing pages, PRD, and prototype", () => {
    const service = new QaRuleCheckService();

    const issues = service.run({
      productDesignState: baseState({ pages: [] }),
      prdDocument: null,
      prototypeSpec: null,
      prototypeArtifact: null,
      knowledgeContext: emptyKnowledgeContext(),
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "qa_state_pages_empty", severity: "blocking" }),
        expect.objectContaining({ id: "qa_prd_missing", severity: "blocking" }),
        expect.objectContaining({ id: "qa_prototype_missing", severity: "blocking" }),
      ]),
    );
  });

  it("persists QAReport with issue counts and updates latestQaReportId", async () => {
    const now = new Date("2026-06-21T09:00:00Z");
    const prisma = {
      project: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      productDesignState: {
        findFirst: vi.fn(),
      },
      requirementDocument: {
        findFirst: vi.fn(),
      },
      prototypeArtifact: {
        findFirst: vi.fn(),
      },
      prototypeSpecRecord: {
        findUnique: vi.fn(),
      },
      qAReport: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
      knowledgeRetrievalLog: {
        create: vi.fn(),
      },
      knowledgeItem: {
        findMany: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    const ruleCheck = new QaRuleCheckService();
    const qaAgent = {
      run: vi.fn().mockResolvedValue({
        data: { status: "passed", summary: "模型检查通过", issues: [] },
      }),
    };
    const knowledgeRetrieval = {
      search: vi.fn().mockResolvedValue({ results: [], references: [] }),
    };
    const service = new QaService(
      prisma as never,
      ruleCheck,
      qaAgent as never,
      knowledgeRetrieval as never,
    );

    prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      ownerId: "user-1",
      status: ProjectStatus.prototype_ready,
      deletedAt: null,
      currentPrdDocumentId: "prd-1",
      currentPrototypeArtifactId: "artifact-1",
    });
    prisma.productDesignState.findFirst.mockResolvedValue(stateRecord(baseState({ pages: [] })));
    prisma.requirementDocument.findFirst.mockResolvedValue(null);
    prisma.prototypeArtifact.findFirst.mockResolvedValue(null);
    prisma.qAReport.create.mockImplementation(async ({ data }) => ({
      id: "qa-1",
      ...data,
      status: data.status as QAReportStatus,
      trigger: data.trigger as QAReportTrigger,
      prdDocumentId: data.prdDocumentId ?? null,
      prototypeArtifactId: data.prototypeArtifactId ?? null,
      prototypeSpecId: data.prototypeSpecId ?? null,
      generatedByRunId: data.generatedByRunId ?? null,
      relatedPatchId: data.relatedPatchId ?? null,
      relatedRollbackId: data.relatedRollbackId ?? null,
      createdAt: now,
      updatedAt: now,
    }));

    const report = await service.runForProject("project-1", "user-1", {
      trigger: "manual",
      runId: "run-1",
    });

    expect(report.status).toBe("failed");
    expect(report.blockingCount).toBeGreaterThanOrEqual(3);
    expect(report.passed).toBe(false);
    expect(prisma.qAReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        status: "failed",
        trigger: "manual",
        generatedByRunId: "run-1",
      }),
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({
        latestQaReportId: "qa-1",
        status: ProjectStatus.qa_failed,
      }),
    });
  });
});

function baseState(overrides: Partial<ProductDesignState> = {}): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 2,
    title: "签到活动",
    summary: "签到活动需求",
    businessGoal: "提升活跃",
    targetUsers: [],
    userScenarios: [],
    pages: [{ id: "page_home", name: "签到页" }],
    features: [],
    backendConfigs: [],
    frontendRules: [],
    businessRules: [{ id: "rule_daily_once", title: "每日一次" }],
    stateRules: [],
    exceptionScenarios: [],
    acceptanceCriteria: [],
    assumptions: [{ id: "assumption_1", content: "默认积分奖励", status: "pending" }],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "prototype_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-21T08:00:00.000Z",
    updatedAt: "2026-06-21T08:00:00.000Z",
    ...overrides,
  };
}

function stateRecord(state: ProductDesignState) {
  return {
    ...state,
    summary: state.summary ?? null,
    background: state.background ?? null,
    prototypeOutline: state.prototypeOutline ?? null,
    prototypeSpec: state.prototypeSpec ?? null,
    prdDocument: state.prdDocument ?? null,
    updatedBy: state.updatedBy ?? null,
    createdAt: new Date(state.createdAt),
    updatedAt: new Date(state.updatedAt),
  };
}

function emptyKnowledgeContext() {
  return {
    query: "",
    strongRules: [],
    defaultRules: [],
    referenceCases: [],
    designPatterns: [],
    prdWritingRules: [],
    prototypeRules: [],
    businessConcepts: [],
    conflicts: [],
    unknownAreas: [],
    summary: "无知识命中",
  };
}
