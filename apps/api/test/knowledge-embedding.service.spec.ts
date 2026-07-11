import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEmbeddingService } from "../src/knowledge/knowledge-embedding.service";

describe("KnowledgeEmbeddingService", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.EMBEDDING_API_BASE_URL = "https://embedding.example.test/v1";
    process.env.EMBEDDING_API_KEY = "test-key";
    process.env.EMBEDDING_MODEL = "test-model";
  });

  afterEach(() => {
    process.env = { ...envBackup };
    vi.unstubAllGlobals();
  });

  it("uses a conditional write so a stale vector cannot overwrite newer content", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const updatedAt = new Date("2026-07-11T08:00:00.000Z");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    }));
    const service = new KnowledgeEmbeddingService({ knowledgeItem: { updateMany } } as never);

    const result = await service.syncItem({
      id: "knowledge-1",
      title: "旧标题",
      summary: "旧摘要",
      content: "旧内容",
      tags: [],
      embedding: null,
      updatedAt,
    });

    expect(result).toMatchObject({ updated: 0, skipped: 1, failed: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "knowledge-1",
        title: "旧标题",
        summary: "旧摘要",
        content: "旧内容",
        updatedAt,
      },
      data: { embedding: [0.1, 0.2, 0.3] },
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an invalid embedding response without writing it", async () => {
    const updateMany = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, Number.NaN] }] }),
    }));
    const service = new KnowledgeEmbeddingService({ knowledgeItem: { updateMany } } as never);

    const result = await service.syncItem({
      id: "knowledge-invalid",
      title: "非法向量",
      summary: null,
      content: "向量接口返回非有限数值。",
      tags: [],
      embedding: null,
      updatedAt: new Date("2026-07-11T09:00:00.000Z"),
    });

    expect(result).toMatchObject({ updated: 0, failed: 1 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
