import { RunsService } from "../src/modules/runs/runs.service.js";

describe("Run event stream authorization", () => {
  it("returns no poll result after Project membership is no longer visible", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const service = runsService({ $queryRaw: queryRaw });

    await expect(service.pollAuthorizedEventStream("principal-1", "run-1", 3))
      .resolves.toBeNull();

    const query = queryRaw.mock.calls[0]?.[0] as { values?: unknown[] } | undefined;
    expect(query?.values).toEqual(expect.arrayContaining(["principal-1", "run-1", 3]));
  });

  it("maps only events returned by the same authorized database query", async () => {
    const occurredAt = new Date("2026-07-15T08:00:00.000Z");
    const service = runsService({
      $queryRaw: vi.fn().mockResolvedValue([{
        runId: "run-1",
        requestId: "request-1",
        projectId: "project-1",
        threadId: "thread-1",
        traceId: "trace-1",
        status: "running",
        eventId: "event-4",
        sequence: 4,
        eventType: "run.started",
        payload: { attempt: 1 },
        occurredAt,
      }]),
    });

    await expect(service.pollAuthorizedEventStream("principal-1", "run-1", 3))
      .resolves.toEqual({
        status: "running",
        events: [{
          protocol: "workbench.run.v1",
          id: "event-4",
          projectId: "project-1",
          threadId: "thread-1",
          runId: "run-1",
          requestId: "request-1",
          sequence: 4,
          type: "run.started",
          occurredAt: occurredAt.toISOString(),
          traceId: "trace-1",
          payload: { attempt: 1 },
        }],
      });
  });

  it("replaces historical run.failed detail with its stable code", async () => {
    const occurredAt = new Date("2026-07-15T08:00:00.000Z");
    const service = runsService({
      $queryRaw: vi.fn().mockResolvedValue([{
        runId: "run-1",
        requestId: "request-1",
        projectId: "project-1",
        threadId: "thread-1",
        traceId: "trace-1",
        status: "failed",
        eventId: "event-4",
        sequence: 4,
        eventType: "run.failed",
        payload: {
          code: "RUNTIME_EXECUTION_FAILED",
          message: "Bearer historical-provider-secret prompt: private response body",
          retryable: false,
        },
        occurredAt,
      }]),
    });

    const result = await service.pollAuthorizedEventStream("principal-1", "run-1", 3);

    expect(result?.events[0]?.payload).toEqual({
      code: "RUNTIME_EXECUTION_FAILED",
      message: "RUNTIME_EXECUTION_FAILED",
      retryable: false,
    });
  });
});

function runsService(db: unknown) {
  return new RunsService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}
