import type { Board } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchBoardApi } from "./index";

describe("Workbench Board API adapter", () => {
  it("validates versioned reads and sends CAS plus idempotency headers on replace", async () => {
    const initial = board();
    const saved = { ...initial, revision: 2, viewport: { x: 40, y: 25, zoom: 0.8 } };
    const requests: Request[] = [];
    const adapter = createAdapter(async (request) => {
      requests.push(request);
      if (request.method === "PUT") {
        expect(request.headers.get("if-match")).toBe('"1"');
        expect(request.headers.get("idempotency-key")).toBe("board:req_123");
        expect(await request.json()).toMatchObject({ viewport: saved.viewport });
        return Response.json(saved, { headers: { ETag: '"2"' } });
      }
      return Response.json(initial, { headers: { ETag: '"1"' } });
    });

    await expect(adapter.getBoard("project-1"))
      .resolves.toEqual({ value: initial, etag: '"1"' });
    await expect(adapter.replaceBoard(
      "project-1",
      { viewport: saved.viewport, nodes: [], edges: [] },
      ' "1" ',
      "board:req_123",
    )).resolves.toEqual({ value: saved, etag: '"2"' });
    expect(requests).toHaveLength(2);
  });
});

function createAdapter(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchBoardApi(createWorkbenchApiClient({
    baseUrl: "http://workbench.test/api/v1",
    fetch: vi.fn(fetch),
  }));
}

function board(): Board {
  return {
    id: "board-1",
    projectId: "project-1",
    revision: 1,
    viewport: { x: 10, y: 20, zoom: 1 },
    nodes: [],
    edges: [],
  };
}
