import { describe, expect, it, vi } from "vitest";
import { SourcePrototypePreviewService } from "../src/modules/source-prototype-preview/source-prototype-preview.service.js";

function fixture(schemaVersion: number) {
  const detail = {
    kind: "prototype",
    schemaVersion,
    status: "ready",
    contentMode: "inline",
    checksum: "a".repeat(64),
  };
  const artifacts = { getVersion: vi.fn(async () => ({ detail })) };
  const shares = { getPublicArtifactVersion: vi.fn(async () => ({ detail })) };
  const share = {
    id: "share-one",
    revision: 3,
    artifactVersionId: "version-one",
    status: "active",
    scope: "view",
    expiresAt: new Date(Date.now() + 30_000),
  };
  const db = { shareGrant: { findUnique: vi.fn(async () => share) } };
  const config = {
    createSourceCapability: vi.fn(() => ({
      url: "https://preview.example.test/preview/capability",
      expiresAt: new Date(Date.now() + 20_000),
    })),
  };
  const service = new SourcePrototypePreviewService(
    db as never,
    artifacts as never,
    shares as never,
    config as never,
  );
  return { service, artifacts, shares, share, config, detail };
}

describe("Version-bound artifact preview capability", () => {
  it.each([1, 2])(
    "authorizes both private and public schemaVersion %s",
    async (schemaVersion) => {
      const { service, artifacts, shares, config, share } =
        fixture(schemaVersion);
      await service.createPrivate("viewer-one", "artifact-one", "version-one");
      expect(artifacts.getVersion).toHaveBeenCalledWith(
        "viewer-one",
        "artifact-one",
        "version-one",
      );
      expect(config.createSourceCapability).toHaveBeenCalledWith({
        artifactId: "artifact-one",
        artifactVersionId: "version-one",
        checksum: "a".repeat(64),
        principalId: "viewer-one",
      });
      await service.createPublic("share-token", "artifact-one", "version-one");
      expect(shares.getPublicArtifactVersion).toHaveBeenCalledWith(
        "share-token",
        "artifact-one",
        "version-one",
      );
      expect(config.createSourceCapability).toHaveBeenLastCalledWith(
        {
          artifactId: "artifact-one",
          artifactVersionId: "version-one",
          checksum: "a".repeat(64),
          shareId: share.id,
          shareRevision: share.revision,
        },
        expect.any(Date),
        share.expiresAt,
      );
    },
  );
  it.each(["revoked", "expired", "different-version"])(
    "rejects changed public identity %s",
    async (state) => {
      const { service, share, config } = fixture(1);
      if (state === "different-version")
        share.artifactVersionId = "version-two";
      else share.status = state;
      await expect(
        service.createPublic("share-token", "artifact-one", "version-one"),
      ).rejects.toMatchObject({ status: 404 });
      expect(config.createSourceCapability).not.toHaveBeenCalled();
    },
  );
  it("does not mint a preview for unready or unauthorized content", async () => {
    const { service, artifacts, detail, config } = fixture(1);
    detail.status = "generating";
    await expect(
      service.createPrivate("viewer-one", "artifact-one", "version-one"),
    ).rejects.toMatchObject({ status: 404 });
    artifacts.getVersion.mockRejectedValueOnce(new Error("forbidden"));
    await expect(
      service.createPrivate("stranger", "artifact-one", "version-one"),
    ).rejects.toThrow("forbidden");
    expect(config.createSourceCapability).not.toHaveBeenCalled();
  });
});
