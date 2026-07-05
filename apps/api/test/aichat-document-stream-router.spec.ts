import { NotFoundException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  AichatStreamService,
  createDocumentStreamState,
  isDocumentGenerationRequest,
  looksLikeDocumentDraft,
  routeAssistantDocumentDelta,
} from "../src/ai/aichat/aichat-stream.service";
import type { UIMessageStreamWriter } from "../src/ai/aichat/aichat-ai-sdk-bridge";
import type { AuthenticatedUser } from "../src/auth/auth.types";

function captureWriter() {
  const parts: Record<string, unknown>[] = [];
  const writer: UIMessageStreamWriter = {
    write: (part) => {
      parts.push(part);
    },
  };
  return { parts, writer };
}

describe("aichat document stream router", () => {
  it("detects Chinese requirement document requests", () => {
    expect(isDocumentGenerationRequest("给我生成一个问卷活动的需求文档")).toBe(true);
    expect(isDocumentGenerationRequest("请编写签到活动 PRD")).toBe(true);
    expect(isDocumentGenerationRequest("活动交易快照功能需求说明书")).toBe(true);
    expect(isDocumentGenerationRequest("这份需求文档有哪些风险？")).toBe(false);
    expect(isDocumentGenerationRequest("请用一句话说明当前系统是否在线，不要生成PRD。")).toBe(false);
    expect(isDocumentGenerationRequest("不要生成 PRD，只回答运行状态")).toBe(false);
  });

  it("recognizes compact requirement specs with adjacent markdown headings", () => {
    expect(
      looksLikeDocumentDraft(
        "问卷调查活动需求说明书##版本历史|版本|日期|作者|变更说明|",
        "问卷调查活动需求说明书##版本历史|版本|日期|作者|变更说明|",
      ),
    ).toBe(true);
  });

  it("routes PRD block source snippets that start with mermaid or JSON blocks", () => {
    expect(
      looksLikeDocumentDraft(
        "mermaid\nflowchart TD\nA[用户参与活动] --> B[生成交易快照]",
        "mermaid\nflowchart TD\nA[用户参与活动] --> B[生成交易快照]",
      ),
    ).toBe(true);
    expect(
      looksLikeDocumentDraft(
        '{"type":"table","title":"页面异常态要求","content":"| 异常态 | 处理要求 |"}',
        '{"type":"table","title":"页面异常态要求","content":"| 异常态 | 处理要求 |"}',
      ),
    ).toBe(true);
    // sections JSON（type: section）应被识别为文档内容，不应泄漏到聊天区
    expect(
      looksLikeDocumentDraft(
        '{"id":"data_review","title":"2.9 数据复盘","type":"section","level":2,"order":16,"content":"交易快照需要支持基础统计","sourcePaths":["summary"]}',
        '{"id":"data_review","title":"2.9 数据复盘","type":"section","level":2,"order":16,"content":"交易快照需要支持基础统计","sourcePaths":["summary"]}',
      ),
    ).toBe(true);
    // businessRules、acceptanceCriteria 等 PRD 专属字段也应被识别
    expect(
      looksLikeDocumentDraft(
        '{"acceptanceCriteria":[{"id":"ac1","title":"验收标准1"}]}',
        '{"acceptanceCriteria":[{"id":"ac1","title":"验收标准1"}]}',
      ),
    ).toBe(true);
  });

  it("routes document generation text into the text artifact stream", () => {
    const { parts, writer } = captureWriter();
    const state = createDocumentStreamState("run-1", {
      forceDocumentStream: true,
    });

    const result = routeAssistantDocumentDelta(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk: "问卷调查活动需求说明书##版本历史|版本|日期|作者|变更说明|",
      },
      writer,
      state,
    );

    expect(result).toEqual({ suppressChat: true });
    expect(parts).toEqual([
      { type: "data-kind", data: "text", transient: true },
      { type: "data-id", data: "streaming-prd-run-1", transient: true },
      { type: "data-title", data: "问卷调查活动需求说明书", transient: true },
      { type: "data-clear", data: null, transient: true },
      {
        type: "data-textDelta",
        data: "问卷调查活动需求说明书##版本历史|版本|日期|作者|变更说明|",
        transient: true,
      },
    ]);
  });

  it("does not treat runtime narration as canvas document content", () => {
    expect(
      looksLikeDocumentDraft(
        [
          "我已加载技能文件。现在开始分析请求并生成PRD。思考过程：",
          "用户明确要求生成签到打卡活动PRD，指定四个部分：目标、用户流程、功能点、验收标准。",
        ].join("\n"),
        "用户明确要求生成签到打卡活动PRD",
      ),
    ).toBe(false);
  });

  it("suppresses forced document prelude instead of streaming it into canvas", () => {
    const { parts, writer } = captureWriter();
    const state = createDocumentStreamState("run-1", {
      forceDocumentStream: true,
    });

    const result = routeAssistantDocumentDelta(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk: "我已加载技能文件。现在开始分析请求并生成PRD。思考过程：",
      },
      writer,
      state,
    );

    expect(result).toEqual({ suppressChat: true });
    expect(parts).toEqual([]);
  });

  it("starts forced document streaming only from the real document title", () => {
    const { parts, writer } = captureWriter();
    const state = createDocumentStreamState("run-1", {
      forceDocumentStream: true,
    });

    routeAssistantDocumentDelta(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk: "我已加载技能文件。现在开始分析请求并生成PRD。\n",
      },
      writer,
      state,
    );

    const result = routeAssistantDocumentDelta(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk: "签到打卡活动需求说明书##版本历史|版本|日期|作者|变更说明|",
      },
      writer,
      state,
    );

    expect(result).toEqual({ suppressChat: true });
    expect(parts).toEqual([
      { type: "data-kind", data: "text", transient: true },
      { type: "data-id", data: "streaming-prd-run-1", transient: true },
      { type: "data-title", data: "签到打卡活动需求说明书", transient: true },
      { type: "data-clear", data: null, transient: true },
      {
        type: "data-textDelta",
        data: "签到打卡活动需求说明书##版本历史|版本|日期|作者|变更说明|",
        transient: true,
      },
    ]);
  });

  it("does not route ordinary answers into the artifact stream", () => {
    const { parts, writer } = captureWriter();
    const state = createDocumentStreamState("run-1");

    const result = routeAssistantDocumentDelta(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk: "你好，我可以帮你继续完善产品需求。",
      },
      writer,
      state,
    );

    expect(result).toEqual({ suppressChat: false });
    expect(parts).toEqual([]);
  });

  it("keeps ordinary audit answers in chat even when they mention full verification", () => {
    const { parts, writer } = captureWriter();
    const state = createDocumentStreamState("run-1", {
      forceDocumentStream: isDocumentGenerationRequest("现在开始全量测试系统所有细节，所有代码，给我完整详细报告"),
    });

    const result = routeAssistantDocumentDelta(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk: "我会先启动本地服务，然后覆盖前后端交互、接口、构建和依赖安全检查。",
      },
      writer,
      state,
    );

    expect(result).toEqual({ suppressChat: false });
    expect(parts).toEqual([]);
  });
});

