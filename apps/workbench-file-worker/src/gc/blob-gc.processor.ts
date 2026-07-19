import type { FileStoragePort } from "../storage/storage.port.js";
import type { BlobGcStore } from "./blob-gc.store.js";

export type BlobGcOutcome =
  | "complete"
  | "deleted"
  | "exhausted"
  | "missing"
  | "not_due"
  | "referenced";

export class BlobGcProcessor {
  constructor(
    private readonly store: BlobGcStore,
    private readonly storage: Pick<FileStoragePort, "deleteObject">,
    private readonly maximumAttempts: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(blobId: string, signal?: AbortSignal): Promise<BlobGcOutcome> {
    const claim = await this.store.claim(blobId, this.clock(), this.maximumAttempts);
    if (claim.kind !== "delete") return claim.kind;

    try {
      await this.storage.deleteObject(claim.storageKey, signal);
    } catch (error) {
      await this.store.recordFailure(
        blobId,
        "BLOB_GC_STORAGE_DELETE_FAILED",
        "Object storage delete did not complete",
        this.clock(),
      );
      throw error;
    }
    await this.store.complete(blobId, this.clock());
    return "deleted";
  }
}
