import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import {
  normalizeStrongEtag,
  WorkbenchContractError,
} from "../../../transport/contracts";
import { WorkbenchArtifactsApi } from "./index";

const createdAt = "2026-07-12T00:00:00.000Z";
const checksum = "a".repeat(64);
const version = {
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  version: 1,
  kind: "document",
  schemaVersion: 1,
  status: "ready",
  checksum,
  createdByRunId: null,
  createdAt,
};
const artifact = {
  id: "artifact-1",
  projectId: "project-1",
  kind: "document",
  title: "Delivery notes",
  revision: 2,
  currentVersion: version,
  createdAt,
  updatedAt: createdAt,
};

describe("Artifacts API contracts", () => {
  it("lists project Artifacts with isolated filters and strict parsing", async () => {
    const responses = [
      { items: [artifact], nextCursor: "cursor-2" },
      { items: [artifact], nextCursor: null, unexpected: true },
    ];
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/v1/projects/project-1/artifacts");
      expect(url.searchParams.get("kind")).toBe("document");
      expect(url.searchParams.get("cursor")).toBe("cursor-1");
      expect(url.searchParams.get("limit")).toBe("10");
      return Response.json(responses.shift());
    });
    const service = createService(fetch);

    await expect(service.listArtifacts("project-1", {
      kind: "document",
      cursor: "cursor-1",
      limit: 10,
    })).resolves.toEqual({ items: [artifact], nextCursor: "cursor-2" });
    await expect(service.listArtifacts("project-1", {
      kind: "document",
      cursor: "cursor-1",
      limit: 10,
    })).rejects.toBeInstanceOf(WorkbenchContractError);
  });

  it("creates an image Artifact from a ready File with a caller-owned receipt key", async () => {
    const creation = imageCreation();
    const requestBody = {
      kind: "image" as const,
      title: "Hero image",
      source: { kind: "file" as const, fileAssetId: "file-1" },
    };
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/v1/projects/project-1/artifacts");
      expect(request.headers.get("idempotency-key")).toBe("artifact:create-1");
      expect(await request.json()).toEqual(requestBody);
      return Response.json(creation, {
        status: 201,
        headers: { Location: "/api/v1/artifacts/artifact-image/versions/version-image" },
      });
    });
    const service = createService(fetch);

    await expect(service.createArtifact(
      "project-1",
      requestBody,
      "artifact:create-1",
    )).resolves.toEqual(creation);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps mutable revision ETags separate from immutable manifest ETags", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/artifacts/artifact-1") {
        return Response.json(artifact, { headers: { ETag: '"2"' } });
      }
      if (url.pathname === "/api/v1/artifacts/artifact-1/versions/version-1") {
        return Response.json({
          ...version,
          contentMode: "inline",
          content: { text: "Ready" },
          citations: [],
          knowledgeReleaseId: null,
        }, { headers: { ETag: '"manifest:abc123"' } });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    const service = createService(fetch);

    await expect(service.getArtifact("artifact-1"))
      .resolves.toEqual({ value: artifact, etag: '"2"' });
    await expect(service.getArtifactVersion("artifact-1", "version-1"))
      .resolves.toMatchObject({
        etag: '"manifest:abc123"',
        value: { contentMode: "inline", content: { text: "Ready" } },
      });
    expect(() => normalizeStrongEtag('W/"manifest:abc123"')).toThrow(/strong ETag/);
  });

  it("creates a Prototype ArtifactVersion with Artifact CAS and a stable receipt key", async () => {
    const document = prototypeDocument();
    const requestBody = {
      kind: "prototype" as const,
      baseArtifactVersionId: "version-1",
      document,
    };
    const detail = {
      artifactId: "artifact-1",
      artifactVersionId: "version-2",
      version: 2,
      kind: "prototype",
      schemaVersion: 1,
      status: "ready",
      checksum: "b".repeat(64),
      citations: [],
      createdByRunId: null,
      knowledgeReleaseId: null,
      createdAt,
      contentMode: "inline",
      content: document,
    };
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/v1/artifacts/artifact-1/versions");
      expect(request.headers.get("if-match")).toBe('"2"');
      expect(request.headers.get("idempotency-key")).toBe("artifact-version:request-1");
      expect(await request.json()).toEqual(requestBody);
      return Response.json(detail, { status: 201, headers: { ETag: '"3"' } });
    });
    const service = createService(fetch);

    await expect(service.createArtifactVersion(
      "artifact-1",
      requestBody,
      '"2"',
      "artifact-version:request-1",
    )).resolves.toEqual({ value: detail, etag: '"3"' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accepts the strict Blob metadata union and rejects internal storage fields", async () => {
    const details = [
      blobDetail(),
      { ...blobDetail(), blob: { ...blobDetail().blob, storageKey: "private/key" } },
    ];
    const service = createService(async () => Response.json(details.shift(), {
      headers: { ETag: '"manifest:def456"' },
    }));

    await expect(service.getArtifactVersion("artifact-1", "version-1"))
      .resolves.toMatchObject({ value: { contentMode: "blob", blob: { blobId: "blob-1" } } });
    await expect(service.getArtifactVersion("artifact-1", "version-1"))
      .rejects.toBeInstanceOf(WorkbenchContractError);
  });

  it("strictly parses immutable version pages", async () => {
    const service = createService(async () => Response.json({
      items: [{ ...version, contentMode: "inline" }],
      nextCursor: null,
    }));

    await expect(service.listArtifactVersions("artifact-1", { limit: 20 }))
      .resolves.toEqual({ items: [{ ...version, contentMode: "inline" }], nextCursor: null });
  });

  it("loads an immutable Prototype asset as an authenticated Blob", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe(
        "/api/v1/artifacts/artifact-1/versions/version-1/assets/image-1/content",
      );
      expect(request.headers.get("accept")).toBe("application/octet-stream");
      expect(request.credentials).toBe("same-origin");
      expect(request.headers.get("authorization")).toBeNull();
      return new Response(bytes, { headers: { "Content-Type": "image/png" } });
    });
    const service = new WorkbenchArtifactsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    const content = await service.getArtifactVersionAssetContent(
      "artifact-1",
      "version-1",
      "image-1",
    );

    expect(content).toBeInstanceOf(Blob);
    expect(content.type).toBe("image/png");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
  });

  it("loads immutable Artifact content as an authenticated Blob", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe(
        "/api/v1/artifacts/artifact-1/versions/version-1/content",
      );
      expect(request.headers.get("accept")).toBe("application/octet-stream");
      expect(request.credentials).toBe("same-origin");
      return new Response(bytes, { headers: { "Content-Type": "image/png" } });
    });
    const service = new WorkbenchArtifactsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    const content = await service.getArtifactVersionContent("artifact-1", "version-1");

    expect(content.type).toBe("image/png");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
  });
});

