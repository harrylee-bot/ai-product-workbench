import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SystemProbeController } from "../src/modules/system/system-probe.controller";
import { SystemReadinessService } from "../src/modules/system/system-readiness.service";

describe("System readiness", () => {
  const prisma = { $queryRawUnsafe: vi.fn() };
  const values = new Map<string, string>();
  const config = { get: vi.fn((key: string) => values.get(key)) };

  beforeEach(() => {
    vi.clearAllMocks();
    values.clear();
    prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1 }]);
  });

  it("reports live without dependency checks", () => {
    const readiness = new SystemReadinessService(prisma as never, config as never);
    const controller = new SystemProbeController(readiness);

    expect(controller.live()).toMatchObject({ ok: true, service: "ai-product-workbench-api" });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("is ready when the database and writable storage are available", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workbench-ready-"));
    values.set("FILE_UPLOAD_ROOT", root);
    const readiness = new SystemReadinessService(prisma as never, config as never);

    await expect(readiness.check()).resolves.toMatchObject({
      ok: true,
      dependencies: {
        database: { status: "ok" },
        storage: { status: "ok" },
        deerflow: { status: "skipped" },
      },
    });
  });

  it("returns a structured 503 report when a required dependency is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workbench-ready-"));
    values.set("FILE_UPLOAD_ROOT", root);
    prisma.$queryRawUnsafe.mockRejectedValue(new Error("offline"));
    const readiness = new SystemReadinessService(prisma as never, config as never);
    const controller = new SystemProbeController(readiness);
    const response = { status: vi.fn() };

    await expect(controller.ready(response as never)).resolves.toMatchObject({
      ok: false,
      dependencies: { database: { status: "failed", reason: "database_unavailable" } },
    });
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it("only requires DeerFlow when explicitly configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workbench-ready-"));
    values.set("FILE_UPLOAD_ROOT", root);
    values.set("DEERFLOW_READINESS_REQUIRED", "true");
    values.set("DEERFLOW_ENABLED", "false");
    const readiness = new SystemReadinessService(prisma as never, config as never);

    await expect(readiness.check()).resolves.toMatchObject({
      ok: false,
      dependencies: { deerflow: { status: "failed", reason: "deerflow_disabled" } },
    });
  });
});
