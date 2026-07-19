import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchPublicSharesApi } from "./index";

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
const share = {
  id: "share-1",
  releaseId: release.id,
  createdById: "principal-1",
  scope: "remix",
  status: "active",
  revision: 1,
  expiresAt: null,
  revokedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("Workbench Public Shares API adapter", () => {
  it("loads token-scoped snapshots and remixes through public-only routes", async () => {
    const token = `wbs_${"B".repeat(43)}`;
    const { createdById: _createdById, ...publicRelease } = release;
    const publicShare = {
      shareId: share.id,
      scope: "remix",
      expiresAt: null,
      release: publicRelease,
    };
    const publicVersion = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      version: 1,
      kind: "code",
      schemaVersion: 1,
      status: "ready",
      checksum: "e".repeat(64),
      citations: [],
      createdAt: timestamp,
      contentMode: "inline",
      content: { language: "typescript" },
    };
    const project = {
      id: "project-remix",
      workspaceId: "workspace-1",
      title: "Remix",
      summary: null,
      status: "active",
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const remix = {
      project,
      lineage: {
        targetProjectId: project.id,
        sourceReleaseId: release.id,
        sourceShareId: share.id,
        createdById: "principal-2",
        workspaceId: project.workspaceId,
        createdAt: timestamp,
      },
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const adapter = createAdapter(async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toContain(`/public/shares/${token}`);
      if (url.pathname.endsWith("/assets/image-1/content")) {
        return new Response(bytes, { headers: { ETag: `"${"f".repeat(64)}"` } });
      }
      if (url.pathname.endsWith("/versions/version-1/content")) {
        return new Response(bytes, {
          headers: {
            "Content-Type": "application/octet-stream",
            ETag: `"${"e".repeat(64)}"`,
          },
        });
      }
      if (url.pathname.endsWith("/versions/version-1")) {
        return Response.json(publicVersion, { headers: { ETag: `"${publicVersion.checksum}"` } });
      }
      if (url.pathname.endsWith("/remixes")) {
        expect(request.headers.get("idempotency-key")).toBe("remix:req_123");
        expect(await request.json()).toEqual({ workspaceId: "workspace-1", title: "Remix" });
        return Response.json(remix, { status: 201, headers: { ETag: '"0"' } });
      }
      return Response.json(publicShare, { headers: { ETag: `"${manifestSha256}"` } });
    });

    await expect(adapter.getPublicShare(token)).resolves.toEqual({
      value: publicShare,
      etag: `"${manifestSha256}"`,
    });
    await expect(adapter.getPublicSharedArtifactVersion(token, "artifact-1", "version-1"))
      .resolves.toEqual({ value: publicVersion, etag: `"${publicVersion.checksum}"` });
    const asset = await adapter.getPublicSharedArtifactVersionAssetContent(
      token,
      "artifact-1",
      "version-1",
      "image-1",
    );
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(bytes);
    const content = await adapter.getPublicSharedArtifactVersionContent(
      token,
      "artifact-1",
      "version-1",
    );
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
    await expect(adapter.createProjectRemix(
      token,
      { workspaceId: "workspace-1", title: "Remix" },
      "remix:req_123",
    )).resolves.toEqual({ value: remix, etag: '"0"' });
  });
});

function createAdapter(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchPublicSharesApi(createWorkbenchApiClient({
    baseUrl: "http://workbench.test/api/v1",
    fetch: vi.fn(fetch),
  }));
}
