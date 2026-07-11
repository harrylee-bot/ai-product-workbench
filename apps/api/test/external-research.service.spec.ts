import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalResearchService } from "../src/ai/external-research.service";

describe("ExternalResearchService", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("EXTERNAL_RESEARCH_ENABLED", "true");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is disabled by default so ordinary Agent turns do not incur fixed web latency", async () => {
    vi.stubEnv("EXTERNAL_RESEARCH_ENABLED", "false");
    const service = new ExternalResearchService();

    const result = await service.research({
      message: "我想做一个签到领积分活动",
      knowledgeHitCount: 3,
    });

    expect(result.status).toBe("skipped_not_needed");
    expect(result.searchQueries).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches public evidence with generic queries after knowledge hits", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => [
        "<!doctype html><html><head><title>Public Evidence</title></head>",
        "<body>",
        "x".repeat(1600),
        "</body></html>",
      ].join(""),
    });

    const service = new ExternalResearchService();
    const result = await service.research({
      message: "我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型",
      knowledgeHitCount: 4,
    });

    expect(result.status).toBe("completed");
    expect(result.refs).toHaveLength(4);
    expect(result.refs[0]).toEqual(expect.objectContaining({
      query: "签到积分活动 会员运营 最佳实践",
      title: "Public Evidence",
      source: "public_web_fetch",
    }));
    expect(result.searchQueries.join("\n")).not.toMatch(/knowledge-vault|\/Users\/|conversation|runId|storage\//i);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mailchimp.com/resources/loyalty-programs/",
      expect.objectContaining({
        headers: expect.objectContaining({
          "user-agent": "ai-product-workbench-external-research/0.1",
        }),
      }),
    );
  });

  it("skips external research when local knowledge did not hit", async () => {
    const service = new ExternalResearchService();
    const result = await service.research({
      message: "我想做一个签到领积分的活动",
      knowledgeHitCount: 0,
    });

    expect(result.status).toBe("skipped_not_needed");
    expect(result.refs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not inject loyalty evidence into unsupported product domains", async () => {
    const service = new ExternalResearchService();
    const result = await service.research({
      message: "生成企业 CRM 审批工作台原型",
      knowledgeHitCount: 4,
    });

    expect(result.status).toBe("skipped_not_needed");
    expect(result.refs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns non-blocking failure when only part of public evidence is reachable", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `<title>Reachable</title>${"x".repeat(1600)}`,
      })
      .mockRejectedValue(new Error("network timeout"));

    const service = new ExternalResearchService();
    const result = await service.research({
      message: "签到积分活动",
      knowledgeHitCount: 2,
    });

    expect(result.status).toBe("failed_non_blocking");
    expect(result.refs).toHaveLength(1);
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]?.url).toBe("https://docs.stripe.com/api/idempotent_requests");
  });

  it("reuses cached public evidence for the same generic query set", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => `<title>Cached Evidence</title>${"x".repeat(1600)}`,
    });

    const service = new ExternalResearchService();
    const first = await service.research({
      message: "我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型",
      knowledgeHitCount: 3,
    });
    const second = await service.research({
      message: "请继续完善签到领积分活动的原型和需求文档",
      knowledgeHitCount: 3,
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.refs).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(second.searchQueries.join("\n")).not.toMatch(/需求文档|原型和需求文档/);
  });

  it("deduplicates concurrent public evidence fetches", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      text: async () => `<title>Concurrent Evidence</title>${"x".repeat(1600)}`,
    }));

    const service = new ExternalResearchService();
    const [first, second] = await Promise.all([
      service.research({
        message: "我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型",
        knowledgeHitCount: 3,
      }),
      service.research({
        message: "签到领积分活动 原型",
        knowledgeHitCount: 3,
      }),
    ]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(second.cacheHit).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
