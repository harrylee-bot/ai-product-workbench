import { describe, expect, it, vi } from "vitest";
import { KnowledgeMaintenanceService } from "../src/knowledge/knowledge-maintenance.service";

describe("KnowledgeMaintenanceService", () => {
  it("runs vault sync as the system user", async () => {
    const vault = {
      syncToKnowledgeBase: vi.fn().mockResolvedValue({
        markdownFiles: 2,
        chunks: 3,
        created: 1,
        updated: 0,
      }),
    };
    const service = new KnowledgeMaintenanceService(vault as never);

    const result = await service.runDailySync();

    expect(vault.syncToKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({
      id: "system",
      role: "admin",
      status: "active",
    }));
    expect(result).toEqual({
      skipped: false,
      result: expect.objectContaining({ chunks: 3 }),
    });
  });

  it("skips overlapping sync runs", async () => {
    let release!: () => void;
    const vault = {
      syncToKnowledgeBase: vi.fn(() => new Promise((resolve) => {
        release = () => resolve({ chunks: 1 });
      })),
    };
    const service = new KnowledgeMaintenanceService(vault as never);

    const first = service.runDailySync();
    const second = await service.runDailySync();
    release();
    await first;

    expect(second).toEqual({ skipped: true, reason: "already_running" });
    expect(vault.syncToKnowledgeBase).toHaveBeenCalledTimes(1);
  });
});
