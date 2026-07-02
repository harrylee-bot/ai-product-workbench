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
  const documentCanvasService = {
    createCanvasExportForUser: vi.fn(),
    createCanvasExportForProject: vi.fn(),
  };
  const service = new ExportService(
    documentService as never,
    prototypeService as never,
    qaService as never,
    documentCanvasService as never,
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
    documentCanvasService.createCanvasExportForUser.mockResolvedValue(baseCanvasExport());
    documentCanvasService.createCanvasExportForProject.mockResolvedValue(baseCanvasExport());
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
    expect(artifact.title).toBe("签到活动需求说明书");
    expect(artifact.fileName).toBe("签到活动需求说明书.doc");
    expect(html).toContain("签到活动需求说明书");
    expect(html).toContain("版 本 历 史");
    expect(html).toContain("目 录");
    expect(html).toContain("1 引言");
    expect(html).toContain("1.1 项目背景");
    expect(html).toContain("2 业务需求");
    expect(html).toContain("3 业务降级方案（必填）");
    expect(html).toContain("4 需求安全基线要求（必填）");
    expect(html.match(/class=\"safety-row\"/g)).toHaveLength(21);
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

  it("keeps diagram and prototype snapshot blocks in Word exports", async () => {
    documentService.getCurrentForUser.mockResolvedValue({
      document: baseDocument({
        sections: [
          {
            id: "visuals",
            title: "可视化说明",
            type: "page_requirements",
            level: 1,
            order: 1,
            content: "活动交易快照需要图文说明。",
            sourcePaths: [],
            blocks: [
              {
                id: "flow",
                type: "diagram",
                title: "业务流程图",
                diagramSyntax: "mermaid",
                content: "flowchart TD\nA[配置活动] --> B[生成交易快照]",
              },
              {
                id: "snapshot",
                type: "prototype_snapshot",
                title: "交易快照页",
                content: "Axure 原型截图",
                assetPath: "/tmp/snapshots/trade.png",
              },
            ],
          },
        ],
      }),
      productDesignState: baseState(),
    });

    const artifact = await service.exportPrdWordForUser(user, "project-1");
    const html = artifact.buffer.toString("utf8");

    expect(html).toContain("图表源码（mermaid）");
    expect(html).toContain("flowchart TD");
    expect(html).toContain('<img src="/tmp/snapshots/trade.png"');
    expect(html).toContain("素材路径：/tmp/snapshots/trade.png");
  });

  it("exports the current PRD as a JSON Canvas file", async () => {
    const artifact = await service.exportPrdCanvasForUser(user, "project-1");

    expect(qaService.assertGateAllows).toHaveBeenCalledWith(user, "project-1", "export_or_publish");
    expect(documentCanvasService.createCanvasExportForUser).toHaveBeenCalledWith(user, "project-1");
    expect(artifact.format).toBe("prd_canvas");
    expect(artifact.fileName).toBe("签到活动-PRD.canvas");
    expect(JSON.parse(artifact.buffer.toString("utf8"))).toEqual(expect.objectContaining({
      nodes: expect.any(Array),
      edges: expect.any(Array),
    }));
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
    shouldReviseArtifacts: false,
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

function baseCanvasExport() {
  const canvas = {
    nodes: [{ id: "aaaaaaaaaaaaaaaa", type: "text", x: 0, y: 0, width: 320, height: 160, text: "# 签到活动 PRD" }],
    edges: [],
  };
  const buffer = Buffer.from(JSON.stringify(canvas), "utf8");
  return {
    format: "prd_canvas" as const,
    projectId: "project-1",
    title: "签到活动 PRD",
    sourceType: "requirement_document" as const,
    sourceId: "prd-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    fileName: "签到活动-PRD.canvas",
    contentType: "application/json; charset=utf-8",
    downloadPath: "/api/projects/project-1/export/canvas",
    sizeBytes: buffer.byteLength,
    generatedAt: "2026-06-20T08:00:00.000Z",
    buffer,
  };
}
