import { createHash } from "node:crypto";
import type { PrototypeDocument } from "@workbench/workbench-contracts";
import { consumeVerifiedReadyObjectBody } from "@workbench/workbench-content-security";
import type { PrismaClient } from "@workbench/workbench-db";
import type { ExportBinaryAsset } from "@workbench/workbench-export-core";
import type { RuntimeReadyBlobReader } from "../storage/runtime-ready-blob-reader.port.js";

/** Only load immutable, project-owned artifact asset pins. Never turn an
 * unverified/missing image into a placeholder in a supposedly ready revision. */
export async function loadPrototypeAssets(
  db: PrismaClient, document: PrototypeDocument, projectId: string,
  reader?: RuntimeReadyBlobReader, signal?: AbortSignal,
): Promise<ExportBinaryAsset[]> {
  const assets: ExportBinaryAsset[] = [];
  let remaining = 64 * 1024 * 1024;
  for (const asset of document.assets) {
    if (asset.kind === "icon") continue;
    if (!reader) throw new Error("PROTOTYPE_ASSET_READER_UNAVAILABLE");
    if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
    const pin = await db.artifactVersionAsset.findFirst({ where: {
      projectId, assetId: asset.id, blobId: asset.blobId, kind: asset.kind,
      sha256: asset.sha256, byteSize: BigInt(asset.byteSize), mediaType: asset.mediaType,
      artifactVersion: { projectId, status: "ready" },
    }, include: { blob: true } });
    if (!pin || pin.blob.status !== "ready" || pin.blob.deletedAt !== null) throw new Error("PROTOTYPE_ASSET_PIN_UNAVAILABLE");
    const blob = pin.blob;
    if (blob.sha256 !== asset.sha256 || Number(blob.byteSize) !== asset.byteSize || blob.mediaType !== asset.mediaType) {
      throw new Error("PROTOTYPE_ASSET_PIN_MISMATCH");
    }
    remaining -= asset.byteSize;
    if (remaining < 0) throw new Error("PROTOTYPE_ASSET_BUDGET_EXCEEDED");
    const object = await reader.getObject({ storageKey: blob.storageKey, sha256: asset.sha256, byteSize: asset.byteSize, mediaType: asset.mediaType }, signal);
    const bytes = await consumeVerifiedReadyObjectBody(object.body, asset.byteSize);
    if (bytes.byteLength !== asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      throw new Error("PROTOTYPE_ASSET_INTEGRITY_FAILURE");
    }
    assets.push({ assetId: asset.id, kind: asset.kind, blobId: asset.blobId, mediaType: asset.mediaType, byteSize: asset.byteSize, sha256: asset.sha256, bytes });
  }
  return assets;
}
