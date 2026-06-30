import { describe, expect, it, vi } from "vitest";
import { FinalActionApplierService } from "../src/ai/final-action-applier.service";
import type { DeerFlowFinalAction, DeerFlowResolvedArtifact } from "../src/ai/deerflow-runtime.service";

describe("FinalActionApplierService", () => {
  const stateService = {
    createDraft: vi.fn(),
    attachGeneratedArtifacts: vi.fn(),
    getCurrentState: vi.fn(),
  };
  const documentService = { saveGeneratedDocument: vi.fn() };
  const prototypeService = { saveGeneratedPrototype: vi.fn() };
  const prisma = {
    project: { findUnique: vi.fn() },
    requirementDocument: { findMany: vi.fn() },
  };
  const service = new FinalActionApplierService(
    prisma as never,
    stateService as never,
    documentService as never,
    prototypeService as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findUnique.mockResolvedValue({ currentPrdDocumentId: null });
    prisma.requirementDocument.findMany.mockResolvedValue([]);
  });

  it("bridges DeerFlow review_prd final actions into ProductDesignState and PRD persistence", async () => {
    const state = baseState({ status: "design_ready" });
    const document = baseDocument();
    const updatedState = { ...state, status: "doc_ready", prdDocument: document };
    stateService.createDraft.mockResolvedValue(state);
    documentService.saveGeneratedDocument.mockResolvedValue(document);
    stateService.attachGeneratedArtifacts.mockResolvedValue(updatedState);

    const result = await service.apply({
      projectId: "project-1",
      userId: "user-1",
      runId: "run-1",
      finalAction: finalAction({
        type: "review_prd",
        message: "已生成 PRD，请确认。",
        raw: {
          type: "review_prd",
          productDesignStateDraft: {
            title: "签到活动",
            summary: "用户每日签到领取积分",
            businessGoal: "提升活跃",
            pages: [{ id: "page_home", name: "签到页" }],
            businessRules: [{ id: "daily_once", title: "每日一次" }],
          },
          prdDocumentDraft: {
            title: "签到活动 PRD",
            sections: [
              {
                id: "overview",
                title: "概览",
                type: "overview",
                level: 1,
                order: 1,
                content: "用户每日签到领取积分。",
                sourcePaths: ["summary"],
              },
            ],
          },
          knowledgeRefsUsed: ["01-业务规则/签到规则"],
          assumptions: ["默认每日只能签到一次"],
        },
      }),
      artifacts: [],
    });

    expect(stateService.createDraft).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        title: "签到活动",
        summary: "用户每日签到领取积分",
        businessGoal: "提升活跃",
        pages: [{ id: "page_home", name: "签到页" }],
        businessRules: [{ id: "daily_once", title: "每日一次" }],
        assumptions: [expect.objectContaining({ content: "默认每日只能签到一次", status: "pending" })],
        knowledgeRefs: [expect.objectContaining({ title: "01-业务规则/签到规则" })],
        createdBy: "user-1",
      }),
      expect.objectContaining({ userId: "user-1", runId: "run-1" }),
    );
    expect(documentService.saveGeneratedDocument).toHaveBeenCalledWith(
      state,
      expect.objectContaining({
        title: "签到活动 PRD",
        sections: [expect.objectContaining({ id: "overview", content: "用户每日签到领取积分。" })],
      }),
      expect.objectContaining({ userId: "user-1", runId: "run-1" }),
    );
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith("state-1", expect.objectContaining({
      prdDocument: document,
      status: "doc_ready",
      runId: "run-1",
    }));
    expect(result).toEqual({ prdDocument: document, state: updatedState });
  });

  it("builds PRD sections from DeerFlow markdown artifacts when structured sections are absent", async () => {
    const state = baseState();
    const document = baseDocument();
    stateService.createDraft.mockResolvedValue(state);
    documentService.saveGeneratedDocument.mockResolvedValue(document);
    stateService.attachGeneratedArtifacts.mockResolvedValue({ ...state, prdDocument: document });

    await service.apply({
      projectId: "project-1",
      userId: "user-1",
      runId: "run-1",
      finalAction: finalAction({
        type: "review_prd",
        message: "已生成 PRD。",
        raw: { type: "review_prd", prdDocumentDraft: { title: "签到活动 PRD" } },
      }),
      artifacts: [
        {
          kind: "prd_markdown",
          path: "mnt/user-data/outputs/prd.md",
          artifactUrl: "/api/artifacts/prd.md",
          contentType: "text/markdown",
          status: "fetched",
          text: "# 签到活动 PRD\n\n## 目标\n提升用户活跃。\n\n## 页面\n签到页展示连续签到天数。",
        },
      ],
    });

    expect(documentService.saveGeneratedDocument).toHaveBeenCalledWith(
      state,
      expect.objectContaining({
        sections: expect.arrayContaining([
          expect.objectContaining({ title: "目标", content: "提升用户活跃。" }),
          expect.objectContaining({ title: "页面", content: "签到页展示连续签到天数。" }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it("builds PRD sections from assistant markdown when DeerFlow only returns a summary final action", async () => {
    const state = baseState();
    const document = baseDocument();
    stateService.createDraft.mockResolvedValue(state);
    documentService.saveGeneratedDocument.mockResolvedValue(document);
    stateService.attachGeneratedArtifacts.mockResolvedValue({ ...state, prdDocument: document });

    await service.apply({
      projectId: "project-1",
      userId: "user-1",
      runId: "run-1",
      finalAction: finalAction({
        type: "review_prd",
        message: "已继续完善签到打卡活动 PRD。",
        raw: { type: "review_prd", prdDocumentDraft: { title: "需求文档" } },
      }),
      artifacts: [],
      assistantText: [
        "# 签到打卡活动 PRD",
        "",
        "## 产品目标",
        "提升用户每日活跃和连续访问。",
        "",
        "## 用户端功能",
        "用户可以每日签到、查看连续签到天数和奖励明细。",
        "",
        "## 验收标准",
        "签到成功后页面状态应更新为今日已签到。",
      ].join("\n"),
    });

    expect(documentService.saveGeneratedDocument).toHaveBeenCalledWith(
      state,
      expect.objectContaining({
        title: "需求文档",
        sections: expect.arrayContaining([
          expect.objectContaining({ title: "产品目标", content: "提升用户每日活跃和连续访问。" }),
          expect.objectContaining({ title: "用户端功能", content: "用户可以每日签到、查看连续签到天数和奖励明细。" }),
          expect.objectContaining({ title: "验收标准", content: "签到成功后页面状态应更新为今日已签到。" }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it("bridges DeerFlow review_prototype final actions into PrototypeSpec, HTML artifact, and state persistence", async () => {
    const state = baseState({ status: "doc_confirmed" });
    const prototypeSpec = { id: "spec-1", pages: [{ id: "page_home", name: "签到页" }] };
    const artifact = { id: "artifact-1", htmlContent: "<main>签到页</main>" };
    const updatedState = { ...state, status: "prototype_ready", prototypeSpec };
    stateService.getCurrentState.mockResolvedValue(state);
    prototypeService.saveGeneratedPrototype.mockResolvedValue({ prototypeSpec, artifact });
    stateService.attachGeneratedArtifacts.mockResolvedValue(updatedState);

    const result = await service.apply({
      projectId: "project-1",
      userId: "user-1",
      runId: "run-2",
      finalAction: finalAction({
        type: "review_prototype",
        message: "原型已生成，请确认。",
        raw: {
          type: "review_prototype",
          prototypeSpec: {
            title: "签到活动原型",
            targetDevice: "desktop",
            pages: [{ id: "page_home", name: "签到页", components: [] }],
          },
        },
      }),
      artifacts: [prototypeHtmlArtifact()],
    });

    expect(prototypeService.saveGeneratedPrototype).toHaveBeenCalledWith(
      state,
      expect.objectContaining({
        projectId: "project-1",
        productDesignStateId: "state-1",
        productDesignStateVersion: 3,
        title: "签到活动原型",
        targetDevice: "desktop",
        pages: [{ id: "page_home", name: "签到页", components: [] }],
      }),
      expect.objectContaining({
        projectId: "project-1",
        htmlContent: "<html><body>签到页</body></html>",
        html: "<html><body>签到页</body></html>",
        title: "签到活动原型",
        targetDevice: "desktop",
      }),
      expect.objectContaining({ userId: "user-1", runId: "run-2" }),
    );
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith("state-1", expect.objectContaining({
      prototypeSpec,
      status: "prototype_ready",
      runId: "run-2",
    }));
    expect(result).toEqual({ prototypeArtifact: artifact, state: updatedState });
  });

  it("fails prototype bridge when no ProductDesignState exists", async () => {
    stateService.getCurrentState.mockResolvedValue(null);

    await expect(service.apply({
      projectId: "project-1",
      userId: "user-1",
      runId: "run-2",
      finalAction: finalAction({ type: "review_prototype", message: "原型已生成。" }),
      artifacts: [prototypeHtmlArtifact()],
    })).rejects.toThrow("PROTOTYPE_STATE_NOT_FOUND");

    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
  });
});

function finalAction(overrides: Partial<DeerFlowFinalAction>): DeerFlowFinalAction {
  return {
    type: "answer",
    message: "完成。",
    parsed: true,
    raw: { type: "answer" },
    ...overrides,
  };
}

function prototypeHtmlArtifact(): DeerFlowResolvedArtifact {
  return {
    kind: "prototype_html",
    path: "mnt/user-data/outputs/index.html",
    artifactUrl: "/api/threads/thread-1/artifacts/mnt/user-data/outputs/index.html",
    contentType: "text/html",
    status: "fetched",
    text: "<html><body>签到页</body></html>",
  };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 3,
    title: "签到活动",
    status: "doc_ready",
    ...overrides,
  };
}

function baseDocument() {
  return {
    id: "prd-1",
    projectId: "project-1",
    title: "签到活动 PRD",
    sections: [],
  };
}
