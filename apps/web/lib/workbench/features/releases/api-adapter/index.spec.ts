import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import {
  normalizeEtag,
  WorkbenchContractError,
} from "../../../transport/contracts";
import { WorkbenchReleasesApi } from "./index";

const timestamp = "2026-07-13T00:00:00.000Z";
const manifestSha256 = "b".repeat(64);
const release = {
  id: "release-1",
  projectId: "project-1",
  version: 1,
  status: "ready",
  createdById: "principal-1",
  boardId: "board-1",
  boardRevision: 1,
  boardSnapshot: {
    id: "board-1",
    projectId: "project-1",
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  },
  boardChecksum: "a".repeat(64),
  artifactPins: [],
  manifest: {
    protocol: "workbench.project-release.v1",
    projectId: "project-1",
    releaseVersion: 1,
    board: { id: "board-1", revision: 1, checksum: "a".repeat(64) },
    artifacts: [],
  },
  manifestSha256,
  failure: null,
  createdAt: timestamp,
  finishedAt: timestamp,
  updatedAt: timestamp,
};

describe("Workbench Releases API adapter", () => {
  it("uses Board CAS and idempotency while preserving immutable digest ETags", async () => {
    const requests: Request[] = [];
    const adapter = createAdapter(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/projects/project-1/releases")) {
        return Response.json({ items: [release], nextCursor: null });
      }
      if (request.method === "POST") {
        expect(request.headers.get("if-match")).toBe('"1"');
        expect(request.headers.get("idempotency-key")).toBe("release:req_123");
        expect(await request.json()).toEqual({ boardId: "board-1", boardRevision: 1 });
        return Response.json(release, { status: 201, headers: { ETag: `"${manifestSha256}"` } });
      }
      return Response.json(release, { headers: { ETag: `"${manifestSha256}"` } });
    });

    await expect(adapter.listProjectReleases("project-1"))
      .resolves.toEqual({ items: [release], nextCursor: null });
    await expect(adapter.createProjectRelease(
      "project-1",
      { boardId: "board-1", boardRevision: 1 },
      ' "1" ',
      "release:req_123",
    )).resolves.toEqual({ value: release, etag: `"${manifestSha256}"` });
    await expect(adapter.getProjectRelease("release-1"))
      .resolves.toEqual({ value: release, etag: `"${manifestSha256}"` });
    expect(requests).toHaveLength(3);
    expect(() => normalizeEtag('W/"1"')).toThrow(/Invalid ETag/);
  });

  it("rejects weak immutable ETags and structurally invalid releases", async () => {
    const weak = createAdapter(async () => Response.json(release, {
      headers: { ETag: `W/"${manifestSha256}"` },
    }));
    await expect(weak.getProjectRelease("release-1")).rejects.toThrow(/strong ETag/);

    const invalid = createAdapter(async () => Response.json({ ...release, unexpected: true }, {
      headers: { ETag: `"${manifestSha256}"` },
    }));
    await expect(invalid.getProjectRelease("release-1"))
      .rejects.toBeInstanceOf(WorkbenchContractError);
  });
});

function createAdapter(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchReleasesApi(createWorkbenchApiClient({
    baseUrl: "http://workbench.test/api/v1",
    fetch: vi.fn(fetch),
  }));
}
