// @vitest-environment jsdom

import type { ImportSource } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchImportSourcesApi } from "./index";

const timestamp = "2026-07-18T00:00:00.000Z";
const pending: ImportSource = {
  id: "source-1",
  projectId: "project-1",
  createdById: "user-1",
  kind: "github_snapshot",
  status: "pending",
  label: "acme/repo",
  descriptor: null,
  checksum: null,
  revision: 0,
  failure: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("Import Sources API adapter", () => {
  it("owns list/create/get/delete routes and revision headers", async () => {
    const requests: Request[] = [];
    const api = new WorkbenchImportSourcesApi(createWorkbenchApiClient({
      baseUrl: `${window.location.origin}/api/v1`,
      fetch: vi.fn(async (request) => {
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/projects/project-1/import-sources")) {
          return Response.json({ items: [pending], nextCursor: "next" });
        }
        if (request.method === "POST") {
          return Response.json(pending, { status: 201, headers: { ETag: '"0"' } });
        }
        if (request.method === "GET" && url.pathname.endsWith("/import-sources/source-1")) {
          return Response.json(pending, { headers: { ETag: '"0"' } });
        }
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    }));

    await expect(api.listImportSources("project-1", { limit: 25 })).resolves.toEqual({
      items: [pending],
      nextCursor: "next",
    });
    await expect(api.createImportSource("project-1", {
      kind: "github_snapshot",
      repository: "acme/repo",
      ref: "main",
    }, "import-source:req_1")).resolves.toEqual({ value: pending, etag: '"0"' });
    await expect(api.getImportSource("source-1")).resolves.toEqual({
      value: pending,
      etag: '"0"',
    });
    await expect(api.deleteImportSource("source-1", '  "0"  ')).resolves.toBeUndefined();

    const listRequest = requests[0];
    expect(new URL(listRequest!.url).searchParams.get("limit")).toBe("25");
    const createRequest = requests.find((request) => request.method === "POST");
    expect(createRequest?.headers.get("idempotency-key")).toBe("import-source:req_1");
    await expect(createRequest?.clone().json()).resolves.toEqual({
      kind: "github_snapshot",
      repository: "acme/repo",
      ref: "main",
    });
    const deleteRequest = requests.find((request) => request.method === "DELETE");
    expect(deleteRequest?.headers.get("if-match")).toBe('"0"');
  });
});
