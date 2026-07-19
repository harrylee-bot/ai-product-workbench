import { hashRequest } from "../src/common/idempotency.js";
import { RunApprovalsService, approvalResponse } from "../src/modules/runs/run-approvals.service.js";

const now = new Date("2026-07-12T00:00:00.000Z");
const run = {
  id: "run_1",
  requestId: "request_1",
  projectId: "project_1",
  threadId: "thread_1",
  retryOfRunId: null,
  status: "waiting_input" as const,
  modelId: "quality",
  request: {
    prompt: "Publish the result",
    modelId: "quality",
    workflow: "generate" as const,
    targetSurface: "app" as const,
    designStyle: { kind: "automatic" as const },
    sourceIds: [],
    artifactTargets: [],
    requestedArtifactKinds: [],
  },
  sourceSnapshots: [],
  knowledgeReleaseId: null,
  phase: "planning" as const,
  phaseLabel: "Waiting for input",
  progress: 0.3,
  attempt: 1,
  eventSequence: 4,
  cancelRequestedAt: null,
  errorCode: null,
  errorDetail: null,
  errorRetryable: null,
  cancellationReason: null,
  createdAt: now,
  startedAt: now,
  finishedAt: null,
};
const pendingApproval = {
  id: "approval_1",
  runId: "run_1",
  key: "interrupt_1",
  kind: "confirmation",
  prompt: "Publish this result?",
  options: [],
  attempt: 1,
  status: "pending" as const,
  response: null,
  decidedById: null,
  decidedAt: null,
  revision: 0,
  decisionIdempotencyKey: null,
  decisionRequestHash: null,
  createdAt: now,
  updatedAt: now,
  run,
};

describe("Run approval commands", () => {
  it("stores a JSON-safe normalized decision", () => {
    expect(approvalResponse({ decision: "approve" })).toEqual({ decision: "approve" });
    expect(approvalResponse({ decision: "submit", value: { answer: 42 } })).toEqual({
      decision: "submit",
      value: { answer: 42 },
    });
  });

  it("replays only an exact idempotent decision", async () => {
    const request = { decision: "approve" as const };
    const decided = {
      ...pendingApproval,
      status: "approved" as const,
      response: { decision: "approve" },
      decidedById: "principal_1",
      decidedAt: now,
      revision: 1,
      decisionIdempotencyKey: "approval:key:123",
      decisionRequestHash: hashRequest(request),
    };
    const db = { runApproval: { findFirst: vi.fn().mockResolvedValue(decided) } };
    const access = { findRun: vi.fn().mockResolvedValue(run) };
    const service = new RunApprovalsService(db as never, access as never, {} as never, {} as never);

    await expect(service.submit("principal_1", "run_1", "approval_1", "approval:key:123", request))
      .resolves.toMatchObject({ approval: { status: "approved" }, run: { id: "run_1" } });
    await expect(service.submit("principal_1", "run_1", "approval_1", "approval:key:123", {
      decision: "approve",
      value: { changed: true },
    })).rejects.toMatchObject({ status: 409 });
    await expect(service.submit("principal_1", "run_1", "approval_1", "approval:key:other", request))
      .rejects.toMatchObject({ status: 409 });
  });

  it("does not enumerate approvals when Run access is denied", async () => {
    const db = { runApproval: { findMany: vi.fn() } };
    const access = { findRun: vi.fn().mockRejectedValue(new Error("forbidden")) };
    const service = new RunApprovalsService(db as never, access as never, {} as never, {} as never);

    await expect(service.list("principal_2", "run_1")).rejects.toThrow("forbidden");
    expect(db.runApproval.findMany).not.toHaveBeenCalled();
  });

  it("queues checkpoint resume atomically after the final pending decision", async () => {
    const decidedApproval = {
      ...pendingApproval,
      status: "approved" as const,
      response: { decision: "approve" },
      decidedById: "principal_1",
      decidedAt: now,
      revision: 1,
      decisionIdempotencyKey: "approval:key:123",
      decisionRequestHash: hashRequest({ decision: "approve" }),
      updatedAt: new Date("2026-07-12T00:01:00.000Z"),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "run_1" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      runApproval: {
        findFirst: vi.fn().mockResolvedValue(pendingApproval),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([decidedApproval]),
        findUniqueOrThrow: vi.fn().mockResolvedValue(decidedApproval),
      },
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...run, status: "queued" as const }),
      },
    };
    const db = {
      runApproval: { findFirst: vi.fn().mockResolvedValue(pendingApproval) },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const access = { findRun: vi.fn().mockResolvedValue(run) };
    const events = { append: vi.fn().mockResolvedValue({}) };
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
    const service = new RunApprovalsService(db as never, access as never, events as never, queue as never);

    const result = await service.submit(
      "principal_1",
      "run_1",
      "approval_1",
      "approval:key:123",
      { decision: "approve" },
    );

    expect(result.run.status).toBe("queued");
    expect(events.append).toHaveBeenNthCalledWith(1, tx, "run_1", "run.input.submitted", {
      approvalId: "approval_1",
      decision: "approve",
    });
    expect(events.append).toHaveBeenNthCalledWith(2, tx, "run_1", "run.queued", { position: null });
    expect(queue.sendInTransaction).toHaveBeenCalledWith(
      tx,
      "runtime.execute",
      { runId: "run_1", approvalIds: ["approval_1"] },
      expect.objectContaining({ group: { id: "thread_1" } }),
    );
  });
});
