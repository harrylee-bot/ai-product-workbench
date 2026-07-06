import { NotFoundException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  AichatStreamService,
  buildCanvasDocumentRuntimePrompt,
  buildFallbackPrdFinalAction,
  createDocumentStreamState,
  formatQaOutcome,
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
    expect(isDocumentGenerationRequest("请生成PRD，不要生成原型")).toBe(true);
    expect(
      isDocumentGenerationRequest(
        "请生成一份会员积分商城 PRD，只生成需求文档，不生成原型。不要把工具调用、文件加载、Claude、read_file 等运行日志写进需求文档。",
      ),
    ).toBe(true);
    expect(isDocumentGenerationRequest("这份需求文档有哪些风险？")).toBe(false);
    expect(isDocumentGenerationRequest("请用一句话说明当前系统是否在线，不要生成PRD。")).toBe(false);
    expect(isDocumentGenerationRequest("不要生成 PRD，只回答运行状态")).toBe(false);
  });

  it("turns canvas mode prompts into document generation requests without changing the visible prompt", () => {
    const prompt = "做一个会员积分商城";
    const runtimePrompt = buildCanvasDocumentRuntimePrompt(prompt);

    expect(runtimePrompt).toContain(prompt);
    expect(runtimePrompt).toContain("review_prd");
    expect(isDocumentGenerationRequest(prompt)).toBe(false);
    expect(isDocumentGenerationRequest(runtimePrompt)).toBe(true);
  });

  it("recognizes compact requirement specs with adjacent markdown headings", () => {
    expect(
      looksLikeDocumentDraft(
        "问卷调查活动需求说明书##版本历史|版本|日期|作者|变更说明|",
        "问卷调查活动需求说明书##版本历史|版本|日期|作者|变更说明|",
      ),
    ).toBe(true);
  });

  it("routes PRD block source snippets that start with mermaid blocks", () => {
    expect(
      looksLikeDocumentDraft(
        "mermaid\nflowchart TD\nA[用户参与活动] --> B[生成交易快照]",
        "mermaid\nflowchart TD\nA[用户参与活动] --> B[生成交易快照]",
      ),
    ).toBe(true);
  });

  it("does not start document streaming from loose structured JSON blocks", () => {
    expect(
      looksLikeDocumentDraft(
        '{"type":"table","title":"页面异常态要求","content":"| 异常态 | 处理要求 |"}',
        '{"type":"table","title":"页面异常态要求","content":"| 异常态 | 处理要求 |"}',
      ),
    ).toBe(false);
    // sections JSON 属于 final action / artifact 原料，不应裸渲染到画布。
    expect(
      looksLikeDocumentDraft(
        '{"id":"data_review","title":"2.9 数据复盘","type":"section","level":2,"order":16,"content":"交易快照需要支持基础统计","sourcePaths":["summary"]}',
        '{"id":"data_review","title":"2.9 数据复盘","type":"section","level":2,"order":16,"content":"交易快照需要支持基础统计","sourcePaths":["summary"]}',
      ),
    ).toBe(false);
    // businessRules、acceptanceCriteria 等 PRD 专属字段也等待最终动作解析。
    expect(
      looksLikeDocumentDraft(
        '{"acceptanceCriteria":[{"id":"ac1","title":"验收标准1"}]}',
        '{"acceptanceCriteria":[{"id":"ac1","title":"验收标准1"}]}',
      ),
    ).toBe(false);
  });

  it("suppresses loose structured JSON during forced document generation without opening canvas", () => {
    const { parts, writer } = captureWriter();
    const state = createDocumentStreamState("run-1", {
      forceDocumentStream: true,
    });

    const result = routeAssistantDocumentDelta(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk: '{"type":"table","title":"页面异常态要求","content":"| 异常态 | 处理要求 |"}',
      },
      writer,
      state,
    );

    expect(result).toEqual({ suppressChat: true });
    expect(parts).toEqual([]);
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

  it("does not treat completion summaries as PRD canvas body", () => {
    const summary =
      "已生成《营销日历需求说明书》，覆盖营销日历的运营排期、节点规划、资源占用、权益库存联动、审核发布、复盘归因、接口联动、降级方案与安全基线，可在右侧 PRD 画布中继续评审和修改。";

    expect(looksLikeDocumentDraft(summary, summary)).toBe(false);
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

  it("suppresses forced completion summaries without opening the canvas", () => {
    const { parts, writer } = captureWriter();
    const state = createDocumentStreamState("run-1", {
      forceDocumentStream: true,
    });

    const result = routeAssistantDocumentDelta(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk:
          "已生成《营销日历需求说明书》，覆盖营销日历的运营排期、节点规划、资源占用、权益库存联动、审核发布、复盘归因、接口联动、降级方案与安全基线，可在右侧 PRD 画布中继续评审和修改。",
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

  it("describes non-blocking QA warnings without failure wording", () => {
    expect(formatQaOutcome(qaReport("passed"))).toBe("QA 通过");
    expect(formatQaOutcome(qaReport("warning"))).toBe("QA 通过，有待补充项");
    expect(formatQaOutcome(qaReport("failed"))).toBe("QA 未通过");
  });

  it("builds a structured fallback PRD final action when DeerFlow omits final action", () => {
    const finalAction = buildFallbackPrdFinalAction("请生成一份会员积分商城 PRD，只生成需求文档，包含目标、用户流程、功能需求、验收标准。");
    const raw = finalAction.raw as {
      prdDocumentDraft?: { title?: string; sections?: Array<{ title: string; content: string }> };
    };

    expect(finalAction).toEqual(expect.objectContaining({
      type: "review_prd",
      parsed: true,
      message: expect.stringContaining("结构化 PRD 草稿"),
    }));
    expect(raw.prdDocumentDraft?.title).toContain("会员积分商城");
    expect(raw.prdDocumentDraft?.sections?.map((section) => section.title)).toEqual(
      expect.arrayContaining([
        "1 引言",
        "2 业务需求",
        "2.5 验收标准",
        "3 业务降级方案（必填）",
        "4 需求安全基线要求（必填）",
      ]),
    );
    const body = raw.prdDocumentDraft?.sections?.map((section) => section.content).join("\n") ?? "";
    expect(body).toContain("会员积分商城详情/确认页");
    expect(body).toContain("会员积分商城记录页");
    expect(body).toContain("运行说明不写入需求正文");
    expect(body).not.toContain("思考过程");
  });

  it("keeps fallback PRD titles focused on the business subject", () => {
    const finalAction = buildFallbackPrdFinalAction(
      "请生成一份会员积分商城 PRD，只生成需求文档，不生成原型。要求包含业务目标、目标用户、用户流程、功能需求、字段与状态、验收标准、风控和埋点。",
    );
    const raw = finalAction.raw as {
      prdDocumentDraft?: { title?: string };
    };

    expect(raw.prdDocumentDraft?.title).toBe("会员积分商城需求说明书");
  });

  it("cleans trailing particles from fallback PRD subjects", () => {
    const finalAction = buildFallbackPrdFinalAction(
      "帮我生成一个营销日历的需求文档，输出中文执行摘要和需求结构",
    );
    const raw = finalAction.raw as {
      prdDocumentDraft?: { title?: string; sections?: Array<{ content: string }> };
    };
    const body = raw.prdDocumentDraft?.sections?.map((section) => section.content).join("\n") ?? "";

    expect(raw.prdDocumentDraft?.title).toBe("营销日历需求说明书");
    expect(body).toContain("营销日历的业务目标");
    expect(body).not.toContain("营销日历的的");
  });
});

function qaReport(status: "passed" | "warning" | "failed") {
  return { status } as Parameters<typeof formatQaOutcome>[0];
}

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
