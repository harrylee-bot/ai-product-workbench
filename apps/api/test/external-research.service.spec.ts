import { describe, expect, it, vi } from "vitest";
import { ExternalResearchService } from "../src/ai/external-research.service";

describe("ExternalResearchService", () => {
  it("delegates domain-specific public research to DeerFlow after knowledge hits", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const service = new ExternalResearchService();
    const result = await service.research({
      message: "请生成一个门店预约需求文档和原型",
      knowledgeHitCount: 4,
    });

    expect(result.status).toBe("delegated_to_agent");
    expect(result.refs).toEqual([]);
    expect(result.searchQueries).toEqual([]);
    expect(result.privacyBoundary.join("\n")).toContain("不覆盖用户输入");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not inject sample-domain evidence into unrelated requirements", async () => {
    const service = new ExternalResearchService();
    const result = await service.research({
      message: "设计一个合同审批与超时提醒工作台",
      knowledgeHitCount: 3,
    });

    expect(JSON.stringify(result)).not.toMatch(/签到|积分|奖品|忠诚度|mailchimp|stripe/i);
  });

  it("skips external research when local knowledge did not hit", async () => {
    const service = new ExternalResearchService();
    const result = await service.research({
      message: "我想做一个新业务",
      knowledgeHitCount: 0,
    });

    expect(result.status).toBe("skipped_not_needed");
    expect(result.refs).toEqual([]);
  });

  it("skips work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = new ExternalResearchService();
    const result = await service.research({
      message: "生成需求文档和原型",
      knowledgeHitCount: 2,
      signal: controller.signal,
    });

    expect(result.status).toBe("skipped_not_needed");
  });
});
