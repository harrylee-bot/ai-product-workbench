import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeerFlowRuntimeService } from "../src/ai/deerflow-runtime.service";

describe("DeerFlowRuntimeService", () => {
  const prisma = {
    deerFlowThreadBinding: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  const fetchMock = vi.fn();
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
    process.env.DEERFLOW_LANGGRAPH_URL = "http://deerflow.local";
    process.env.DEERFLOW_GATEWAY_URL = "http://gateway.local";
    process.env.DEERFLOW_STREAM_MODE = "messages-tuple";
    prisma.deerFlowThreadBinding.findUnique.mockResolvedValue(null);
    prisma.deerFlowThreadBinding.create.mockResolvedValue({
      deerFlowThreadId: "deerflow-thread-1",
    });
    prisma.deerFlowThreadBinding.update.mockResolvedValue({
      deerFlowThreadId: "deerflow-thread-2",
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...envBackup };
  });

  it("reuses the DeerFlow thread only for the same bound conversation", async () => {
    prisma.deerFlowThreadBinding.findUnique.mockResolvedValueOnce({
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      deerFlowThreadId: "deerflow-thread-existing",
    });
    fetchMock.mockResolvedValueOnce(sseResponse([
      {
        event: "messages",
        data: [
          {
            type: "AIMessageChunk",
            content: [
              "可以继续。",
              "\n```ai_product_workbench_final_action\n",
              "{\"type\":\"answer\",\"message\":\"可以继续。\",\"intent\":\"general_question\"}",
              "\n```",
            ].join(""),
          },
          { langgraph_node: "model" },
        ],
      },
      { event: "values", data: { done: true } },
    ]));

    const service = new DeerFlowRuntimeService(prisma as never);
    const result = await service.runTurn({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "继续",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://deerflow.local/threads/deerflow-thread-existing/runs/stream",
      expect.objectContaining({ method: "POST" }),
    );
    expect(prisma.deerFlowThreadBinding.create).not.toHaveBeenCalled();
    expect(result.threadId).toBe("deerflow-thread-existing");
  });

  it("creates separate DeerFlow threads for separate conversations", async () => {
    prisma.deerFlowThreadBinding.create.mockImplementation(async ({ data }) => data);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-1" }))
      .mockResolvedValueOnce(sseResponse([
        {
          event: "messages",
          data: [
            {
              type: "AIMessageChunk",
              content:
                "第一轮完成。\n```ai_product_workbench_final_action\n{\"type\":\"answer\",\"message\":\"第一轮完成。\"}\n```",
            },
            { langgraph_node: "model" },
          ],
        },
        { event: "values", data: { done: true } },
      ]))
      .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-2" }))
      .mockResolvedValueOnce(sseResponse([
        {
          event: "messages",
          data: [
            {
              type: "AIMessageChunk",
              content:
                "第二轮完成。\n```ai_product_workbench_final_action\n{\"type\":\"answer\",\"message\":\"第二轮完成。\"}\n```",
            },
            { langgraph_node: "model" },
          ],
        },
        { event: "values", data: { done: true } },
      ]));

    const service = new DeerFlowRuntimeService(prisma as never);
    const first = await service.runTurn({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "你好",
    });
    const second = await service.runTurn({
      runId: "run-2",
      projectId: "project-2",
      conversationId: "conversation-2",
      userId: "user-1",
      message: "新对话",
    });

    expect(first.threadId).toBe("deerflow-thread-1");
    expect(second.threadId).toBe("deerflow-thread-2");
    expect(prisma.deerFlowThreadBinding.findUnique).toHaveBeenNthCalledWith(1, {
      where: { conversationId: "conversation-1" },
    });
    expect(prisma.deerFlowThreadBinding.findUnique).toHaveBeenNthCalledWith(2, {
      where: { conversationId: "conversation-2" },
    });
    expect(prisma.deerFlowThreadBinding.create).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched DeerFlow thread binding instead of reusing stale context", async () => {
    prisma.deerFlowThreadBinding.findUnique.mockResolvedValueOnce({
      projectId: "project-old",
      conversationId: "conversation-1",
      userId: "user-1",
      deerFlowThreadId: "deerflow-thread-old",
    });

    const service = new DeerFlowRuntimeService(prisma as never);
    await expect(service.runTurn({
      runId: "run-1",
      projectId: "project-new",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "继续",
    })).rejects.toThrow("已拒绝复用旧上下文");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.deerFlowThreadBinding.create).not.toHaveBeenCalled();
  });

  it("creates a bound thread and parses LangGraph messages-tuple final action", async () => {
    const finalActionPayload = {
      type: "answer",
      message: "你好，我在。",
      intent: "general_question",
      requirementMode: "one_sentence_completion",
      knowledgeRefsUsed: ["01-产品架构/产品能力地图"],
      assumptions: ["普通问候不进入生成流程"],
      consistencyStrategy: "直接回答，不触发 PRD 或原型等待态。",
    };

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
                JSON.stringify(finalActionPayload),
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
    const runRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const prompt = String(runRequest.input.messages[0].content);
    expect(prompt).toContain("prototypeHtmlContract");
    expect(prompt).toContain("iframe srcDoc");
    expect(prompt).toContain("mnt/user-data/outputs/index.html");
    expect(prompt).toContain("Never output a bare HTML fragment");
    expect(prompt).toContain("<style>...complete CSS reset");
    expect(result).toEqual(expect.objectContaining({
      threadId: "deerflow-thread-1",
      finalAction: expect.objectContaining({
        type: "answer",
        message: "你好，我在。",
        intent: "general_question",
        raw: expect.objectContaining({
          requirementMode: "one_sentence_completion",
          knowledgeRefsUsed: ["01-产品架构/产品能力地图"],
          assumptions: ["普通问候不进入生成流程"],
          consistencyStrategy: "直接回答，不触发 PRD 或原型等待态。",
        }),
      }),
      finalState: { done: true },
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "收到。" }),
      expect.objectContaining({ content: expect.stringContaining("ai_product_workbench_final_action") }),
    ]));
  });

  it("parses DeerFlow messages stream chunks while hiding human and memory events", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-1" }))
      .mockResolvedValueOnce(sseResponse([
        {
          event: "messages",
          data: [
            {
              type: "human",
              content: "<memory>hidden</memory>",
              additional_kwargs: { hide_from_ui: true },
            },
            { langgraph_node: "DynamicContextMiddleware.before_agent" },
          ],
        },
        {
          event: "messages",
          data: [
            {
              type: "human",
              name: "user-input",
              content: "你好",
            },
            { langgraph_node: "DynamicContextMiddleware.before_agent" },
          ],
        },
        {
          event: "messages",
          data: [
            {
              type: "system",
              content: "hidden system prompt",
            },
            { langgraph_node: "system" },
          ],
        },
        {
          event: "messages-tuple",
          data: [
            {
              role: "assistant",
              content: "<memory>hidden memory</memory>",
            },
            { langgraph_node: "memory" },
          ],
        },
        {
          event: "messages",
          data: [
            {
              type: "AIMessageChunk",
              content: "你好",
            },
            { langgraph_node: "model" },
          ],
        },
        {
          event: "messages",
          data: [
            {
              type: "AIMessageChunk",
              content: [
                "，我在。",
                "\n```ai_product_workbench_final_action\n",
                "{\"type\":\"answer\",\"message\":\"你好，我在。\",\"intent\":\"general_question\"}",
                "\n```",
              ].join(""),
            },
            { langgraph_node: "model" },
          ],
        },
        {
          event: "values",
          data: {
            messages: [
              { type: "human", content: "你好" },
              { type: "ai", content: "你好，我在。" },
            ],
          },
        },
      ]));

    const events: Array<{ content?: string }> = [];
    const service = new DeerFlowRuntimeService(prisma as never);
    const result = await service.runTurn({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "你好",
      onEvent: (event) => {
        events.push({ content: event.content });
      },
    });

    expect(result.finalAction).toEqual(expect.objectContaining({
      type: "answer",
      message: "你好，我在。",
      intent: "general_question",
    }));
    expect(events.map((event) => event.content).filter(Boolean)).toEqual([
      "你好",
      expect.stringContaining("ai_product_workbench_final_action"),
    ]);
  });

  it("keeps reasoning out of visible assistant content", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-1" }))
      .mockResolvedValueOnce(sseResponse([
        {
          event: "messages",
          data: [
            {
              type: "AIMessageChunk",
              content: "<think>先判断任务类型</think>已开始整理。",
            },
            { langgraph_node: "model" },
          ],
        },
        {
          event: "messages",
          data: [
            {
              type: "AIMessageChunk",
              content: [
                { type: "thinking", thinking: "继续检查知识库" },
                { type: "text", text: "已开始整理。PRD 草稿完成。" },
              ],
            },
            { langgraph_node: "model" },
          ],
        },
        {
          event: "values",
          data: {
            messages: [
              {
                type: "ai",
                content: [
                  "PRD 草稿完成。",
                  "\n```ai_product_workbench_final_action\n",
                  "{\"type\":\"answer\",\"message\":\"PRD 草稿完成。\",\"intent\":\"general_question\"}",
                  "\n```",
                ].join(""),
              },
            ],
          },
        },
      ]));

    const events: Array<{ content?: string; reasoning?: string }> = [];
    const service = new DeerFlowRuntimeService(prisma as never);
    await service.runTurn({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "生成 PRD",
      onEvent: (event) => {
        events.push({ content: event.content, reasoning: event.reasoning });
      },
    });

    expect(events.map((event) => event.reasoning).filter(Boolean)).toEqual([
      "先判断任务类型",
      "继续检查知识库",
    ]);
    expect(events.map((event) => event.content).filter(Boolean)).toEqual([
      "已开始整理。",
      "PRD 草稿完成。",
    ]);
  });

  it("falls back to values final state and ignores non-assistant messages", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-1" }))
      .mockResolvedValueOnce(sseResponse([
        {
          event: "values",
          data: {
            messages: [
              { type: "human", content: "生成签到活动" },
              { type: "system", content: "hidden system prompt" },
              { type: "memory", content: "<memory>hidden</memory>" },
              {
                type: "ai",
                content: [
                  "已整理需求。",
                  "\n```ai_product_workbench_final_action\n",
                  JSON.stringify({
                    type: "review_prd",
                    message: "已整理签到活动 PRD，请确认。",
                    intent: "generate_prd",
                    requirementMode: "one_sentence_completion",
                  }),
                  "\n```",
                ].join(""),
              },
            ],
          },
        },
      ]));

    const events: Array<{ content?: string }> = [];
    const service = new DeerFlowRuntimeService(prisma as never);
    const result = await service.runTurn({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "生成签到活动",
      onEvent: (event) => {
        events.push({ content: event.content });
      },
    });

    expect(events.map((event) => event.content).filter(Boolean)).toEqual([]);
    expect(result.finalAction).toEqual(expect.objectContaining({
      type: "review_prd",
      message: "已整理签到活动 PRD，请确认。",
      intent: "generate_prd",
      raw: expect.objectContaining({
        requirementMode: "one_sentence_completion",
      }),
    }));
  });

  it("uploads local attachments and fetches final action artifacts through the Gateway", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "deerflow-runtime-"));
    const storagePath = path.join(tmp, "brief.md");
    await writeFile(storagePath, "# brief\n签到活动需求");

    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-1" }))
        .mockResolvedValueOnce(jsonResponse({
          success: true,
          files: [
            {
              filename: "brief.md",
              size: "20",
              path: "sandbox/threads/deerflow-thread-1/uploads/brief.md",
              virtual_path: "/mnt/user-data/uploads/brief.md",
              artifact_url: "/api/threads/deerflow-thread-1/artifacts/mnt/user-data/uploads/brief.md",
              markdown_virtual_path: "/mnt/user-data/uploads/brief.md",
            },
          ],
        }))
        .mockResolvedValueOnce(sseResponse([
          {
            event: "messages-tuple",
            data: [
              {
                content: [
                  "原型已生成。",
                  "\n```ai_product_workbench_final_action\n",
                  JSON.stringify({
                    type: "review_prototype",
                    message: "请查看 DeerFlow 生成的原型。",
                    intent: "generate_prototype",
                    artifacts: [
                      {
                        kind: "prototype_html",
                        title: "签到活动原型",
                        path: "mnt/user-data/outputs/index.html",
                        contentType: "text/html",
                      },
                    ],
                  }),
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
        ]))
        .mockResolvedValueOnce(new Response("<html><body>签到活动</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }));

      const events: Array<{ event: string; content?: string }> = [];
      const service = new DeerFlowRuntimeService(prisma as never);
      const result = await service.runTurn({
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        message: "根据附件生成原型",
        attachments: [{ fileId: "file-1", fileName: "brief.md" }],
        attachmentFiles: [
          {
            fileId: "file-1",
            fileName: "brief.md",
            fileType: "md",
            mimeType: "text/markdown",
            size: 20,
            storagePath,
          },
        ],
        onEvent: (event) => {
          events.push({ event: event.event, content: event.content });
        },
      });

      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://gateway.local/api/threads/deerflow-thread-1/uploads",
        expect.objectContaining({
          method: "POST",
          body: expect.any(FormData),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        4,
        "http://gateway.local/api/threads/deerflow-thread-1/artifacts/mnt/user-data/outputs/index.html",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result.uploads).toEqual([
        expect.objectContaining({
          fileId: "file-1",
          deerFlowFile: expect.objectContaining({
            virtualPath: "/mnt/user-data/uploads/brief.md",
            artifactUrl: "/api/threads/deerflow-thread-1/artifacts/mnt/user-data/uploads/brief.md",
          }),
        }),
      ]);
      expect(result.finalAction).toEqual(expect.objectContaining({
        type: "review_prototype",
        message: "请查看 DeerFlow 生成的原型。",
        artifacts: [
          expect.objectContaining({
            kind: "prototype_html",
            path: "mnt/user-data/outputs/index.html",
          }),
        ],
      }));
      expect(result.artifacts).toEqual([
        expect.objectContaining({
          path: "mnt/user-data/outputs/index.html",
          status: "fetched",
          text: "<html><body>签到活动</body></html>",
        }),
      ]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "gateway-upload", content: "已同步 1 个附件到 DeerFlow。" }),
        expect.objectContaining({ event: "gateway-artifacts", content: "已同步 1 个 DeerFlow 产物。" }),
      ]));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

	  it("replaces the bound thread and retries once when DeerFlow reports an active run", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-1" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        detail: "Thread deerflow-thread-1 already has an active run",
      }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(jsonResponse({ thread_id: "deerflow-thread-2" }))
      .mockResolvedValueOnce(sseResponse([
        {
          event: "messages-tuple",
          data: [
            {
              role: "assistant",
              content: [
                "可以继续。",
                "\n```ai_product_workbench_final_action\n",
                JSON.stringify({
                  type: "answer",
                  message: "可以继续。",
                  intent: "general_question",
                }),
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

    const service = new DeerFlowRuntimeService(prisma as never);
    const result = await service.runTurn({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "继续",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://deerflow.local/threads/deerflow-thread-1/runs/stream",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://deerflow.local/threads",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("active_run_conflict"),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://deerflow.local/threads/deerflow-thread-2/runs/stream",
      expect.objectContaining({ method: "POST" }),
    );
    expect(prisma.deerFlowThreadBinding.update).toHaveBeenCalledWith({
      where: { conversationId: "conversation-1" },
      data: expect.objectContaining({
        projectId: "project-1",
        userId: "user-1",
        deerFlowThreadId: "deerflow-thread-2",
      }),
    });
    expect(result.threadId).toBe("deerflow-thread-2");
	    expect(result.finalAction).toEqual(expect.objectContaining({
	      type: "answer",
	      message: "可以继续。",
	    }));
	  });

	  it("fails a DeerFlow stream that stays idle after headers", async () => {
	    process.env.DEERFLOW_IDLE_TIMEOUT_MS = "5";
	    prisma.deerFlowThreadBinding.findUnique.mockResolvedValueOnce({
	      projectId: "project-1",
	      conversationId: "conversation-1",
	      userId: "user-1",
	      deerFlowThreadId: "deerflow-thread-existing",
	    });
	    const encoder = new TextEncoder();
	    const reader = {
	      read: vi.fn()
	        .mockResolvedValueOnce({ value: encoder.encode(": stream-open\n\n"), done: false })
	        .mockImplementationOnce(() => new Promise(() => undefined)),
	      cancel: vi.fn().mockResolvedValue(undefined),
	    };
	    fetchMock.mockResolvedValueOnce({
	      ok: true,
	      body: {
	        getReader() {
	          return reader;
	        },
	      },
	    });

	    const service = new DeerFlowRuntimeService(prisma as never);
	    await expect(service.runTurn({
	      runId: "run-1",
	      projectId: "project-1",
	      conversationId: "conversation-1",
	      userId: "user-1",
	      message: "继续",
	    })).rejects.toThrow("DEERFLOW_STREAM_IDLE_TIMEOUT");
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
