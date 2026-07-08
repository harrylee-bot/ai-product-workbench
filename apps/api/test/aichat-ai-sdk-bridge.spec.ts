import { describe, expect, it } from "vitest";
import {
  createBridgeContext,
  emitDeerFlowEvent,
  emitPrdDocumentPreview,
  emitRuntimeEvent,
  emitRuntimeStart,
  emitStaticText,
  finishText,
  runtimeEventsFromDeerFlow,
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
      { exposeToolParts: true },
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
      { exposeToolParts: true },
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

  it("keeps tool calls internal by default", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    emitDeerFlowEvent(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        toolCalls: [{ id: "tool-default", name: "write_todos", args: { items: [] } }],
      },
      writer,
      ctx,
    );
    emitDeerFlowEvent(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "tool",
        toolCallId: "tool-default",
        toolResult: "Updated todo list",
      },
      writer,
      ctx,
    );

    expect(parts).toEqual([]);
    expect(ctx.emittedToolCallIds.has("tool-default")).toBe(true);
  });

  it("records tool calls without exposing noisy tool parts in quiet mode", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    emitDeerFlowEvent(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        toolCalls: [{ id: "tool-quiet", name: "read_file", args: { path: "SKILL.md" } }],
      },
      writer,
      ctx,
      { exposeToolParts: false },
    );
    emitDeerFlowEvent(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "tool",
        toolCallId: "tool-quiet",
        toolResult: "# huge skill file content",
      },
      writer,
      ctx,
      { exposeToolParts: false },
    );

    expect(parts).toEqual([]);
    expect(ctx.emittedToolCallIds.has("tool-quiet")).toBe(true);
  });

  it("keeps the serialized user stream clean while preserving knowledge events", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    emitRuntimeStart(writer, {
      runId: "run-clean",
      status: "running",
      startedAt: "2026-07-08T00:00:00.000Z",
      events: [],
    });
    emitRuntimeEvent(writer, {
      id: "run-clean:knowledge-complete",
      runId: "run-clean",
      kind: "knowledge",
      label: "已用知识库打底，命中 4 条",
      detail: "活动发布与模板配置\n奖品券与资损核销",
      status: "completed",
      createdAt: "2026-07-08T00:00:01.000Z",
    });

    const toolInputEvent = {
      event: "messages-tuple",
      data: {},
      messageRole: "assistant" as const,
      toolCalls: [{ id: "tool-noise", name: "read_file", args: { path: "SKILL.md" } }],
    };
    const toolOutputEvent = {
      event: "messages-tuple",
      data: {},
      messageRole: "tool" as const,
      toolCallId: "tool-noise",
      toolResult: "Context from AI Product Workbench\nUpdated todo list",
    };

    for (const runtimeEvent of runtimeEventsFromDeerFlow(toolInputEvent, ctx, "run-clean", {
      exposeToolEvents: false,
    })) {
      emitRuntimeEvent(writer, runtimeEvent);
    }
    emitDeerFlowEvent(toolInputEvent, writer, ctx);
    emitDeerFlowEvent(toolOutputEvent, writer, ctx);
    emitStaticText("已生成需求文档和原型，可在右侧继续查看。", writer, ctx);
    finishText(writer, ctx);

    const rawStream = parts.map((part) => `data: ${JSON.stringify(part)}`).join("\n\n");

    expect(rawStream).toContain("已用知识库打底，命中 4 条");
    expect(rawStream).toContain("已生成需求文档和原型");
    expect(rawStream).not.toMatch(/tool-input|tool-output|read_file|write_todos|write_file|Updated todo list|Context from AI Product Workbench/);
    expect(ctx.toolParts.get("tool-noise")).toEqual(expect.objectContaining({
      toolName: "read_file",
      state: "output-available",
    }));
  });

  it("filters assistant runtime narration from visible chat text", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    emitDeerFlowEvent(
      {
        event: "messages-tuple",
        data: {},
        messageRole: "assistant",
        chunk: "我已加载技能文件。现在开始分析请求并生成 PRD。",
        content: "我已加载技能文件。现在开始分析请求并生成 PRD。",
      },
      writer,
      ctx,
    );
    finishText(writer, ctx);

    expect(parts).toEqual([]);
    expect(ctx.textBuffer).toBe("");
  });

  it("filters split runtime narration before emitting visible answer text", () => {
    const ctx = createBridgeContext();
    const { parts, writer } = captureWriter();

    for (const chunk of [
      "我",
      "已加载技",
      "能文件。现在开始分析请求。\n",
      "已根据知识库生成 PRD 和原型。",
    ]) {
      emitDeerFlowEvent(
        {
          event: "messages-tuple",
          data: {},
          messageRole: "assistant",
          chunk,
          content: chunk,
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
        delta: "已根据知识库生成 PRD 和原型。",
      },
      { type: "text-end", id: "text-1" },
    ]);
    expect(ctx.textBuffer).toBe("已根据知识库生成 PRD 和原型。");
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
