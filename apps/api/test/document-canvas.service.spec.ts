import { UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequirementDocument } from "../src/ai/ai-vibe.types";
import { buildDocumentCanvasView, DocumentCanvasService } from "../src/ai/document-canvas.service";

describe("DocumentCanvasService", () => {
  const documentService = {
    getDocumentForUser: vi.fn(),
    getCurrentForUser: vi.fn(),
    getCurrentForConversation: vi.fn(),
  };
  const service = new DocumentCanvasService(documentService as never);
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts a PRD into valid JSON Canvas nodes and edges", () => {
    const view = buildDocumentCanvasView(baseDocument());
    const nodeIds = new Set(view.canvas.nodes.map((node) => node.id));

    expect(view.stats.sectionCount).toBe(2);
    expect(view.canvas.nodes[0]).toEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("# 签到活动 PRD"),
    }));
    expect(view.canvas.nodes.every((node) => /^[0-9a-f]{16}$/.test(node.id))).toBe(true);
    expect(view.canvas.edges.every((edge) => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode))).toBe(true);
    expect(new Set([...view.canvas.nodes.map((node) => node.id), ...view.canvas.edges.map((edge) => edge.id)]).size)
      .toBe(view.canvas.nodes.length + view.canvas.edges.length);
  });

  it("loads an accessible PRD before returning its Canvas view", async () => {
    documentService.getDocumentForUser.mockResolvedValue({ document: baseDocument() });

    const view = await service.getCanvasForUser(user, "prd-1");

    expect(documentService.getDocumentForUser).toHaveBeenCalledWith(user, "prd-1");
    expect(view.documentId).toBe("prd-1");
    expect(view.canvas.nodes.length).toBeGreaterThan(0);
  });

  it("exports the current PRD as a .canvas artifact", async () => {
    documentService.getCurrentForUser.mockResolvedValue({ document: baseDocument() });

    const artifact = await service.createCanvasExportForUser(user, "conversation-1");

    expect(artifact.format).toBe("prd_canvas");
    expect(artifact.fileName).toBe("签到活动-PRD.canvas");
    expect(artifact.contentType).toContain("application/json");
    expect(JSON.parse(artifact.buffer.toString("utf8"))).toEqual(expect.objectContaining({
      nodes: expect.any(Array),
      edges: expect.any(Array),
    }));
  });
});

function baseDocument(overrides: Partial<RequirementDocument> = {}): RequirementDocument {
  return {
    id: "prd-1",
    conversationId: "conversation-1",
    conversationDesignStateId: "state-1",
    conversationDesignStateVersion: 3,
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
      {
        id: "frontend_rules",
        title: "前端展示规则",
        type: "frontend_rules",
        level: 1,
        order: 2,
        content: "按钮默认展示为立即签到。\n\n重复签到时展示今日已签到。",
        blocks: [
          {
            id: "frontend_rules_body",
            type: "paragraph",
            content: "按钮默认展示为立即签到。",
            sourcePaths: ["frontendRules"],
          },
          {
            id: "frontend_rules_warning",
            type: "warning",
            content: "重复签到时展示今日已签到。",
            sourcePaths: ["exceptionScenarios"],
          },
        ],
        sourcePaths: ["frontendRules"],
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
