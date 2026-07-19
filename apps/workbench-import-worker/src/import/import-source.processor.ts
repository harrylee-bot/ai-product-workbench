import { Readable } from "node:stream";
import type { ScanPort } from "@workbench/workbench-content-security";
import { RetryableScanError } from "@workbench/workbench-content-security";
import { RetryableImportError, TerminalImportError } from "../errors.js";
import type { S3ImportStorageAdapter } from "../storage/s3-import-storage.adapter.js";
import type { PrismaImportSourceStore } from "./import-source.store.js";
import type { ImportProviderRegistry } from "./provider-registry.js";
import { maximumImportSourceManifestBlobs } from "./source-types.js";

export class ImportSourceProcessor {
  constructor(
    private readonly store: PrismaImportSourceStore,
    private readonly providers: ImportProviderRegistry,
    private readonly scanner: ScanPort,
    private readonly storage: S3ImportStorageAdapter,
    private readonly maximumSourceBytes: number,
  ) {}

  async process(sourceId: string, queueJobId: string, leaseMs: number, maximumAttempts: number, signal?: AbortSignal) {
    const start = await this.store.beginAttempt(sourceId, { queueJobId, leaseMs });
    if (start.kind !== "run") return start.kind;
    const heartbeat = setInterval(() => void this.store.touchAttempt(start.attemptId, start.leaseToken, leaseMs).catch(() => undefined), Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      const frozen = await this.providers.freeze(start.command.request, signal);
      const total = frozen.blobs.reduce((sum, blob) => sum + blob.bytes.byteLength, 0);
      if (frozen.blobs.length === 0 || frozen.blobs.length > maximumImportSourceManifestBlobs || total > this.maximumSourceBytes) throw new TerminalImportError("IMPORT_SOURCE_LIMIT", "The frozen source exceeds the source manifest limit");
      const reserved = [];
      for (const blob of frozen.blobs) {
        const scan = await this.scanner.scan({ body: Readable.from([blob.bytes]), byteSize: blob.bytes.byteLength, sha256: blob.sha256, mediaType: blob.mediaType, signal });
        if (scan.status !== "clean") throw new TerminalImportError("IMPORT_MALWARE_DETECTED", "The imported source failed malware scanning");
        const reservation = await this.store.reserveBlob({ sha256: blob.sha256, mediaType: blob.mediaType, byteSize: blob.bytes.byteLength });
        await this.storage.put({ storageKey: reservation.canonicalStorageKey, sha256: blob.sha256, byteSize: blob.bytes.byteLength, mediaType: blob.mediaType }, blob.bytes, signal);
        await this.store.publishCleanBlob(reservation, scan);
        reserved.push(reservation);
      }
      await this.store.completeReady(start.attemptId, start.leaseToken, frozen, reserved);
      return "ready" as const;
    } catch (error) {
      const normalized = error instanceof RetryableScanError
        ? new RetryableImportError(error.code, error.safeDetail, { cause: error })
        : error;
      const disposition = error instanceof TerminalImportError
        ? "terminal"
        : start.attemptNumber >= maximumAttempts
          ? "exhausted"
          : "retryable";
      await this.store.recordFailure(start.attemptId, start.leaseToken, normalized, disposition);
      return disposition === "retryable" ? "retryable_failed" as const : "failed" as const;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
