import { describe, expect, it } from "vitest";
import {
  createBridgeContext,
  emitDeerFlowEvent,
  emitStaticText,
  finishText,
  type UIMessageStreamWriter,
} from "../src/ai/aichat/aichat-ai-sdk-bridge";

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
      { type: "text-delta", id: "text-1", delta: "你好！我在，可以继续帮你写 PRD。" },
      { type: "text-end", id: "text-1" },
    ]);
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
});
