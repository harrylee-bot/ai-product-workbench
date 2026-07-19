// @vitest-environment jsdom

import type {
  Run,
  SubmissionIntent,
} from "@workbench/workbench-contracts";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import {
  normalizeEtag,
  WorkbenchContractError,
} from "../../../transport/contracts";
import { WorkbenchTransportProvider } from "../../../transport/context";
import {
  useWorkbenchSubmissionIntentsApi,
  WorkbenchSubmissionIntentsApi,
} from "./index";

const timestamp = "2026-07-15T00:00:00.000Z";
const pending: SubmissionIntent = {
  id: "intent-1",
  projectId: "project-1",
  threadId: "thread-1",
  status: "pending",
  request: {
    prompt: "Build a dashboard",
    modelId: "quality",
    workflow: "generate",
    generationIntent: null,
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    artifactTargets: [],
    requestedArtifactKinds: [],
    sourceIds: [],
    canvasSnapshot: null,
  },
  attachments: [],
  runId: null,
  lastFailure: null,
  revision: 1,
  submittedAt: null,
  cancelledAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const submitted: SubmissionIntent = {
  ...pending,
  status: "submitted",
  runId: "run-1",
  revision: 2,
  submittedAt: timestamp,
};
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

describe("SubmissionIntent API contracts", () => {
  it("keeps one feature-owned adapter instance across React rerenders", () => {
    const rendered = renderHook(() => useWorkbenchSubmissionIntentsApi(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(
        WorkbenchTransportProvider,
        null,
        children,
      ),
    });
    const first = rendered.result.current;

    rendered.rerender();

    expect(rendered.result.current).toBe(first);
    expect(first).toBeInstanceOf(WorkbenchSubmissionIntentsApi);
    rendered.unmount();
  });

  it("uses Thread routes, idempotency, ETags, and cancel CAS without transport casts", async () => {
    const requests: Request[] = [];
    const service = createService(async (request) => {
      requests.push(request);
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname.endsWith("/threads/thread-1/submission-intents")) {
        return Response.json(pending, { status: 201, headers: { ETag: '"1"' } });
      }
      if (request.method === "GET" && pathname.endsWith("/threads/thread-1/submission-intents/current")) {
        return Response.json({ item: pending });
      }
      if (request.method === "GET" && pathname.endsWith("/submission-intents/intent-1")) {
        return Response.json(pending, { headers: { ETag: '"1"' } });
      }
      if (request.method === "POST" && pathname.endsWith("/submission-intents/intent-1/submit")) {
        return Response.json({ intent: submitted, run }, {
          status: 202,
          headers: { ETag: '"2"' },
        });
      }
      if (request.method === "DELETE" && pathname.endsWith("/submission-intents/intent-1")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${pathname}`);
    });
    const createRequest = {
      request: {
        prompt: "Build a dashboard",
        modelId: "quality",
        workflow: "generate" as const,
        targetSurface: "web" as const,
        designStyle: { kind: "automatic" as const },
      },
      attachments: [],
    };

    await expect(service.createSubmissionIntent(
      "thread-1",
      createRequest,
      "submission:req_123",
    )).resolves.toEqual({ value: pending, etag: '"1"' });
    await expect(service.getCurrentSubmissionIntent("thread-1"))
      .resolves.toEqual({ item: pending });
    await expect(service.getSubmissionIntent("intent-1"))
      .resolves.toEqual({ value: pending, etag: '"1"' });
    await expect(service.submitSubmissionIntent("intent-1"))
      .resolves.toEqual({ value: { intent: submitted, run }, etag: '"2"' });
    await expect(service.cancelSubmissionIntent("intent-1", '  "1"  ')).resolves.toBeUndefined();

    expect(requests[0].headers.get("idempotency-key")).toBe("submission:req_123");
    await expect(requests[0].clone().json()).resolves.toEqual({
      request: { ...pending.request },
      attachments: [],
    });
    expect(requests[3].headers.get("idempotency-key")).toBeNull();
    expect(requests[3].headers.get("if-match")).toBeNull();
    expect(requests[4].headers.get("if-match")).toBe('"1"');
    expect(() => normalizeEtag('W/"1"')).toThrow(/Invalid ETag/);
  });

  it("rejects structurally invalid current state", async () => {
    const service = createService(async () => Response.json({
      item: null,
      unexpected: true,
    }));

    await expect(service.getCurrentSubmissionIntent("thread-1"))
      .rejects.toBeInstanceOf(WorkbenchContractError);
  });
});

function createService(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchSubmissionIntentsApi(createWorkbenchApiClient({
    baseUrl: `${window.location.origin}/api/v1`,
    fetch: vi.fn(fetch),
  }));
}
