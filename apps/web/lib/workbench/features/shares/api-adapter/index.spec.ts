import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchSharesApi } from "./index";

const timestamp = "2026-07-13T00:00:00.000Z";
const share = {
  id: "share-1",
  releaseId: "release-1",
  createdById: "principal-1",
  scope: "view",
  status: "active",
  revision: 1,
  expiresAt: null,
  revokedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("Workbench Shares API adapter", () => {
  it("validates one-time token responses and uses revision ETags for revocation", async () => {
    const token = `wbs_${"A".repeat(43)}`;
    const revoked = { ...share, status: "revoked", revision: 2, revokedAt: timestamp };
    const adapter = createAdapter(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/projects/project-1/shares") && request.method === "GET") {
        return Response.json({ items: [share], activeCount: 1, nextCursor: null });
      }
      if (url.pathname.endsWith("/projects/project-1/shares/rotate")) {
        expect(request.headers.get("idempotency-key")).toBe("share-rotate:req_123");
        return Response.json(
          { share, token, revokedGrantCount: 1 },
          { status: 201, headers: { ETag: '"1"' } },
        );
      }
      if (url.pathname.endsWith("/projects/project-1/shares/revoke-all")) {
        return Response.json({ projectId: "project-1", activeGrantCount: 0 });
      }
      if (url.pathname.endsWith("/revoke")) {
        expect(request.headers.get("if-match")).toBe('"1"');
        return Response.json(revoked, { headers: { ETag: '"2"' } });
      }
      return Response.json(share, { headers: { ETag: '"1"' } });
    });

    await expect(adapter.listShareGrants("project-1"))
      .resolves.toEqual({ items: [share], activeCount: 1, nextCursor: null });
    await expect(adapter.rotateShareGrant("project-1", {
      releaseId: "release-1",
      scope: "view",
      expiresAt: null,
    }, "share-rotate:req_123")).resolves.toEqual({
      value: { share, token, revokedGrantCount: 1 },
      etag: '"1"',
    });
    await expect(adapter.getShareGrant("share-1"))
      .resolves.toEqual({ value: share, etag: '"1"' });
    await expect(adapter.revokeProjectShareGrants("project-1"))
      .resolves.toEqual({ projectId: "project-1", activeGrantCount: 0 });
    await expect(adapter.revokeShareGrant("share-1", ' "1" '))
      .resolves.toEqual({ value: revoked, etag: '"2"' });
  });
});

function createAdapter(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchSharesApi(createWorkbenchApiClient({
    baseUrl: "http://workbench.test/api/v1",
    fetch: vi.fn(fetch),
  }));
}
