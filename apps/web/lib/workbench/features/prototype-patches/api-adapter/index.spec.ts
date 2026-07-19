import type { RunPrototypePatchCheckpoint } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { WorkbenchPrototypePatchesApi } from "./index";

describe("Workbench Prototype patches API", () => {
  it("loads a Run-scoped checkpoint without an HTTP cache fallback", async () => {
    const checkpoint = fixtureCheckpoint();
    const requests: Request[] = [];
    const api = new WorkbenchPrototypePatchesApi({
      baseUrl: "http://workbench.test/api/v1/",
      fetch: vi.fn(async (request: Request) => {
        requests.push(request);
        return Response.json(checkpoint);
      }),
    });

    await expect(api.getCheckpoint(
      "run/unsafe",
      "version unsafe",
      new AbortController().signal,
    )).resolves.toEqual(checkpoint);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(
      "http://workbench.test/api/v1/runs/run%2Funsafe/artifact-drafts/version%20unsafe/checkpoint",
    );
    expect(request.cache).toBe("no-store");
    expect(request.credentials).toBe("same-origin");
    expect(request.headers.get("cache-control")).toBe("no-cache");
  });

  it("keeps the optional screen filter for explicit diagnostic reads", async () => {
    const checkpoint = fixtureCheckpoint();
    const requests: Request[] = [];
    const api = new WorkbenchPrototypePatchesApi({
      baseUrl: "http://workbench.test/api/v1",
      fetch: vi.fn(async (request: Request) => {
        requests.push(request);
        return Response.json(checkpoint);
      }),
    });

    await api.getCheckpoint(
      "run-1",
      "version-1",
      new AbortController().signal,
      "screen/unsafe",
    );

    expect(requests[0]?.url).toBe(
      "http://workbench.test/api/v1/runs/run-1/artifact-drafts/version-1/checkpoint?screenId=screen%2Funsafe",
    );
  });

  it("rejects a response outside the checkpoint contract", async () => {
    const api = new WorkbenchPrototypePatchesApi({
      baseUrl: "http://workbench.test/api/v1",
      fetch: async () => Response.json({ protocol: "wrong" }),
    });

    await expect(api.getCheckpoint(
      "run-1",
      "version-1",
      new AbortController().signal,
    )).rejects.toThrow(/不符合合同/);
  });
});

function fixtureCheckpoint(): RunPrototypePatchCheckpoint {
  return {
    protocol: "workbench.prototype-patch-checkpoint.v1",
    projectId: "project-1",
    runId: "run-1",
    requestId: "request-1",
    attempt: 1,
    runtimeAttemptId: "runtime-attempt-1",
    artifactIndex: 0,
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    status: "staging",
    document: {
      protocol: "workbench.prototype.v1",
      documentId: "document-1",
      title: "Prototype",
      revision: 1,
      screens: [{
        id: "screen-main",
        name: "Main",
        route: "/",
        rootNodeId: "root-main",
        initialStateId: null,
        viewport: { width: 390, height: 844 },
      }],
      nodes: [{
        id: "root-main",
        kind: "frame",
        screenId: "screen-main",
        parentId: null,
        name: "Root",
        visible: true,
        layout: {
          mode: "absolute",
          x: literal(0), y: literal(0), width: literal(390), height: literal(844),
          display: "block", direction: "column", gap: literal(0),
          padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
          align: "start", justify: "start", gridColumns: null, overflow: "hidden",
        },
        style: {
          opacity: 1,
          rotation: 0,
          transformOrigin: { x: 0.5, y: 0.5 },
          fill: { kind: "literal", value: "#ffffff" },
          stroke: null,
          radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
          shadowTokenIds: [],
          typography: null,
        },
        actionIds: [], bindingIds: [], motionIds: [], childIds: [], clipContent: true,
      }],
      tokens: [], assets: [], variables: [], states: [], actions: [], bindings: [], motions: [],
    },
    documentChecksum: "a".repeat(64),
    screens: [{ screenId: "screen-main", revision: 0, checksum: "b".repeat(64) }],
    lastSequence: 2,
  };
}

function literal(value: number) {
  return { kind: "literal" as const, value };
}
