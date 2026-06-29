import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  CopilotPrdRuntimeService,
  documentToState,
  PRD_STATE_KEY,
  WORKBENCH_PRD_AGENT_ID,
} from "../src/ai/copilot-prd-runtime.service";
import type { RequirementDocument } from "../src/ai/ai-vibe.types";

describe("CopilotPrdRuntimeService", () => {
  it("exposes the workbench PRD agent in runtime info", () => {
    const service = new CopilotPrdRuntimeService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    expect(service.getInfo()).toMatchObject({
      version: "0.0.57",
      mode: "sse",
      agents: {
        [WORKBENCH_PRD_AGENT_ID]: {
          capabilities: {
            transport: { streaming: true },
            state: { snapshots: true },
            tools: { supported: false },
          },
        },
      },
    });
    expect(PRD_STATE_KEY).toBe("workbenchPrd");
  });

  it("rejects unknown agents before handling a request", async () => {
    const service = new CopilotPrdRuntimeService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await expect(service.connect({} as never, "unknown", {}, {} as never))
      .rejects
      .toBeInstanceOf(NotFoundException);
  });

  it("rejects invalid AG-UI run input", async () => {
    const service = new CopilotPrdRuntimeService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await expect(service.connect({} as never, WORKBENCH_PRD_AGENT_ID, {}, {} as never))
      .rejects
      .toBeInstanceOf(BadRequestException);
  });
});

describe("documentToState", () => {
  it("converts a saved PRD into right-side document state", () => {
    const state = documentToState({
      id: "prd-1",
      projectId: "project-1",
      productDesignStateId: "state-1",
      productDesignStateVersion: 3,
      title: "签到打卡活动需求文档（PRD）",
      status: "draft",
      sections: [
        { id: "sec-2", title: "1.2 范围", content: "只做 PRD。", order: 2 },
        { id: "sec-1", title: "1.1 目的", content: "统一产品需求。", order: 1 },
      ],
      assumptions: [],
      knowledgeRefs: [],
      pendingQuestions: [],
      validationNotes: [],
      createdBy: "user-1",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T01:00:00.000Z",
    } satisfies RequirementDocument, "ready");

    expect(state).toMatchObject({
      status: "ready",
      title: "签到打卡活动需求文档（PRD）",
      prdDocumentId: "prd-1",
      activeHeadingId: "sec-2",
      updatedAt: "2026-06-29T01:00:00.000Z",
      sections: [
        { id: "sec-1", title: "1.1 目的", level: 3, order: 1 },
        { id: "sec-2", title: "1.2 范围", level: 3, order: 2 },
      ],
    });
    expect(state.markdown).toContain("# 签到打卡活动需求文档（PRD）");
    expect(state.markdown).toContain("## 1.1 目的");
    expect(state.markdown).toContain("统一产品需求。");
    expect(state.markdown).not.toContain("agent");
  });
});
