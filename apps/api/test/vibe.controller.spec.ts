import { RuntimeRunStatus, UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { VibeController } from "../src/ai/vibe.controller";

describe("VibeController", () => {
  it("exposes cancelRun with the authenticated user, run id, and reason", async () => {
    const vibeService = {
      cancelRun: vi.fn().mockResolvedValue({
        runId: "run-1",
        status: RuntimeRunStatus.cancelled,
        reason: "用户点击停止",
        canceled: true,
      }),
    };
    const controller = new VibeController(vibeService as never);
    const user = {
      id: "user-1",
      username: "zhangsan",
      displayName: "张三",
      role: UserRole.user,
      status: UserStatus.active,
    };

    await expect(controller.cancelRun(user, "run-1", { reason: "用户点击停止" })).resolves.toEqual({
      runId: "run-1",
      status: RuntimeRunStatus.cancelled,
      reason: "用户点击停止",
      canceled: true,
    });
    expect(vibeService.cancelRun).toHaveBeenCalledWith(user, "run-1", "用户点击停止");
  });
});
