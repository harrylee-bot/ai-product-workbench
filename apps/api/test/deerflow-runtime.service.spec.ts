import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeerFlowRuntimeService } from "../src/ai/deerflow-runtime.service";

describe("DeerFlowRuntimeService", () => {
  const prisma = {
    deerFlowThreadBinding: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
  const fetchMock = vi.fn();
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
    process.env.DEERFLOW_LANGGRAPH_URL = "http://deerflow.local";
    process.env.DEERFLOW_STREAM_MODE = "messages-tuple";
    prisma.deerFlowThreadBinding.findUnique.mockResolvedValue(null);
    prisma.deerFlowThreadBinding.create.mockResolvedValue({
      deerFlowThreadId: "deerflow-thread-1",
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...envBackup };
  });

  it("creates a bound thread and parses LangGraph messages-tuple final action", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-1" }))
      .mockResolvedValueOnce(sseResponse([
        {
          event: "messages-tuple",
          data: [{ content: "收到。" }, { node: "lead_agent" }],
        },
        {
          event: "messages-tuple",
          data: [
            {
              content: [
                "\n```ai_product_workbench_final_action\n",
                "{\"type\":\"answer\",\"message\":\"你好，我在。\",\"intent\":\"general_question\"}",
                "\n```",
              ].join(""),
            },
            { node: "lead_agent" },
          ],
        },
        {
          event: "values",
          data: { done: true },
        },
      ]));

    const events: Array<{ content?: string; toolName?: string }> = [];
    const service = new DeerFlowRuntimeService(prisma as never);
    const result = await service.runTurn({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "你好",
      onEvent: (event) => {
        events.push({ content: event.content, toolName: event.toolName });
      },
    });

    expect(prisma.deerFlowThreadBinding.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        deerFlowThreadId: "deerflow-thread-1",
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://deerflow.local/threads",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://deerflow.local/threads/deerflow-thread-1/runs/stream",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual(expect.objectContaining({
      threadId: "deerflow-thread-1",
      finalAction: expect.objectContaining({
        type: "answer",
        message: "你好，我在。",
        intent: "general_question",
      }),
      finalState: { done: true },
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "收到。" }),
      expect.objectContaining({ content: expect.stringContaining("ai_product_workbench_final_action") }),
    ]));
  });
});

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: Array<{ event: string; data: unknown }>) {
  const body = events
    .map((event) => [
      `event: ${event.event}`,
      `data: ${JSON.stringify(event.data)}`,
      "",
    ].join("\n"))
    .join("\n");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
