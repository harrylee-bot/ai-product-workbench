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
          payloadMeta: expect.objectContaining({
            schema: "vibe.stream.payload.v1",
            kind: "prd",
            title: "PRD",
          }),
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
        payloadMeta: expect.objectContaining({
          schema: "vibe.stream.payload.v1",
          kind: "prd",
          title: "Legacy PRD",
        }),
        payload: { title: "Legacy PRD" },
        data: { title: "Legacy PRD" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
  });

  it("persists fallback events as agent progress events", async () => {
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
      type: "fallback_used",
      step: "product_design",
      content: "product_design 当前为降级预览，请在确认前复核。",
      data: { level: "degraded_preview", action: "review_required" },
    });

    const createInput = prisma.vibeStreamEventLog.create.mock.calls[0][0];
    expect(createInput.data.eventType).toBe("fallback_used");
    expect(createInput.data.payload).toEqual(
      expect.objectContaining({
        protocol: "vibe.v1",
        eventType: "fallback_used",
        legacyEventType: "agent_started",
        category: "agent",
        phase: "progress",
        payload: expect.objectContaining({
          type: "fallback_used",
          eventType: "fallback_used",
          legacyEventType: "agent_started",
          category: "agent",
          phase: "progress",
          step: "product_design",
          payloadMeta: expect.objectContaining({
            schema: "vibe.stream.payload.v1",
            kind: "fallback",
            status: "degraded_preview",
            action: "review_required",
            summary: "product_design 当前为降级预览，请在确认前复核。",
          }),
          payload: { level: "degraded_preview", action: "review_required" },
        }),
      }),
    );
  });

  it("adds stable QA gate metadata for timeline and debug consumers", async () => {
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
      type: "qa_completed",
      step: "qa_check",
      data: {
        id: "qa-1",
        status: "failed",
        summary: "QA 发现 1 个重要问题。",
        blockingCount: 0,
        majorCount: 1,
        minorCount: 0,
        infoCount: 0,
        issues: [{ id: "issue-1" }],
        qaGate: {
          status: "blocked",
          allowExportOrPublish: false,
          allowPersistKnowledge: false,
        },
      },
    });

    const createInput = prisma.vibeStreamEventLog.create.mock.calls[0][0];
    expect(createInput.data.payload.payload).toEqual(
      expect.objectContaining({
        payloadMeta: expect.objectContaining({
          schema: "vibe.stream.payload.v1",
          kind: "qa",
          primaryId: "qa-1",
          status: "blocked",
          summary: "QA 发现 1 个重要问题。",
          counts: {
            blocking: 0,
            major: 1,
            minor: 0,
            info: 0,
            issues: 1,
          },
          refs: {
            qaReportId: "qa-1",
          },
        }),
      }),
    );
  });
});
