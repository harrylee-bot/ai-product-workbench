import { RuntimeRunStatus, UserIntent } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeRunLogService } from "../src/ai/runtime-run-log.service";

describe("RuntimeRunLogService", () => {
  const prisma = {
    runtimeRunLog: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const service = new RuntimeRunLogService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    prisma.runtimeRunLog.findFirst.mockResolvedValue(null);
    prisma.runtimeRunLog.updateMany.mockResolvedValue({ count: 0 });
  });

  it("creates a running run with summarized input and trace id", async () => {
    prisma.runtimeRunLog.create.mockResolvedValue({ id: "run-1", traceId: "trace-1" });

    await service.createRun({
      conversationId: "conversation-1",
      userId: "user-1",
      userInput: `  ${"生成签到活动 ".repeat(300)}  `,
      requestId: "message-1",
    });

    expect(prisma.runtimeRunLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        userId: "user-1",
        status: RuntimeRunStatus.running,
        requestId: "message-1",
        leaseToken: expect.any(String),
        heartbeatAt: expect.any(Date),
        leaseExpiresAt: expect.any(Date),
        traceId: expect.any(String),
        inputSummary: expect.stringMatching(/^生成签到活动/),
      }),
    });
    expect(prisma.runtimeRunLog.create.mock.calls[0][0].data.inputSummary.length).toBeLessThanOrEqual(2003);
  });

  it("rejects an idempotent retry before creating another run", async () => {
    prisma.runtimeRunLog.findFirst.mockResolvedValue({
      id: "run-existing",
      status: RuntimeRunStatus.succeeded,
    });

    await expect(service.createRun({
      conversationId: "conversation-1",
      userId: "user-1",
      userInput: "生成 PRD",
      requestId: "message-1",
    })).rejects.toMatchObject({ status: 409 });

    expect(prisma.runtimeRunLog.create).not.toHaveBeenCalled();
  });

  it("renews only the matching running lease", async () => {
    prisma.runtimeRunLog.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.renewLease("run-1", "lease-1")).resolves.toBe(true);

    expect(prisma.runtimeRunLog.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: RuntimeRunStatus.running,
        leaseToken: "lease-1",
      },
      data: {
        heartbeatAt: expect.any(Date),
        leaseExpiresAt: expect.any(Date),
      },
    });
  });

  it("atomically completes only running runs and records duration/result", async () => {
    const startedAt = new Date("2026-06-28T08:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T08:00:03.500Z"));
    prisma.runtimeRunLog.findUnique.mockResolvedValue({ id: "run-1", startedAt });
    prisma.runtimeRunLog.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.completeRun("run-1", { ok: true }, " 已完成 ")).resolves.toBe(true);

    expect(prisma.runtimeRunLog.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: RuntimeRunStatus.running },
      data: expect.objectContaining({
        status: RuntimeRunStatus.succeeded,
        outputSummary: "已完成",
        result: { ok: true },
        endedAt: new Date("2026-06-28T08:00:03.500Z"),
        durationMs: 3500,
      }),
    });
  });

  it("does not overwrite terminal runs when completion races with cancellation", async () => {
    prisma.runtimeRunLog.findUnique.mockResolvedValue({
      id: "run-1",
      startedAt: new Date("2026-06-28T08:00:00.000Z"),
    });
    prisma.runtimeRunLog.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.completeRun("run-1", { ok: true }, "late result")).resolves.toBe(false);

    expect(prisma.runtimeRunLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1", status: RuntimeRunStatus.running },
    }));
  });

  it("cancels running runs with terminal result payload", async () => {
    const run = {
      id: "run-1",
      status: RuntimeRunStatus.running,
      startedAt: new Date("2026-06-28T08:00:00.000Z"),
    };
    const cancelled = { ...run, status: RuntimeRunStatus.cancelled };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T08:00:05.000Z"));
    prisma.runtimeRunLog.findUnique
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(cancelled);
    prisma.runtimeRunLog.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.cancelRun({ runId: "run-1", canceledBy: "user-1", reason: "用户停止" });

    expect(result).toEqual({ changed: true, run: cancelled });
    expect(prisma.runtimeRunLog.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: RuntimeRunStatus.running },
      data: expect.objectContaining({
        status: RuntimeRunStatus.cancelled,
        result: expect.objectContaining({
          canceled: true,
          reason: "用户停止",
          canceledBy: "user-1",
          messageStatus: "not_created",
        }),
        durationMs: 5000,
      }),
    });
  });

  it("marks run intent separately for observability filters", async () => {
    await service.markRunIntent("run-1", UserIntent.generate_prototype);

    expect(prisma.runtimeRunLog.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { intent: UserIntent.generate_prototype },
    });
  });
});
