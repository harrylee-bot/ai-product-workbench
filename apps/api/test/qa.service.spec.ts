import { KnowledgeType, ProjectStatus, QAReportStatus, QAReportTrigger, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDesignState, PrototypeSpec, QAReport, RequirementDocument } from "../src/ai/ai-vibe.types";
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

  it("flags Vibe Coding skills that were not preserved in ProductDesignState knowledgeRefs", () => {
    const service = new QaRuleCheckService();
    const knowledgeContext = {
      ...emptyKnowledgeContext(),
      runtimeSkills: [
        {
          id: "runtime-skill:obsidian-markdown",
          name: "obsidian-markdown",
          description: "Create and edit Obsidian Flavored Markdown.",
          sourcePath: "/skills/obsidian-markdown/SKILL.md",
          contentPreview: "Use wikilinks.",
          capabilities: ["Internal Links"],
          triggerHints: ["wikilinks"],
        },
      ],
    };

    const missing = service.run({
      productDesignState: baseState({ knowledgeRefs: [] }),
      knowledgeContext,
      checkTypes: ["knowledge_rule_compliance"],
    });

    expect(missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "qa_skill_reference_missing_obsidian-markdown",
          severity: "major",
          relatedStatePaths: ["knowledgeRefs"],
          relatedKnowledgeIds: ["runtime-skill:obsidian-markdown"],
        }),
      ]),
    );

    const preserved = service.run({
      productDesignState: baseState({
        knowledgeRefs: [
          {
            knowledgeId: "runtime-skill:obsidian-markdown",
            title: "Vibe Coding 可用技能：obsidian-markdown",
            relatedPath: "/skills/obsidian-markdown/SKILL.md",
          },
        ],
      }),
      knowledgeContext,
      checkTypes: ["knowledge_rule_compliance"],
    });

    expect(preserved.find((issue) => issue.id === "qa_skill_reference_missing_obsidian-markdown")).toBeUndefined();
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
    const knowledgeRetrieval = {
      search: vi.fn().mockResolvedValue({ results: [], references: [] }),
    };
    const service = new QaService(
      prisma as never,
      ruleCheck,
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
    expect(report.gate).toEqual(
      expect.objectContaining({
        status: "blocked",
        allowConfirmArtifacts: false,
        allowPersistKnowledge: false,
        allowExportOrPublish: false,
        shouldReturnToPatch: true,
        requiredActions: ["return_to_patch", "run_qa"],
      }),
    );
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

  it("runs QA from ProductDesignState snapshots instead of stale project pointers", async () => {
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
    const knowledgeRetrieval = {
      search: vi.fn().mockResolvedValue({ results: [], references: [] }),
    };
    const service = new QaService(
      prisma as never,
      ruleCheck,
      knowledgeRetrieval as never,
    );
    const state = baseState();
    const prdDocument = toRequirementDocument(state, "prd-state");
    const prototypeSpec = toPrototypeSpec(state, "run-state");

    prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      ownerId: "user-1",
      status: ProjectStatus.prototype_ready,
      deletedAt: null,
      currentPrdDocumentId: "prd-stale",
      currentPrototypeArtifactId: "artifact-stale",
    });
    prisma.productDesignState.findFirst.mockResolvedValue(stateRecord({
      ...state,
      prdDocument,
      prototypeSpec,
    }));
    prisma.prototypeArtifact.findFirst.mockResolvedValue({
      id: "artifact-stale",
      projectId: "project-1",
      prototypeSpecId: "spec-stale",
      productDesignStateId: "state-1",
      productDesignStateVersion: state.version,
      title: "旧原型",
      status: "ready",
      htmlContent: "<!doctype html>",
      entryFilePath: "index.html",
      previewUrl: null,
      targetDevice: "both",
      pageCount: 1,
      generatedByRunId: null,
      errorMessage: null,
      createdBy: "user-1",
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    prisma.qAReport.create.mockImplementation(async ({ data }) => ({
      id: "qa-state",
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
      runId: "run-state",
    });

    expect(prisma.requirementDocument.findFirst).not.toHaveBeenCalled();
    expect(report.prdDocumentId).toBe("prd-state");
    expect(report.prototypeSpecId).toBe(prototypeSpec.id);
    expect(report.prototypeArtifactId).toBeUndefined();
  });

  it("evaluates QA gate decisions for passed, warning, failed, and missing reports", () => {
    const service = new QaService({} as never, new QaRuleCheckService(), {} as never);

    expect(service.evaluateGate(qaReport({ status: "passed" }))).toEqual(
      expect.objectContaining({
        status: "open",
        allowConfirmArtifacts: true,
        allowPersistKnowledge: true,
        allowExportOrPublish: true,
        shouldReturnToPatch: false,
      }),
    );

    expect(service.evaluateGate(qaReport({
      status: "warning",
      minorCount: 1,
      issues: [{
        id: "minor-1",
        checkType: "prd_completeness",
        severity: "minor",
        title: "文案待优化",
        description: "局部文案需要后续调整。",
        status: "open",
      }],
    }))).toEqual(
      expect.objectContaining({
        status: "warning",
        allowConfirmArtifacts: true,
        allowPersistKnowledge: false,
        allowExportOrPublish: false,
        shouldReturnToPatch: false,
        requiredActions: ["run_qa"],
      }),
    );

    expect(service.evaluateGate(qaReport({
      status: "failed",
      blockingCount: 1,
      issues: [{
        id: "blocking-1",
        checkType: "state_prd_consistency",
        severity: "blocking",
        title: "PRD 与 State 不一致",
        description: "PRD 缺少核心规则。",
        status: "open",
      }],
    }))).toEqual(
      expect.objectContaining({
        status: "blocked",
        allowConfirmArtifacts: false,
        allowPersistKnowledge: false,
        allowExportOrPublish: false,
        shouldReturnToPatch: true,
        requiredActions: ["return_to_patch", "run_qa"],
      }),
    );

    expect(service.evaluateGate(null)).toEqual(
      expect.objectContaining({
        status: "blocked",
        allowConfirmArtifacts: false,
        requiredActions: ["run_qa"],
      }),
    );
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

function toRequirementDocument(state: ProductDesignState, id: string): RequirementDocument {
  return {
    id,
    projectId: state.projectId,
    productDesignStateId: state.id,
    productDesignStateVersion: state.version,
    title: `${state.title} PRD`,
    status: "ready",
    sections: [
      {
        id: "overview",
        title: "需求概览",
        type: "overview",
        level: 1,
        order: 1,
        content: state.summary ?? state.title,
        sourcePaths: ["summary"],
      },
    ],
    assumptions: state.assumptions.map((item) => ({
      assumptionId: String(item.id ?? "assumption_1"),
      content: String(item.content ?? ""),
      relatedSectionIds: ["overview"],
      status: "pending",
    })),
    knowledgeRefs: state.knowledgeRefs,
    pendingQuestions: [],
    validationNotes: [],
    generatedByRunId: "run-state",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-21T08:00:00.000Z",
    updatedAt: "2026-06-21T08:00:00.000Z",
  };
}

function toPrototypeSpec(state: ProductDesignState, runId: string): PrototypeSpec {
  return {
    id: `spec-${runId}`,
    projectId: state.projectId,
    productDesignStateId: state.id,
    productDesignStateVersion: state.version,
    title: `${state.title} HTML 原型`,
    targetDevice: "both",
    styleGuide: {
      tone: "clean",
      layoutDensity: "comfortable",
      borderRadius: "small",
    },
    pages: [
      {
        id: "page_home",
        name: "签到页",
        device: "responsive",
        layout: "dashboard",
        components: [
          {
            id: "page_home_primary_action",
            name: "签到按钮",
            type: "button",
            content: "立即签到",
            sourcePaths: ["frontendRules"],
          },
        ],
        sourcePaths: ["pages[0]"],
        order: 1,
      },
    ],
    navigation: [],
    interactions: [],
    assumptions: [],
    knowledgeRefs: state.knowledgeRefs,
    generatedByRunId: runId,
  };
}

function qaReport(overrides: Partial<QAReport> = {}): QAReport {
  return {
    id: "qa-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 2,
    status: "passed",
    trigger: "manual",
    checkTypes: ["state_schema"],
    summary: "QA 通过",
    issues: [],
    blockingCount: 0,
    majorCount: 0,
    minorCount: 0,
    infoCount: 0,
    createdBy: "user-1",
    createdAt: "2026-06-21T08:00:00.000Z",
    updatedAt: "2026-06-21T08:00:00.000Z",
    passed: true,
    gate: {
      status: "open",
      allowConfirmArtifacts: true,
      allowPersistKnowledge: true,
      allowExportOrPublish: true,
      shouldReturnToPatch: false,
      reportId: "qa-1",
      reportStatus: "passed",
      blockingReasons: [],
      warnings: [],
      requiredActions: [],
      evaluatedAt: "2026-06-21T08:00:00.000Z",
    },
    ...overrides,
  };
}
