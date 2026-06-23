import { UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDesignState, PrototypeArtifact, QAGateDecision, RequirementDocument } from "../src/ai/ai-vibe.types";
import { ExportService } from "../src/ai/export.service";

describe("Vibe export module", () => {
  const documentService = {
    getCurrentForUser: vi.fn(),
    getCurrentForProject: vi.fn(),
  };
  const prototypeService = {
    getCurrentForUser: vi.fn(),
    getCurrentForProject: vi.fn(),
  };
  const qaService = {
    assertGateAllows: vi.fn(),
    assertGateAllowsForProject: vi.fn(),
  };
  const service = new ExportService(
    documentService as never,
    prototypeService as never,
    qaService as never,
  );
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    qaService.assertGateAllows.mockResolvedValue(openGate());
    qaService.assertGateAllowsForProject.mockResolvedValue(openGate());
  });

  it("exports the current ProductDesignState PRD as a Word-readable document", async () => {
    documentService.getCurrentForUser.mockResolvedValue({
      document: baseDocument(),
      productDesignState: baseState(),
    });

    const artifact = await service.exportPrdWordForUser(user, "project-1");
    const html = artifact.buffer.toString("utf8");

    expect(qaService.assertGateAllows).toHaveBeenCalledWith(user, "project-1", "export_or_publish");
    expect(artifact.format).toBe("prd_word");
    expect(artifact.contentType).toContain("application/msword");
    expect(artifact.downloadPath).toBe("/api/projects/project-1/export/word");
    expect(artifact.productDesignStateId).toBe("state-1");
    expect(artifact.qaGate).toEqual(expect.objectContaining({ status: "open" }));
    expect(html).toContain("签到活动 PRD");
    expect(html).toContain("ProductDesignState");
    expect(html).toContain("每日签到");
  });

  it("exports the current state-bound HTML prototype as a single html file", async () => {
    prototypeService.getCurrentForUser.mockResolvedValue({
      artifact: baseArtifact(),
      productDesignState: baseState(),
    });

    const artifact = await service.exportPrototypeHtmlForUser(user, "project-1");

    expect(qaService.assertGateAllows).toHaveBeenCalledWith(user, "project-1", "export_or_publish");
    expect(artifact.format).toBe("prototype_html");
    expect(artifact.fileName).toBe("签到活动原型.html");
    expect(artifact.buffer.toString("utf8")).toContain('data-page-id="page_home"');
  });

  it("rejects stale PRD exports that do not match the current ProductDesignState", async () => {
    documentService.getCurrentForUser.mockResolvedValue({
      document: baseDocument({ productDesignStateVersion: 2 }),
      productDesignState: baseState(),
    });

    await expect(service.exportPrdWordForUser(user, "project-1")).rejects.toThrow("PRD_EXPORT_STATE_MISMATCH");
    expect(qaService.assertGateAllows).not.toHaveBeenCalled();
  });

  it("rejects stale HTML exports that do not match the current ProductDesignState", async () => {
    prototypeService.getCurrentForUser.mockResolvedValue({
      artifact: baseArtifact({ productDesignStateId: "state-old" }),
      productDesignState: baseState(),
    });

    await expect(service.exportPrototypeHtmlForUser(user, "project-1")).rejects.toThrow("HTML_EXPORT_STATE_MISMATCH");
    expect(qaService.assertGateAllows).not.toHaveBeenCalled();
  });

  it("uses the project-level QA gate for orchestrator export intents", async () => {
    documentService.getCurrentForProject.mockResolvedValue({
      document: baseDocument(),
      productDesignState: baseState(),
    });

    const artifact = await service.createPrdWordExport("project-1");

    expect(qaService.assertGateAllowsForProject).toHaveBeenCalledWith("project-1", "export_or_publish");
    expect(artifact.sourceId).toBe("prd-1");
  });

  it("blocks export when QA gate rejects export_or_publish", async () => {
    documentService.getCurrentForUser.mockResolvedValue({
      document: baseDocument(),
      productDesignState: baseState(),
    });
    qaService.assertGateAllows.mockRejectedValue(new Error("QA_GATE_BLOCKED"));

    await expect(service.exportPrdWordForUser(user, "project-1")).rejects.toThrow("QA_GATE_BLOCKED");
  });
});

function openGate(): QAGateDecision {
  return {
    status: "open",
    allowConfirmArtifacts: true,
    allowPersistKnowledge: true,
    allowExportOrPublish: true,
    shouldReturnToPatch: false,
    blockingReasons: [],
    warnings: [],
    requiredActions: [],
    evaluatedAt: "2026-06-20T08:00:00.000Z",
  };
}

function baseState(): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 3,
    title: "签到活动",
    summary: "让用户每天完成签到并领取积分奖励。",
    businessGoal: "提升用户活跃和连续访问。",
    background: "运营希望用轻量活动提升留存。",
    targetUsers: [],
    userScenarios: [],
    pages: [{ id: "page_home", name: "签到页", description: "展示签到状态和奖励" }],
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
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
  };
}

function baseDocument(overrides: Partial<RequirementDocument> = {}): RequirementDocument {
  return {
    id: "prd-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    title: "签到活动 PRD",
    status: "ready",
    sections: [
      {
        id: "overview",
        title: "产品概述",
        type: "overview",
        level: 1,
        order: 1,
        content: "每日签到帮助用户形成连续访问习惯。",
        sourcePaths: ["summary"],
      },
    ],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}

function baseArtifact(overrides: Partial<PrototypeArtifact> = {}): PrototypeArtifact {
  return {
    id: "artifact-1",
    projectId: "project-1",
    prototypeSpecId: "spec-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    title: "签到活动原型",
    status: "ready",
    htmlContent: '<!doctype html><html><body><main data-page-id="page_home">签到</main></body></html>',
    entryFilePath: "index.html",
    targetDevice: "both",
    pageCount: 1,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    assets: [],
    ...overrides,
  };
}
