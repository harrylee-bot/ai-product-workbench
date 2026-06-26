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
