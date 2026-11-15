import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import { loadPrototypeAssets } from "../src/prototypes/prototype-assets.js";

function fixture() {
  const document = prototypeDocumentFixture(), bytes = Buffer.from("verified-image-bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  document.assets = [{ id: "image-asset", kind: "image", name: "Image", blobId: "blob-image", mediaType: "image/png", byteSize: bytes.length, sha256, width: 1, height: 1 }];
  const findFirst = vi.fn(async () => ({ blob: { status: "ready", deletedAt: null, storageKey: "private/verified", sha256, byteSize: BigInt(bytes.length), mediaType: "image/png" } }));
  const getObject = vi.fn(async () => ({ body: Readable.from([bytes]) as never, byteSize: bytes.length, mediaType: "image/png" }));
  return { document, bytes, db: { artifactVersionAsset: { findFirst } }, reader: { getObject }, findFirst, getObject };
}
describe("Prototype immutable binary asset loading", () => {
  it("requires a ready project-owned immutable pin and verifies bytes before rendering", async () => {
    const f = fixture(); const loaded = await loadPrototypeAssets(f.db as never, f.document, "project-a", f.reader);
    expect(loaded[0]).toMatchObject({ assetId: "image-asset", blobId: "blob-image", bytes: f.bytes });
    expect(f.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ projectId: "project-a", artifactVersion: { projectId: "project-a", status: "ready" } }) }));
  });
  it("does not read storage for an unavailable or foreign pin", async () => {
    const f = fixture(); f.findFirst.mockResolvedValueOnce(null as never);
    await expect(loadPrototypeAssets(f.db as never, f.document, "project-b", f.reader)).rejects.toThrow("PROTOTYPE_ASSET_PIN_UNAVAILABLE");
    expect(f.getObject).not.toHaveBeenCalled();
  });
  it("rejects corrupted bytes rather than publishing a placeholder", async () => {
    const f = fixture(); f.getObject.mockResolvedValueOnce({ body: Readable.from([Buffer.alloc(f.bytes.length)]) as never, byteSize: f.bytes.length, mediaType: "image/png" });
    await expect(loadPrototypeAssets(f.db as never, f.document, "project-a", f.reader)).rejects.toThrow("PROTOTYPE_ASSET_INTEGRITY_FAILURE");
  });
  it("fails closed without the source reader and observes cancellation", async () => {
    const f = fixture(); await expect(loadPrototypeAssets(f.db as never, f.document, "project-a")).rejects.toThrow("PROTOTYPE_ASSET_READER_UNAVAILABLE");
    const controller = new AbortController(); controller.abort();
    await expect(loadPrototypeAssets(f.db as never, f.document, "project-a", f.reader, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.findFirst).not.toHaveBeenCalled();
  });
});
