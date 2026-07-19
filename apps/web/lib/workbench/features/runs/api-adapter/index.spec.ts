import type {
  Run,
  RunApproval,
} from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchContractError } from "../../../transport/contracts";
import { WorkbenchRunsApi } from "./index";

const timestamp = "2026-07-15T00:00:00.000Z";
const run: Run = {
  id: "run-1",
  requestId: "request-1",
  projectId: "project-1",
  threadId: "thread-1",
  retryOfRunId: null,
  status: "queued",
  modelId: "quality",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: [],
  sources: [],
  knowledgeReleaseId: null,
  phase: null,
  phaseLabel: null,
  progress: null,
  attempt: 0,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: timestamp,
  startedAt: null,
  finishedAt: null,
};
const approval: RunApproval = {
  id: "approval-1",
  runId: run.id,
  kind: "design-choice",
  prompt: "Choose a layout",
  options: [{
    id: "compact",
    label: "Compact",
    description: null,
    value: { choice: "compact" },
  }],
  attempt: 0,
  status: "pending",
  response: null,
  decidedById: null,
  decidedAt: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("Runs API contracts", () => {
  it("strictly parses the paginated Run list", async () => {
    const responses = [
      { items: [run], nextCursor: "cursor-2" },
      { items: [run], nextCursor: null, unexpected: true },
    ];
    const service = createService(async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/v1/threads/thread-1/runs");
      expect(url.searchParams.get("cursor")).toBe("cursor-1");
      expect(url.searchParams.get("limit")).toBe("10");
      return Response.json(responses.shift());
    });

    await expect(service.listRuns("thread-1", { cursor: "cursor-1", limit: 10 }))
      .resolves.toEqual({ items: [run], nextCursor: "cursor-2" });
    await expect(service.listRuns("thread-1", { cursor: "cursor-1", limit: 10 }))
      .rejects.toBeInstanceOf(WorkbenchContractError);
  });

  it("owns Run lifecycle and approval headers without a service facade", async () => {
    const requests: Request[] = [];
    const decidedApproval: RunApproval = {
      ...approval,
      status: "approved",
      response: { decision: "approve" },
      decidedById: "principal-1",
      decidedAt: timestamp,
      revision: 2,
      updatedAt: timestamp,
    };
    const service = createService(async (request) => {
      requests.push(request);
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname.endsWith("/runs/run-1")) {
        return Response.json(run);
      }
      if (request.method === "POST" && pathname.endsWith("/runs/run-1/cancel")) {
        return Response.json({ ...run, status: "cancelling", cancelRequestedAt: timestamp });
      }
      if (request.method === "POST" && pathname.endsWith("/runs/run-1/retry")) {
        return Response.json({ ...run, id: "run-2", retryOfRunId: run.id });
      }
      if (request.method === "GET" && pathname.endsWith("/runs/run-1/approvals")) {
        return Response.json({ items: [approval] });
      }
      if (request.method === "GET" && pathname.endsWith("/runs/run-1/approvals/approval-1")) {
        return Response.json(approval, { headers: { ETag: '"1"' } });
      }
      if (request.method === "POST" && pathname.endsWith("/runs/run-1/approvals/approval-1")) {
        return Response.json({ approval: decidedApproval, run }, { headers: { ETag: '"2"' } });
      }
      throw new Error(`Unexpected request: ${request.method} ${pathname}`);
    });

    await expect(service.getRun(run.id)).resolves.toEqual(run);
    await expect(service.cancelRun(run.id, "cancel:request_1")).resolves.toMatchObject({
      status: "cancelling",
    });
    await expect(service.retryRun(run.id, "retry:request_1")).resolves.toMatchObject({
      id: "run-2",
      retryOfRunId: run.id,
    });
    await expect(service.listRunApprovals(run.id)).resolves.toEqual({ items: [approval] });
    await expect(service.getRunApproval(run.id, approval.id)).resolves.toEqual({
      value: approval,
      etag: '"1"',
    });
    await expect(service.submitRunApproval(
      run.id,
      approval.id,
      { decision: "approve" },
      "approval:request_1",
    )).resolves.toEqual({
      value: { approval: decidedApproval, run },
      etag: '"2"',
    });

    expect(requests[1].headers.get("idempotency-key")).toBe("cancel:request_1");
    expect(requests[2].headers.get("idempotency-key")).toBe("retry:request_1");
    expect(requests[5].headers.get("idempotency-key")).toBe("approval:request_1");
    await expect(requests[5].clone().json()).resolves.toEqual({ decision: "approve" });
  });
});

function createService(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchRunsApi(createWorkbenchApiClient({
    baseUrl: "http://workbench.test/api/v1",
    fetch: vi.fn(fetch),
  }));
}
