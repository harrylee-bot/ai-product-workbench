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

  it("emits run_canceled as a terminal run event with debuggable status metadata", async () => {
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
      type: "run_canceled",
      content: "执行已停止。",
      data: { runId: "run-1", status: "cancelled", reason: "user_requested" },
    });

    const createInput = prisma.vibeStreamEventLog.create.mock.calls[0][0];
    expect(createInput.data.eventType).toBe("run_canceled");
    expect(createInput.data.payload.payload).toEqual(expect.objectContaining({
      type: "run_canceled",
      eventType: "run_canceled",
      legacyEventType: "agent_completed",
      category: "run",
      phase: "canceled",
      payloadMeta: expect.objectContaining({
        schema: "vibe.stream.payload.v1",
        kind: "run",
        status: "cancelled",
        summary: "执行已停止。",
      }),
      payload: { runId: "run-1", status: "cancelled", reason: "user_requested" },
    }));
  });

  it("completes replay streams after a persisted terminal run event", async () => {
    const prisma = {
      vibeStreamEventLog: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          {
            payload: {
              runId: "run-1",
              projectId: "project-1",
              type: "step_started",
              step: "requirement_packaging",
              content: "正在把请求交给 DeerFlow 2.0 lead agent。",
              createdAt: "2026-06-27T00:00:00.000Z",
            },
          },
          {
            payload: {
              runId: "run-1",
              projectId: "project-1",
              type: "run_completed",
              content: "本轮执行已完成。",
              data: { runId: "run-1", status: "succeeded" },
              createdAt: "2026-06-27T00:00:01.000Z",
            },
          },
        ]),
      },
    };
    const service = new VibeStreamService(prisma as never);
    const received: unknown[] = [];

    await withTimeout(new Promise<void>((resolve, reject) => {
      service.stream("run-1").subscribe({
        next: (event) => received.push(event),
        error: reject,
        complete: resolve,
      });
    }));

    expect(received).toEqual([
      expect.objectContaining({ type: "step_started" }),
      expect.objectContaining({ type: "run_completed" }),
    ]);
  });

  it("keeps realtime streams open for non-terminal runtime events", async () => {
    const prisma = {
      vibeStreamEventLog: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const service = new VibeStreamService(prisma as never);
    const complete = vi.fn();
    const received: unknown[] = [];

    const subscription = service.stream("run-1").subscribe({
      next: (event) => received.push(event),
      complete,
    });

    await Promise.resolve();
    await service.emit({
      runId: "run-1",
      projectId: "project-1",
      type: "message_delta",
      content: "DeerFlow 正在调用能力：coding_node",
      data: { event: "messages", toolName: "coding_node" },
    });

    expect(received).toEqual([
      expect.objectContaining({ type: "message_delta" }),
    ]);
    expect(complete).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });
});

function withTimeout<T>(promise: Promise<T>) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for stream completion")), 1000);
    }),
  ]);
}