function blobDetail() {
  return {
    ...version,
    contentMode: "blob",
    citations: [],
    knowledgeReleaseId: null,
    blob: {
      blobId: "blob-1",
      mediaType: "application/octet-stream",
      byteSize: 42,
      sha256: "b".repeat(64),
      fileName: "artifact.bin",
    },
  };
}

function imageCreation() {
  const imageVersion = {
    artifactId: "artifact-image",
    artifactVersionId: "version-image",
    version: 1,
    kind: "image" as const,
    schemaVersion: 1,
    status: "ready" as const,
    checksum: "c".repeat(64),
    createdByRunId: null,
    createdAt,
  };
  return {
    artifact: {
      id: "artifact-image",
      projectId: "project-1",
      kind: "image" as const,
      title: "Hero image",
      revision: 1,
      currentVersion: imageVersion,
      createdAt,
      updatedAt: createdAt,
    },
    artifactVersion: {
      ...imageVersion,
      citations: [],
      knowledgeReleaseId: null,
      contentMode: "blob" as const,
      blob: {
        blobId: "blob-image",
        mediaType: "image/png",
        byteSize: 42,
        sha256: imageVersion.checksum,
        fileName: null,
      },
    },
  };
}

function createService(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchArtifactsApi(createWorkbenchApiClient({
    baseUrl: "http://workbench.test/api/v1",
    fetch,
  }));
}

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "prototype-document",
    title: "Prototype",
    revision: 2,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "frame-root",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{
      id: "frame-root",
      screenId: "screen-home",
      parentId: null,
      name: "Root",
      visible: true,
      layout: {
        mode: "absolute" as const,
        x: literal(0),
        y: literal(0),
        width: literal(390),
        height: literal(844),
        display: "block" as const,
        direction: "column" as const,
        gap: literal(0),
        padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
        align: "stretch" as const,
        justify: "start" as const,
        gridColumns: null,
        overflow: "hidden" as const,
      },
      style: {
        opacity: 1,
        rotation: 0,
        transformOrigin: { x: 0.5, y: 0.5 },
        fill: null,
        stroke: null,
        radii: {
          topLeft: literal(0),
          topRight: literal(0),
          bottomRight: literal(0),
          bottomLeft: literal(0),
        },
        shadowTokenIds: [],
        typography: null,
      },
      actionIds: [],
      bindingIds: [],
      motionIds: [],
      kind: "frame" as const,
      childIds: [],
      clipContent: true,
    }],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}