describe("AichatStreamService stop", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    username: "user",
    displayName: "User",
    role: UserRole.user,
    status: UserStatus.active,
  };

  function createService() {
    const conversations = { get: vi.fn().mockResolvedValue({}) };
    const runLogs = { cancelRun: vi.fn().mockResolvedValue({ changed: true }) };
    const service = new AichatStreamService(
      conversations as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runLogs as never,
      {} as never,
      {} as never,
    );
    const internals = service as unknown as {
      activeRunControllers: Map<string, AbortController>;
      activeRunConversationIds: Map<string, string>;
    };
    return { conversations, internals, runLogs, service };
  }

  it("checks conversation access before stopping by run id", async () => {
    const { conversations, internals, runLogs, service } = createService();
    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    internals.activeRunControllers.set("run-1", controller);
    internals.activeRunConversationIds.set("run-1", "conversation-1");

    await expect(service.stop(user, "run-1")).resolves.toEqual({
      ok: true,
      runId: "run-1",
      canceled: true,
    });

    expect(conversations.get).toHaveBeenCalledWith(user, "conversation-1");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(runLogs.cancelRun).toHaveBeenCalledWith({
      runId: "run-1",
      canceledBy: "user-1",
      reason: "用户停止 aichat 生成",
    });
  });

  it("does not abort a run when the user cannot access its conversation", async () => {
    const { conversations, internals, runLogs, service } = createService();
    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    conversations.get.mockRejectedValueOnce(new Error("forbidden"));
    internals.activeRunControllers.set("run-1", controller);
    internals.activeRunConversationIds.set("run-1", "conversation-2");

    await expect(service.stop(user, "run-1")).rejects.toThrow(NotFoundException);

    expect(abort).not.toHaveBeenCalled();
    expect(runLogs.cancelRun).not.toHaveBeenCalled();
  });
});
