import { describe, expect, it, vi } from "vitest";
import { VibeStreamService } from "../src/ai/vibe-stream.service";

describe("VibeStreamService", () => {
  it("persists stream events in the required contract event shape", async () => {
    const prisma = {
      vibeStreamEventLog: {
        create: vi.fn(),
        findMany: vi.fn(),
      },
    };
    const service = new VibeStreamService(prisma as never);

    await service.emit({
      runId: "run-1",
      projectId: "project-1",
      type: "prd_updated",
      step: "prd_generation",
      data: { title: "PRD" },
    });

    const createInput = prisma.vibeStreamEventLog.create.mock.calls[0][0];
    expect(createInput.data.eventType).toBe("prd_generated");
    expect(createInput.data.payload).toEqual(
      expect.objectContaining({
        eventType: "prd_generated",
        timestamp: expect.any(String),
        projectId: "project-1",
        payload: expect.objectContaining({
          runId: "run-1",
          type: "prd_updated",
          step: "prd_generation",
        }),
      }),
    );
  });
});
