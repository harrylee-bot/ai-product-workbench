import { describe, expect, it, vi } from "vitest";
import { VibeStreamService } from "../src/ai/vibe-stream.service";

describe("VibeStreamService", () => {
  it("persists stream events in the unified vibe.v1 envelope", async () => {
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
    expect(createInput.data.eventType).toBe("prd_updated");
    expect(createInput.data.payload).toEqual(
      expect.objectContaining({
        protocol: "vibe.v1",
        eventId: expect.any(String),
        eventType: "prd_updated",
        legacyEventType: "prd_generated",
        category: "prd",
        phase: "updated",
        timestamp: expect.any(String),
        runId: "run-1",
        projectId: "project-1",
        payload: expect.objectContaining({
          protocol: "vibe.v1",
          eventId: expect.any(String),
          runId: "run-1",
          projectId: "project-1",
          type: "prd_updated",
          eventType: "prd_updated",
          legacyEventType: "prd_generated",
          category: "prd",
          phase: "updated",
          step: "prd_generation",
          payload: { title: "PRD" },
          data: { title: "PRD" },
        }),
      }),
    );
  });

  it("normalizes legacy persisted payloads when replaying events", async () => {
    const prisma = {
      vibeStreamEventLog: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          {
            payload: {
              eventType: "prd_generated",
              timestamp: "2026-01-01T00:00:00.000Z",
              projectId: "project-1",
              payload: {
                runId: "run-1",
                type: "prd_updated",
                step: "prd_generation",
                data: { title: "Legacy PRD" },
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        ]),
      },
    };
    const service = new VibeStreamService(prisma as never);

    await expect(service.getEvents("run-1")).resolves.toEqual([
      expect.objectContaining({
        protocol: "vibe.v1",
        eventId: expect.any(String),
        runId: "run-1",
        projectId: "project-1",
        type: "prd_updated",
        eventType: "prd_updated",
        legacyEventType: "prd_generated",
        category: "prd",
        phase: "updated",
        step: "prd_generation",
        payload: { title: "Legacy PRD" },
        data: { title: "Legacy PRD" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
  });
});
