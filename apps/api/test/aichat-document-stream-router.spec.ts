import { NotFoundException } from "@nestjs/common";
import { KnowledgeType, UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  AichatStreamService,
  assertGeneratedArtifactQaPassed,
  buildArtifactRepairPrompt,
  buildExternalResearchRuntimeEvent,
  buildModelIdleTimeoutRuntimeEvent,
  buildModelEnrichmentRuntimeEvent,
  buildModelEnrichmentStartedRuntimeEvent,
  buildCanvasDocumentRuntimePrompt,
  createDocumentStreamState,
  formatArtifactReadyMessage,
  formatQaOutcome,
  getArtifactGenerationFailureReason,
  getPrdGenerationFailureReason,
  isDocumentGenerationRequest,
  looksLikeDocumentDraft,
  routeAssistantDocumentDelta,
} from "../src/ai/aichat/aichat-stream.service";
import { GeneratedArtifactQualityError } from "../src/ai/final-action-applier.service";
import type { UIMessageStreamWriter } from "../src/ai/aichat/aichat-ai-sdk-bridge";
import type { AuthenticatedUser } from "../src/auth/auth.types";

const passedQualitySelfCheck = {
  passed: true,
  missing: [],
  stateCoverage: ["complete"],
  prdChecks: ["complete"],
  prototypeChecks: ["complete"],
  knowledgeChecks: ["complete"],
};

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
  it("builds a domain-neutral full-artifact QA repair turn with exact-label invariants", () => {
    const prompt = buildArtifactRepairPrompt(
      new GeneratedArtifactQualityError(["HTML 原型未完整覆盖产品设计状态"]),
      1,
      2,
    );

    expect(prompt).toContain("complete replacement final action");
    expect(prompt).toContain("one shared label dictionary");
    expect(prompt).toContain("At least 75%");
    expect(prompt).toContain("/mnt/user-data/outputs/index.html");
    expect(prompt).toContain("Actually call write_file");
    expect(prompt).toContain("HTML 原型未完整覆盖产品设计状态");
    expect(prompt).not.toMatch(/签到|积分|奖品|预约|素材/);
  });

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

  it("describes non-blocking QA warnings without calling them missing deliverables", () => {
    expect(formatQaOutcome(qaReport("passed"))).toBe("QA 通过");
    expect(formatQaOutcome(qaReport("warning"))).toBe("QA 通过，存在非阻塞待确认项");
    expect(formatQaOutcome(qaReport("failed"))).toBe("QA 未通过");
  });

  it("blocks delivery when deterministic post-persistence QA fails", () => {
    expect(() => assertGeneratedArtifactQaPassed({
      status: "failed",
      issues: [{ severity: "major", title: "原型未完整覆盖产品设计状态" }],
    } as never)).toThrow("GENERATED_ARTIFACT_QUALITY_FAILED");
  });

  it("formats final artifact messages with titles and without runtime noise", () => {
    const message = formatArtifactReadyMessage({
      prdTitle: "签到领积分活动需求说明书\nread_file SKILL.md",
      prototypeTitle: "签到领积分活动原型\nContext from AI Product Workbench:",
      qaReport: qaReport("passed"),
    });

    expect(message).toBe("PRD《签到领积分活动需求说明书》和原型《签到领积分活动原型》已生成，QA 通过。请在右侧画布查看和继续修改。");
    expect(message).not.toMatch(/read_file|Context from AI Product Workbench|tool-input|tool-output|Updated todo list/);
  });

  it("formats model and public-research runtime events as clean user-facing progress", () => {
    const externalEvent = buildExternalResearchRuntimeEvent({
      runId: "run-1",
      context: {
        status: "completed",
        fetchedAt: "2026-07-08T00:00:00.000Z",
        searchQueries: ["签到积分活动 会员运营 最佳实践"],
        refs: [
          {
            query: "签到积分活动 会员运营 最佳实践",
            title: "Building an Effective Loyalty Program\nread_file secret.md",
            url: "https://mailchimp.com/resources/loyalty-programs/",
            insight: "会员体系可用积分承载奖励。",
            source: "public_web_fetch",
            contentLength: 1000,
            fetchedAt: "2026-07-08T00:00:00.000Z",
          },
        ],
        failures: [],
        privacyBoundary: ["不发送内部路径。"],
      },
    });
    const failedExternalEvent = buildExternalResearchRuntimeEvent({
      runId: "run-1",
      context: {
        status: "failed_non_blocking",
        fetchedAt: "2026-07-08T00:00:00.000Z",
        searchQueries: ["积分权益 发放 幂等 风控 资损"],
        refs: [],
        failures: [{ error: "network timeout" }],
        privacyBoundary: ["不发送内部路径。"],
      },
    });
    const modelStartedEvent = buildModelEnrichmentStartedRuntimeEvent("run-1");
    const modelEvent = buildModelEnrichmentRuntimeEvent({
      runId: "run-1",
      finalAction: {
        type: "review_prd",
        parsed: true,
        message: "PRD 已生成。",
        raw: {
          enrichmentNotes: [
            "知识库给出活动配置闭环。",
            "read_file SKILL.md",
            "模型补齐默认签到状态和异常处理。",
          ],
        },
      },
    });

    expect(externalEvent).toEqual(expect.objectContaining({
      label: "已用公开资料补齐 1 条",
      detail: "· Building an Effective Loyalty Program",
    }));
    expect(failedExternalEvent).toEqual(expect.objectContaining({
      label: "公开资料补齐暂不可用，已继续生成",
    }));
    expect(modelStartedEvent).toEqual(expect.objectContaining({
      label: "正在用模型补齐业务细节",
      detail: expect.stringContaining("补齐默认流程"),
      status: "running",
    }));
    expect(modelEvent).toEqual(expect.objectContaining({
      label: "已用模型补齐业务细节",
      detail: "· 知识库给出活动配置闭环。\n· 模型补齐默认签到状态和异常处理。",
    }));
    expect(`${externalEvent.detail}\n${failedExternalEvent.detail}\n${modelStartedEvent.detail}\n${modelEvent.detail}`).not.toMatch(/read_file|Context from AI Product Workbench|tool-input|tool-output|Updated todo list/);
  });

  it("reports idle timeout instead of creating fallback PRD/prototype content", () => {
    const event = buildModelIdleTimeoutRuntimeEvent("run-1");

    expect(event).toEqual(expect.objectContaining({
      id: "model-enrichment-idle-timeout",
      label: "模型长时间无返回，已停止生成",
      status: "failed",
    }));
    expect(event.detail).toContain("不会生成兜底 PRD 或原型");
  });

  it("fails PRD generation instead of creating fallback content when the final action is missing", () => {
    expect(
      getPrdGenerationFailureReason({
        expectsPrdDocument: true,
        artifacts: [],
        finalAction: {
          type: "answer",
          parsed: false,
          message: "我已经生成了需求文档，请查看右侧画布。",
        },
      }),
    ).toBe("模型未返回可解析的最终动作");
  });

  it("fails PRD generation when the model returns a non-PRD final action", () => {
    expect(
      getPrdGenerationFailureReason({
        expectsPrdDocument: true,
        artifacts: [],
        finalAction: {
          type: "answer",
          parsed: true,
          message: "可以生成需求文档。",
          raw: { type: "answer" },
        },
      }),
    ).toBe("模型未返回产物最终动作");
  });

  it("fails PRD generation when review_prd has no document body", () => {
    expect(
      getPrdGenerationFailureReason({
        expectsPrdDocument: true,
        artifacts: [],
        finalAction: {
          type: "review_prd",
          parsed: true,
          message: "已生成《营销日历需求说明书》，请在右侧画布查看。",
          raw: { type: "review_prd", prdDocumentDraft: { title: "营销日历需求说明书" } },
        },
      }),
    ).toBe("模型未返回完整需求文档正文");
  });

  it("accepts review_prd only when it carries usable sections or a PRD markdown artifact", () => {
    expect(
      getPrdGenerationFailureReason({
        expectsPrdDocument: true,
        artifacts: [],
        finalAction: {
          type: "review_prd",
          parsed: true,
          message: "PRD 已生成。",
          raw: {
            type: "review_prd",
            qualitySelfCheck: passedQualitySelfCheck,
            prdDocumentDraft: {
              title: "营销日历需求说明书",
              sections: [
                {
                  id: "background",
                  title: "1.1 项目背景",
                  content: "营销日历需要支持活动排期、资源位占用、审核发布和复盘归因，帮助运营统一管理营销节奏。",
                },
              ],
            },
          },
        },
      }),
    ).toBeUndefined();

    expect(
      getPrdGenerationFailureReason({
        expectsPrdDocument: true,
        artifacts: [],
        finalAction: {
          type: "review_prototype",
          parsed: true,
          message: "PRD 和原型已生成。",
          raw: {
            type: "review_prototype",
            qualitySelfCheck: passedQualitySelfCheck,
            prdDocumentDraft: {
              title: "签到领积分活动需求说明书",
              sections: [
                {
                  id: "background",
                  title: "1.1 项目背景",
                  content: "签到领积分活动需要通过后台配置、用户每日签到、积分发放、重复领取限制、审核发布和数据报表形成完整闭环。",
                },
              ],
            },
            prototypeSpec: { title: "签到领积分活动原型" },
          },
        },
      }),
    ).toBeUndefined();

    expect(
      getPrdGenerationFailureReason({
        expectsPrdDocument: true,
        finalAction: {
          type: "review_prd",
          parsed: true,
          message: "PRD 已生成。",
          raw: { type: "review_prd", qualitySelfCheck: passedQualitySelfCheck },
        },
        artifacts: [
          {
            kind: "prd_markdown",
            title: "营销日历需求说明书.md",
            path: "/tmp/prd.md",
            artifactUrl: "file:///tmp/prd.md",
            contentType: "text/markdown",
            status: "fetched",
            text: "## 1 引言\n营销日历用于管理活动排期、渠道资源、审核发布和复盘归因。",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("requires an artifact quality self-check before persistence", () => {
    expect(getPrdGenerationFailureReason({
      expectsPrdDocument: true,
      artifacts: [],
      finalAction: {
        type: "review_prd",
        parsed: true,
        message: "PRD 已生成。",
        raw: {
          type: "review_prd",
          prdDocumentDraft: {
            title: "门店预约需求说明书",
            sections: [{ id: "background", title: "1.1 项目背景", content: "门店预约需要覆盖后台门店配置、前台预约提交、容量限制、异常处理和数据查询。" }],
          },
        },
      },
    })).toBe("模型未通过产物质量自检");

    expect(getPrdGenerationFailureReason({
      expectsPrdDocument: true,
      artifacts: [],
      finalAction: {
        type: "review_prd",
        parsed: true,
        message: "PRD 已生成。",
        raw: {
          type: "review_prd",
          qualitySelfCheck: { ...passedQualitySelfCheck, passed: false, missing: ["异常场景"] },
          prdDocumentDraft: {
            title: "门店预约需求说明书",
            sections: [{ id: "background", title: "1.1 项目背景", content: "门店预约需要覆盖后台门店配置、前台预约提交、容量限制、异常处理和数据查询。" }],
          },
        },
      },
    })).toBe("模型未通过产物质量自检");

    expect(getPrdGenerationFailureReason({
      expectsPrdDocument: true,
      artifacts: [],
      finalAction: {
        type: "review_prd",
        parsed: true,
        message: "PRD 已生成。",
        raw: {
          type: "review_prd",
          qualitySelfCheck: { passed: true, missing: [], stateCoverage: [], prdChecks: [], knowledgeChecks: [] },
          prdDocumentDraft: {
            title: "门店预约需求说明书",
            sections: [{ id: "background", title: "1.1 项目背景", content: "门店预约需要覆盖后台门店配置、前台预约提交、容量限制、异常处理和数据查询。" }],
          },
        },
      },
    })).toBe("模型未返回完整产物质量自检明细");
  });

  it("fails combined PRD/prototype generation when the prototype HTML is missing", () => {
    const finalAction = {
      type: "review_prd" as const,
      parsed: true,
      message: "PRD 已生成。",
      raw: {
        type: "review_prd",
        qualitySelfCheck: passedQualitySelfCheck,
        prdDocumentDraft: {
          title: "签到领积分活动需求说明书",
          sections: [
            {
              id: "background",
              title: "1.1 项目背景",
              content: "签到领积分活动需要覆盖后台配置、前台签到、积分发放、异常补偿和数据报表。",
            },
          ],
        },
      },
    };

    expect(
      getArtifactGenerationFailureReason({
        expectsPrdDocument: true,
        expectsPrototype: true,
        artifacts: [],
        finalAction,
      }),
    ).toBe("模型未返回完整原型 HTML");

    expect(
      getArtifactGenerationFailureReason({
        expectsPrdDocument: true,
        expectsPrototype: true,
        finalAction: {
          ...finalAction,
          type: "review_prototype",
          raw: {
            ...finalAction.raw,
            type: "review_prototype",
            qualitySelfCheck: passedQualitySelfCheck,
            prototypeSpec: { title: "签到领积分活动原型" },
          },
        },
        artifacts: [{
          kind: "prototype_html",
          title: "index.html",
          path: "mnt/user-data/outputs/index.html",
          artifactUrl: "/api/artifacts/index.html",
          contentType: "text/html",
          status: "fetched",
          text: `<!doctype html><html lang="zh-CN"><head><style>body{font-family:sans-serif}.panel{display:grid;padding:16px}</style></head><body><main class="panel">${"签到领积分活动".repeat(40)}</main></body></html>`,
        }],
      }),
    ).toBeUndefined();
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
    const conversations = { getOwnedConversation: vi.fn().mockResolvedValue({}) };
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

    expect(conversations.getOwnedConversation).toHaveBeenCalledWith("user-1", "conversation-1");
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
    conversations.getOwnedConversation.mockRejectedValueOnce(new Error("forbidden"));
    internals.activeRunControllers.set("run-1", controller);
    internals.activeRunConversationIds.set("run-1", "conversation-2");

    await expect(service.stop(user, "run-1")).rejects.toThrow(NotFoundException);

    expect(abort).not.toHaveBeenCalled();
    expect(runLogs.cancelRun).not.toHaveBeenCalled();
  });

  it("does not let an admin stop another user's run through an ordinary route", async () => {
    const { conversations, internals, runLogs, service } = createService();
    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    const admin: AuthenticatedUser = {
      ...user,
      id: "admin-1",
      role: UserRole.admin,
    };
    conversations.getOwnedConversation.mockRejectedValueOnce(new Error("forbidden"));
    internals.activeRunControllers.set("run-1", controller);
    internals.activeRunConversationIds.set("run-1", "conversation-2");

    await expect(service.stop(admin, "run-1")).rejects.toThrow(NotFoundException);

    expect(conversations.getOwnedConversation).toHaveBeenCalledWith("admin-1", "conversation-2");
    expect(abort).not.toHaveBeenCalled();
    expect(runLogs.cancelRun).not.toHaveBeenCalled();
  });
});

describe("AichatStreamService knowledge retrieval", () => {
  function createServiceWithKnowledgeSearch(search = vi.fn().mockResolvedValue({
    references: [],
  })) {
    return new AichatStreamService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { search } as never,
      {} as never,
      {} as never,
    ) as unknown as {
      searchKnowledgeForChat(input: {
        conversationId: string;
        runId: string;
        message: string;
        hasExistingState?: boolean;
      }): Promise<unknown>;
    };
  }

  it("uses the runtime-generation vault policy and expanded query for one-sentence PRD/prototype requests", async () => {
    const search = vi.fn().mockResolvedValue({ references: [] });
    const service = createServiceWithKnowledgeSearch(search);

    await service.searchKnowledgeForChat({
      conversationId: "conversation-1",
      runId: "run-store-booking",
      message: "我想做一个门店预约功能，请根据知识库内容生成需求文档和原型",
      hasExistingState: false,
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      runId: "run-store-booking",
      runtimeName: "runtime_generation",
      requirementMode: "one_sentence_completion",
      vaultPolicy: "always",
      limit: 10,
      preferredTypes: expect.arrayContaining([
        KnowledgeType.business_concept,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.prototype_rule,
        KnowledgeType.prototype_asset_ref,
      ]),
    }));
    const query = search.mock.calls[0]?.[0].query;
    expect(query).toContain("我想做一个门店预约功能");
    expect(query).toContain("PRD标准结构");
    expect(query).toContain("原型生成总规则");
    expect(query).toContain("当前业务域强规则");
    expect(query).toContain("前后台页面框架");
    expect(query).toContain("Axure");
    expect(query).not.toContain("贵州签到打卡HTML原型");
  });
});

describe("AichatStreamService knowledge retrieval", () => {
  function createServiceWithKnowledgeSearch(search = vi.fn().mockResolvedValue({
    references: [],
  })) {
    return new AichatStreamService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { search } as never,
      {} as never,
      {} as never,
    ) as unknown as {
      searchKnowledgeForChat(input: {
        conversationId: string;
        runId: string;
        message: string;
        hasExistingState?: boolean;
      }): Promise<unknown>;
    };
  }

  it("uses the runtime-generation vault policy and expanded query for one-sentence PRD/prototype requests", async () => {
    const search = vi.fn().mockResolvedValue({ references: [] });
    const service = createServiceWithKnowledgeSearch(search);

    await service.searchKnowledgeForChat({
      conversationId: "conversation-1",
      runId: "run-store-booking",
      message: "我想做一个门店预约功能，请根据知识库内容生成需求文档和原型",
      hasExistingState: false,
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      runId: "run-store-booking",
      runtimeName: "runtime_generation",
      requirementMode: "one_sentence_completion",
      vaultPolicy: "always",
      limit: 10,
      preferredTypes: expect.arrayContaining([
        KnowledgeType.business_concept,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.prototype_rule,
        KnowledgeType.prototype_asset_ref,
      ]),
    }));
    const query = search.mock.calls[0]?.[0].query;
    expect(query).toContain("我想做一个门店预约功能");
    expect(query).toContain("PRD标准结构");
    expect(query).toContain("原型生成总规则");
    expect(query).toContain("当前业务域强规则");
    expect(query).toContain("前后台页面框架");
    expect(query).toContain("Axure");
    expect(query).not.toContain("贵州签到打卡HTML原型");
  });
});
