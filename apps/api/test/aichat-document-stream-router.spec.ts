import { describe, expect, it } from "vitest";
import {
  createDocumentStreamState,
  isDocumentGenerationRequest,
  looksLikeDocumentDraft,
  routeAssistantDocumentDelta,
} from "../src/ai/aichat/aichat-stream.service";
import type { UIMessageStreamWriter } from "../src/ai/aichat/aichat-ai-sdk-bridge";

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
    expect(isDocumentGenerationRequest("这份需求文档有哪些风险？")).toBe(false);
  });

  it("recognizes compact requirement specs with adjacent markdown headings", () => {
    expect(
      looksLikeDocumentDraft(
        "问卷调查活动需求说明书##版本历史|版本|日期|作者|变更说明|",
        "问卷调查活动需求说明书##版本历史|版本|日期|作者|变更说明|",
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
});
