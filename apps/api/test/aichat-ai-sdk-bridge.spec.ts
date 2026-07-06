import { describe, expect, it } from "vitest";
import {
  createBridgeContext,
  emitDeerFlowEvent,
  emitPrdDocumentPreview,
  emitStaticText,
  finishText,
  type UIMessageStreamWriter,
} from "../src/ai/aichat/aichat-ai-sdk-bridge";
import type { RequirementDocument } from "../src/ai/ai-vibe.types";

function captureWriter() {
  const parts: Record<string, unknown>[] = [];
  const writer: UIMessageStreamWriter = {
    write: (part) => {
      parts.push(part);
    },
  };
  return { parts, writer };
}

describe("aichat AI SDK bridge", () => {
  it("hides split final action blocks and does not emit synthetic steps for plain text", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    for (const chunk of [
      "你好！我在，可以继续帮你写 PRD。",
      "\n``",
      "`ai_product_",
      "workbench_final_action\n",
      JSON.stringify({
        type: "answer",
        message: "你好！我在，可以继续帮你写 PRD。",
        intent: "greeting",
        requirementMode: "one_sentence_completion",
      }),
      "\n```",
    ]) {
      emitDeerFlowEvent(
        {
          event: "messages-tuple",
          data: {},
          messageRole: "assistant",
          chunk,
          content: chunk,
          nodeName: "lead_agent",
        },
        writer,
        ctx,
      );
    }

    finishText(writer, ctx);

    expect(parts).toEqual([
      { type: "text-start", id: "text-1" },
      {
        type: "text-delta",
        id: "text-1",
        delta: "你好！我在，可以继续帮你写 PRD。",
      },
      { type: "text-end", id: "text-1" },
    ]);
    expect(ctx.textBuffer).toBe("你好！我在，可以继续帮你写 PRD。");
    expect(ctx.hasEmittedText).toBe(true);
  });

  it("marks static fallback text as emitted", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    emitStaticText("本轮未生成产物。", writer, ctx);
    finishText(writer, ctx);

    expect(ctx.hasEmittedText).toBe(true);
    expect(parts).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "本轮未生成产物。" },
      { type: "text-end", id: "text-1" },
    ]);
  });

  it("uses a fresh text id after a text block has ended", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    emitStaticText("前置文本", writer, ctx);
    finishText(writer, ctx);
    emitStaticText("最终摘要", writer, ctx);
    finishText(writer, ctx);

    expect(parts).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "前置文本" },
      { type: "text-end", id: "text-1" },
      { type: "text-start", id: "text-2" },
      { type: "text-delta", id: "text-2", delta: "最终摘要" },
      { type: "text-end", id: "text-2" },
    ]);
  });

  it("skips tool outputs that have no matching tool input", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    emitDeerFlowEvent(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "tool",
        toolCallId: "missing-tool-call",
        toolResult: "orphan result",
      },
      writer,
      ctx,
    );

    expect(parts).toEqual([]);
  });

  it("emits tool outputs after the matching tool input", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    emitDeerFlowEvent(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        toolCalls: [{ id: "tool-1", name: "search", args: { query: "签到" } }],
      },
      writer,
      ctx,
    );
    emitDeerFlowEvent(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "tool",
        toolCallId: "tool-1",
        toolResult: "done",
      },
      writer,
      ctx,
    );

    expect(parts).toEqual([
      { type: "tool-input-start", toolCallId: "tool-1", toolName: "search" },
      {
        type: "tool-input-available",
        toolCallId: "tool-1",
        toolName: "search",
        input: { query: "签到" },
      },
      {
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: "done",
      },
    ]);
  });

  it("emits PRD document preview using the createDocument tool shape", () => {
    const { parts, writer } = captureWriter();

    emitPrdDocumentPreview(
      {
        id: "prd-1",
        title: "签到活动 PRD",
      } as RequirementDocument,
      writer,
    );

    expect(parts).toEqual([
      {
        type: "tool-input-start",
        toolCallId: "prd-document-prd-1",
        toolName: "createDocument",
      },
      {
        type: "tool-input-available",
        toolCallId: "prd-document-prd-1",
        toolName: "createDocument",
        input: { title: "签到活动 PRD", kind: "text" },
      },
      {
        type: "tool-output-available",
        toolCallId: "prd-document-prd-1",
        output: { id: "prd-1", title: "签到活动 PRD", kind: "text" },
      },
    ]);
  });
});
