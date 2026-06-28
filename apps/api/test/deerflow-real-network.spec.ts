import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeerFlowRuntimeService } from "../src/ai/deerflow-runtime.service";

const shouldRun = process.env.DEERFLOW_REAL_NETWORK_TEST === "true";
const describeRealNetwork = shouldRun ? describe : describe.skip;

describeRealNetwork("DeerFlowRuntimeService real network smoke", () => {
  const prisma = {
    deerFlowThreadBinding: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
    if (!process.env.DEERFLOW_LANGGRAPH_URL) throw new Error("DEERFLOW_LANGGRAPH_URL is required");
    if (!process.env.DEERFLOW_GATEWAY_URL) throw new Error("DEERFLOW_GATEWAY_URL is required");
    prisma.deerFlowThreadBinding.findUnique.mockResolvedValue(null);
    prisma.deerFlowThreadBinding.create.mockImplementation(async ({ data }) => ({ ...data }));
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("creates a LangGraph thread, streams a turn, uploads an attachment, and resolves final action artifacts", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "deerflow-real-"));
    const storagePath = path.join(tmp, "brief.md");
    await writeFile(storagePath, "# 真实网络冒烟\n请简短回复并返回 ai_product_workbench_final_action。", "utf8");

    try {
      const service = new DeerFlowRuntimeService(prisma as never);
      const events: string[] = [];
      const result = await service.runTurn({
        runId: `real-run-${Date.now()}`,
        projectId: "real-project-smoke",
        conversationId: `real-conversation-${Date.now()}`,
        userId: "real-user-smoke",
        message: "请基于附件做一次最小真实网络冒烟测试，返回 answer final action。",
        attachmentFiles: [
          {
            fileId: "file-1",
            fileName: "brief.md",
            fileType: "md",
            mimeType: "text/markdown",
            size: 80,
            storagePath,
          },
        ],
        onEvent: (event) => {
          events.push(event.event);
        },
      });

      expect(result.threadId).toBeTruthy();
      expect(result.finalAction.message).toBeTruthy();
      expect(["answer", "ask_clarification", "review_prd", "review_prototype", "download_export"]).toContain(result.finalAction.type);
      expect(events).toEqual(expect.arrayContaining(["gateway-upload"]));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
