import { describe, expect, it } from "vitest";
import type { CanvasClientStateSyncRequest } from "@workbench/workbench-contracts";

import { WorkbenchCanvasAgentCommandApi } from "./client";

describe("WorkbenchCanvasAgentCommandApi", () => {
  it("uses the BFF command list and ACK endpoints with contract parsing", async () => {
    const requests: Request[] = [];
    const fetch = async (request: Request): Promise<Response> => {
      requests.push(request);
      if (request.method === "GET") {
        return json({ items: [], nextCursor: null });
      }
      if (request.method === "PUT") {
        return json({
          protocol: "workbench.canvas-client-state.v1",
          activeSession: true,
          canvasStateRevision: 2,
        });
      }
      const { visualCapture: _visualCapture, ...durable } = ack();
      return json(durable);
    };
    const api = new WorkbenchCanvasAgentCommandApi({
      baseUrl: "http://localhost/api/v1",
      fetch,
    });
    const controller = new AbortController();

    await api.list("project/1", "client-session-1", 3, "cursor-1", controller.signal);
    await api.syncState("project/1", state(), controller.signal);
    await api.acknowledge("project/1", "command-1", ack(), controller.signal);

    expect(requests[0]!.url).toContain("/projects/project%2F1/canvas-agent/commands?");
    expect(requests[0]!.url).toContain("clientSessionId=client-session-1");
    expect(requests[0]!.url).toContain("projectSessionGeneration=3");
    expect(requests[0]!.url).toContain("after=cursor-1");
    expect(requests[1]!.method).toBe("PUT");
    expect(requests[1]!.url).toContain("/projects/project%2F1/canvas-agent/state");
    expect(await requests[1]!.clone().json()).toEqual(state());
    expect(requests[2]!.method).toBe("POST");
    expect(requests[2]!.url).toContain("/commands/command-1/ack");
    expect(requests[2]!.headers.get("content-type")).toContain("application/json");
    const wireBody = await requests[2]!.clone().json();
    expect(wireBody).toMatchObject({
      ...ack(),
      acknowledgedAt: expect.any(String),
    });
    expect(wireBody.visualCapture).toBeNull();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function state(): CanvasClientStateSyncRequest {
  return {
    protocol: "workbench.canvas-client-state.v1",
    clientSessionId: "client-session-1",
    projectSessionGeneration: 1,
    boardId: "board-1",
    boardRevision: 1,
    canvasStateRevision: 2,
    viewport: { x: 0, y: 0, zoom: 1 },
    visibleScreens: [],
    selectedScreens: [],
  };
}

function ack() {
  return {
    protocol: "workbench.canvas-client-command-ack.v1",
    commandId: "command-1",
    agentSessionId: "session-1",
    toolCallId: "tool-call-1",
    requestId: "request-1",
    toolName: "select_screen",
    projectId: "project-1",
    threadId: "thread-1",
    runId: null,
    boardId: "board-1",
    clientSessionId: "client-session-1",
    projectSessionGeneration: 1,
    boardRevision: 1,
    canvasStateRevision: 1,
    acknowledgedAt: new Date().toISOString(),
    status: "rejected",
    result: null,
    failure: {
      code: "SCREEN_NOT_FOUND",
      message: "missing",
      retryable: true,
    },
    visualCapture: null,
  } as const;
}
