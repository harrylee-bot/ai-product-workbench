import { SystemController } from "../src/modules/system/system.controller.js";

describe("SystemController", () => {
  it("keeps liveness local but gates readiness on the database and DeerFlow", async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) };
    const runtime = { assertReady: vi.fn().mockResolvedValue(undefined) };
    const knowledge = { assertReady: vi.fn().mockResolvedValue(undefined) };
    const controller = new SystemController(db as never, runtime as never, knowledge as never);

    expect(controller.live()).toEqual({ status: "ok" });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(runtime.assertReady).not.toHaveBeenCalled();
    expect(knowledge.assertReady).not.toHaveBeenCalled();

    await expect(controller.ready()).resolves.toEqual({ status: "ready" });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(runtime.assertReady).toHaveBeenCalledOnce();
    expect(knowledge.assertReady).toHaveBeenCalledOnce();
  });

  it("does not report ready when the PUBLIC runtime skill is unavailable", async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) };
    const runtime = {
      assertReady: vi.fn().mockRejectedValue(
        new Error("DEERFLOW_PUBLIC_WORKBENCH_SKILL_REQUIRED"),
      ),
    };
    const knowledge = { assertReady: vi.fn().mockResolvedValue(undefined) };
    const controller = new SystemController(db as never, runtime as never, knowledge as never);

    await expect(controller.ready())
      .rejects.toThrow("DEERFLOW_PUBLIC_WORKBENCH_SKILL_REQUIRED");
  });

  it("does not report ready when a ready Knowledge release cannot be served", async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) };
    const runtime = { assertReady: vi.fn().mockResolvedValue(undefined) };
    const knowledge = {
      assertReady: vi.fn().mockRejectedValue(new Error("KNOWLEDGE_EMBEDDING_PROVIDER_NOT_READY")),
    };
    const controller = new SystemController(db as never, runtime as never, knowledge as never);

    await expect(controller.ready())
      .rejects.toThrow("KNOWLEDGE_EMBEDDING_PROVIDER_NOT_READY");
  });
});
