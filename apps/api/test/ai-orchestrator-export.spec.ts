import { AgentName, ProjectStatus, UserIntent } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiOrchestratorService } from "../src/ai/ai-orchestrator.service";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";

describe("AiOrchestrator export intents", () => {
  const runLog = {
    createStep: vi.fn(),
    startStep: vi.fn(),
    completeStep: vi.fn(),
    failStep: vi.fn(),
    markRunIntent: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
  };
  const stream = { emit: vi.fn() };
  const stateService = {};
  const documentService = {};
  const prototypeService = {};
  const exportService = {
    createPrdWordExport: vi.fn(),
    createPrototypeHtmlExport: vi.fn(),
  };
  const qaService = {};
  const messageService = {
    createAssistantMessage: vi.fn(),
    updateProjectActivity: vi.fn(),
  };
  const prisma = {
    project: {
      update: vi.fn(),
    },
  };
  const intentAgent = { run: vi.fn() };
  const knowledgeAgent = { run: vi.fn() };
  const requirementAnalystAgent = { run: vi.fn() };
  const productPlannerAgent = { run: vi.fn() };
  const productDesignerAgent = { run: vi.fn() };
  const prdWriterAgent = { run: vi.fn() };
  const prototypeDesignerAgent = { run: vi.fn() };
  const prototypeCodeAgent = { run: vi.fn() };
  const patchService = { createPatchCandidateFromRun: vi.fn() };
  const qaAgent = { run: vi.fn() };
  const knowledgeExtractorAgent = { run: vi.fn() };
  const service = new AiOrchestratorService(
    runLog as never,
    stream as never,
    stateService as never,
    documentService as never,
    prototypeService as never,
    exportService as never,
    patchService as never,
    qaService as never,
    messageService as never,
    prisma as never,
    intentAgent as never,
    knowledgeAgent as never,
    requirementAnalystAgent as never,
    productPlannerAgent as never,
    productDesignerAgent as never,
    prdWriterAgent as never,
    prototypeDesignerAgent as never,
    prototypeCodeAgent as never,
    qaAgent as never,
    knowledgeExtractorAgent as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    runLog.createStep.mockResolvedValue({ id: "step-1" });
    stream.emit.mockResolvedValue({});
    intentAgent.run.mockResolvedValue({
      data: {
        intent: UserIntent.export_word,
        confidence: 0.95,
        reason: "用户希望导出当前 PRD Word 文档。",
        requiresSelection: false,
        isAmbiguous: false,
      },
    });
    exportService.createPrdWordExport.mockResolvedValue({
      format: "prd_word",
      projectId: "project-1",
      title: "签到活动 PRD",
      sourceType: "requirement_document",
      sourceId: "prd-1",
      productDesignStateId: "state-1",
      productDesignStateVersion: 3,
      fileName: "签到活动-PRD.doc",
      contentType: "application/msword; charset=utf-8",
      downloadPath: "/api/projects/project-1/export/word",
      sizeBytes: 12,
      generatedAt: "2026-06-20T08:00:00.000Z",
      buffer: Buffer.from("word"),
    });
  });

  it("short-circuits export_word into export_ready without running generation agents", async () => {
    const result = await service.run({
      userMessageId: "msg-1",
      attachments: [],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "导出 Word",
        recentMessages: [],
        attachments: [],
        productDesignState: baseState(),
        currentProjectStatus: ProjectStatus.prototype_ready,
        traceId: "trace-1",
      },
    });

    expect(runLog.createStep).toHaveBeenCalledWith(expect.objectContaining({
      agentName: AgentName.intent_agent,
    }));
    expect(exportService.createPrdWordExport).toHaveBeenCalledWith("project-1");
    expect(knowledgeAgent.run).not.toHaveBeenCalled();
    expect(productPlannerAgent.run).not.toHaveBeenCalled();
    expect(productDesignerAgent.run).not.toHaveBeenCalled();
    expect(prdWriterAgent.run).not.toHaveBeenCalled();
    expect(prototypeCodeAgent.run).not.toHaveBeenCalled();
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "export_ready",
      data: expect.objectContaining({ downloadPath: "/api/projects/project-1/export/word" }),
    }));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.prototype_ready }),
    });
    expect(result.nextAction?.type).toBe("download_export");
    expect(result.exportArtifact?.sourceId).toBe("prd-1");
  });
});

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
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
  };
}
