import type { Response } from "express";
import { Readable } from "node:stream";
import { StreamableFile } from "@nestjs/common";
import {
  ArtifactsController,
  parseArtifactKind,
  parseArtifactLimit,
} from "../src/modules/artifacts/artifacts.controller.js";
import { entityTagMatches } from "../src/common/byte-content.js";
import { UnsatisfiedByteRangeProblem } from "../src/common/byte-content.js";

const artifact = {
  id: "artifact_1",
  projectId: "project_1",
  kind: "data" as const,
  title: "Research",
  revision: 9,
  currentVersion: null,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
};

function responseDouble() {
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe("ArtifactsController", () => {
  it("strictly parses Artifact filters and page limits", () => {
    expect(parseArtifactKind("prototype")).toBe("prototype");
    expect(parseArtifactKind(undefined)).toBeUndefined();
    expect(parseArtifactLimit("100")).toBe(100);
    expect(parseArtifactLimit(undefined)).toBeUndefined();
    expect(() => parseArtifactKind("unknown")).toThrow();
    expect(() => parseArtifactLimit("0")).toThrow();
    expect(() => parseArtifactLimit("1.5")).toThrow();
    expect(() => parseArtifactLimit("101")).toThrow();
  });

  it("uses weak comparison semantics for If-None-Match on GET", () => {
    expect(entityTagMatches('"other", W/"9"', '"9"')).toBe(true);
    expect(entityTagMatches("*", '"9"')).toBe(true);
    expect(entityTagMatches('"8"', '"9"')).toBe(false);
  });

  it("sets the numeric Artifact revision ETag and returns 304 without a body", async () => {
    const service = { get: vi.fn().mockResolvedValue(artifact) };
    const controller = new ArtifactsController(service as never);
    const response = responseDouble();

    await expect(controller.get(
      { id: "principal_1" } as never,
      "artifact_1",
      'W/"9"',
      response as unknown as Response,
    )).resolves.toBeUndefined();
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"9"');
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-cache");
    expect(response.status).toHaveBeenCalledWith(304);
  });

  it("passes validated project Artifact list filters to the service", async () => {
    const service = { list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) };
    const controller = new ArtifactsController(service as never);

    await expect(controller.list(
      { id: "principal_1" } as never,
      "project_1",
      "data",
      "cursor_1",
      "25",
    )).resolves.toEqual({ items: [], nextCursor: null });
    expect(service.list).toHaveBeenCalledWith(
      "principal_1",
      "project_1",
      "data",
      "cursor_1",
      25,
    );
  });

  it("creates an image Artifact through the project command and returns its immutable Location", async () => {
    const result = imageCreation();
    const service = { create: vi.fn().mockResolvedValue(result) };
    const controller = new ArtifactsController(service as never);
    const response = responseDouble();
    const request = {
      kind: "image" as const,
      title: "Hero image",
      source: { kind: "file" as const, fileAssetId: "file_1" },
    };

    await expect(controller.create(
      { id: "principal_1" } as never,
      "project_1",
      "artifact:create-1",
      request,
      response as unknown as Response,
    )).resolves.toEqual(result);

    expect(service.create).toHaveBeenCalledWith(
      "principal_1",
      "project_1",
      "artifact:create-1",
      request,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Location",
      "/api/v1/artifacts/artifact_image/versions/version_image",
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("returns the strict version detail on an ETag miss and emits its strong ETag", async () => {
    const detail = {
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      version: 1,
      kind: "data",
      schemaVersion: 1,
      status: "ready",
      checksum: "a".repeat(64),
      citations: [],
      createdByRunId: null,
      knowledgeReleaseId: null,
      createdAt: "2026-07-12T00:00:00.000Z",
      contentMode: "inline",
      content: { ok: true },
    };
    const service = {
      getVersion: vi.fn().mockResolvedValue({ detail, etag: '"manifest-hash"' }),
    };
    const controller = new ArtifactsController(service as never);
    const response = responseDouble();

    await expect(controller.getVersion(
      { id: "principal_1" } as never,
      "artifact_1",
      "version_1",
      '"different"',
      response as unknown as Response,
    )).resolves.toEqual(detail);
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"manifest-hash"');
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-cache");
    expect(response.status).not.toHaveBeenCalled();
  });

  it("streams a ranged Artifact Blob with immutable content headers", async () => {
    const body = Readable.from("data");
    const service = {
      getContent: vi.fn().mockResolvedValue({
        notModified: false,
        etag: `"${"b".repeat(64)}"`,
        body,
        byteSize: 4,
        mediaType: "image/png",
        range: { start: 3, end: 6 },
        contentRange: "bytes 3-6/10",
      }),
    };
    const controller = new ArtifactsController(service as never);
    const response = responseDouble();

    const result = await controller.getVersionContent(
      { id: "principal_1" } as never,
      "artifact_1",
      "version_1",
      "bytes=3-6",
      '"different"',
      response as unknown as Response,
    );

    expect(result).toBeInstanceOf(StreamableFile);
    expect(service.getContent).toHaveBeenCalledWith(
      "principal_1",
      "artifact_1",
      "version_1",
      "bytes=3-6",
      '"different"',
    );
    expect(response.status).toHaveBeenCalledWith(206);
    expect(response.setHeader).toHaveBeenCalledWith("ETag", `"${"b".repeat(64)}"`);
    expect(response.setHeader).toHaveBeenCalledWith("Content-Range", "bytes 3-6/10");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
  });

  it("adds an unsatisfied Content-Range header before propagating a 416", async () => {
    const service = {
      getContent: vi.fn().mockRejectedValue(new UnsatisfiedByteRangeProblem(10)),
    };
    const controller = new ArtifactsController(service as never);
    const response = responseDouble();

    await expect(controller.getVersionContent(
      { id: "principal_1" } as never,
      "artifact_1",
      "version_1",
      "bytes=20-30",
      undefined,
      response as unknown as Response,
    )).rejects.toBeInstanceOf(UnsatisfiedByteRangeProblem);
    expect(response.setHeader).toHaveBeenCalledWith("Content-Range", "bytes */10");
  });

  it("streams a pinned ArtifactVersion asset through the version-scoped route", async () => {
    const body = Readable.from("font");
    const service = {
      getAssetContent: vi.fn().mockResolvedValue({
        notModified: false,
        etag: `"${"c".repeat(64)}"`,
        body,
        byteSize: 4,
        mediaType: "font/woff2",
        range: null,
        contentRange: null,
      }),
    };
    const controller = new ArtifactsController(service as never);
    const response = responseDouble();

    const result = await controller.getVersionAssetContent(
      { id: "principal_1" } as never,
      "artifact_1",
      "version_1",
      "font_inter",
      undefined,
      undefined,
      response as unknown as Response,
    );

    expect(result).toBeInstanceOf(StreamableFile);
    expect(service.getAssetContent).toHaveBeenCalledWith(
      "principal_1",
      "artifact_1",
      "version_1",
      "font_inter",
      undefined,
      undefined,
    );
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "font/woff2");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Length", "4");
  });
});

function imageCreation() {
  const currentVersion = {
    artifactId: "artifact_image",
    artifactVersionId: "version_image",
    version: 1,
    kind: "image" as const,
    schemaVersion: 1,
    status: "ready" as const,
    checksum: "d".repeat(64),
    createdByRunId: null,
    createdAt: "2026-07-14T07:00:00.000Z",
  };
  return {
    artifact: {
      id: "artifact_image",
      projectId: "project_1",
      kind: "image" as const,
      title: "Hero image",
      revision: 1,
      currentVersion,
      createdAt: currentVersion.createdAt,
      updatedAt: currentVersion.createdAt,
    },
    artifactVersion: {
      ...currentVersion,
      citations: [],
      knowledgeReleaseId: null,
      contentMode: "blob" as const,
      blob: {
        blobId: "blob_image",
        mediaType: "image/png",
        byteSize: 42,
        sha256: currentVersion.checksum,
        fileName: null,
      },
    },
  };
}
