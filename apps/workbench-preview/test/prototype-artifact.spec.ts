import { createHash } from "node:crypto";
import { canonicalJson } from "@workbench/workbench-contracts";
import { createSourcePrototypePreviewToken } from "@workbench/workbench-preview-token";
import { describe, expect, it, vi } from "vitest";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import { PreviewService } from "../src/preview.service.js";
import { getPreview } from "./preview-request.fixture.js";

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function fixture(withAsset = false) {
  const content = prototypeDocumentFixture();
  const bytes = Buffer.from("a controlled image object");
  const asset = {
    id: "image-one",
    name: "Image",
    kind: "image" as const,
    blobId: "blob-one",
    mediaType: "image/png" as const,
    byteSize: bytes.length,
    sha256: digest(bytes),
    width: 1,
    height: 1,
  };
  if (withAsset) content.assets.push(asset);
  const checksum = digest(canonicalJson(content));
  const version = {
    projectId: "project-one",
    schemaVersion: 1,
    content,
    checksum,
    assets: withAsset
      ? [
          {
            ...asset,
            assetId: asset.id,
            byteSize: BigInt(asset.byteSize),
            blob: {
              storageKey: "blobs/private-image",
              status: "ready",
              deletedAt: null,
              byteSize: BigInt(asset.byteSize),
              sha256: asset.sha256,
              mediaType: asset.mediaType,
            },
          },
        ]
      : [],
  };
  const db = {
    artifactVersion: { findFirst: vi.fn(async () => version) },
    projectMember: {
      findFirst: vi.fn(async () => ({ projectId: version.projectId })),
    },
    shareGrant: { findFirst: vi.fn(async () => ({ id: "share-one" })) },
  };
  const storage = { readAsset: vi.fn(async () => bytes) };
  const secret = Buffer.alloc(32, 14);
  const config = {
    tokenSecret: secret,
    tokenMaximumTtlSeconds: 3600,
    maximumHtmlBytes: 2 * 1024 * 1024,
    webOrigin: "https://workbench.test",
  };
  const service = new PreviewService(db as never, storage as never, config);
  const token = (publicShare = false) =>
    createSourcePrototypePreviewToken(
      {
        artifactId: "artifact-one",
        artifactVersionId: "version-one",
        checksum,
        expiresAt: new Date(Date.now() + 60_000),
        ...(publicShare
          ? { shareId: "share-one", shareRevision: 3 }
          : { principalId: "viewer-one" }),
      },
      secret,
    );
  return { service, db, version, storage, token, config };
}

describe("Current IR artifact preview", () => {
  it.each([false, true])(
    "renders actual screens and shared runtime for public=%s",
    async (publicShare) => {
      const { service, db, token } = fixture();
      const preview = await getPreview(service, token(publicShare));
      const chunks = [];
      for await (const chunk of preview.body) chunks.push(Buffer.from(chunk));
      const html = Buffer.concat(chunks).toString();
      expect(html).toContain('data-wb-screen="screen-a"');
      expect(html).toContain('data-wb-screen="screen-b"');
      expect(html).toContain("workbench.export-runtime.v1");
      expect(preview.contentSecurityPolicy).toContain("script-src-attr 'none'");
      expect(preview.contentSecurityPolicy).toContain("connect-src 'none'");
      if (publicShare) {
        expect(db.projectMember.findFirst).not.toHaveBeenCalled();
        expect(db.shareGrant.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              artifactVersionId: "version-one",
              revision: 3,
              status: "active",
              scope: "view",
              release: expect.objectContaining({
                artifactPins: {
                  some: expect.objectContaining({
                    artifactId: "artifact-one",
                    artifactVersionId: "version-one",
                    artifactVersion: { checksum: fixture().version.checksum },
                  }),
                },
              }),
            }),
          }),
        );
      }
      await preview.dispose();
    },
  );

  it("rejects membership removal, revocation and stored content drift before rendering", async () => {
    const { service, db, version, storage, token } = fixture();
    db.projectMember.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.resolve(token())).rejects.toThrow("PREVIEW_NOT_FOUND");
    db.shareGrant.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.resolve(token(true))).rejects.toThrow(
      "PREVIEW_NOT_FOUND",
    );
    version.content.title = "modified";
    await expect(service.resolve(token())).rejects.toThrow("PREVIEW_NOT_FOUND");
    expect(storage.readAsset).not.toHaveBeenCalled();
  });

  it("resolves only ready assets matching the fixed document and rejects corruption and oversized input", async () => {
    const { service, version, storage, token, config } = fixture(true);
    await service.resolve(token(true));
    expect(storage.readAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "blobs/private-image",
        sha256: version.assets[0]!.sha256,
      }),
      config.maximumHtmlBytes,
      undefined,
    );
    version.assets[0]!.blob.status = "quarantined";
    await expect(service.resolve(token())).rejects.toThrow("PREVIEW_NOT_FOUND");
    version.assets[0]!.blob.status = "ready";
    storage.readAsset.mockRejectedValueOnce(
      new Error("READY_OBJECT_SHA256_MISMATCH"),
    );
    await expect(service.resolve(token())).rejects.toThrow(
      "READY_OBJECT_SHA256_MISMATCH",
    );
    config.maximumHtmlBytes = 1;
    await expect(service.resolve(token())).rejects.toThrow("PREVIEW_NOT_FOUND");
  });
});
