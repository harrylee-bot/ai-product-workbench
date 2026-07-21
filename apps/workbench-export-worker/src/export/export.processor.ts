import { createHash } from "node:crypto";
import { ReadyObjectIntegrityError } from "@workbench/workbench-content-security";
import {
  TerminalExportError,
  boundedDetail,
  buildExport,
  type ExportBuildRequest,
} from "@workbench/workbench-export-core";
import type { ExportWorkerConfig } from "../config.js";
import type { BrowserExportService } from "../browser/browser-export.service.js";
import type { ExportStoragePort } from "../storage/storage.port.js";
import type { PrismaExportStore } from "./export.store.js";
import type { ExportSourceLoader } from "./source-loader.js";

export class ExportProcessor {
  constructor(
    private readonly store: PrismaExportStore,
    private readonly sourceLoader: ExportSourceLoader,
    private readonly storage: ExportStoragePort,
    private readonly browser: BrowserExportService,
    private readonly config: Pick<ExportWorkerConfig, "maximumOutputBytes">,
  ) {}

  async process(
    exportJobId: string,
    signal?: AbortSignal,
    retry = { retryCount: 0, retryLimit: 0 },
  ) {
    try {
      const started = await this.store.start(exportJobId);
      if (started.kind !== "run") return started;
      if (signal?.aborted) throw abortError(signal);
      const source = await this.sourceLoader.load(started.command, signal);
      const request: ExportBuildRequest = {
        format: started.command.format,
        packaging: started.command.packaging,
        selection: started.command.selection,
        options: started.command.options as ExportBuildRequest["options"],
        source,
      };
      const output = await buildExport(request);
      if (output.bytes.byteLength <= 0 || output.bytes.byteLength > this.config.maximumOutputBytes) {
        throw new TerminalExportError("EXPORT_OUTPUT_SIZE_LIMIT_EXCEEDED", "Generated export output exceeded its byte limit");
      }
      if (output.validationTarget === "html") {
        await this.browser.validateHtml(output.validationBytes ?? output.bytes, exportJobId, signal);
      }
      if (await this.store.status(exportJobId) === "cancelled") return { kind: "terminal", status: "cancelled" };
      const identity = {
        sha256: createHash("sha256").update(output.bytes).digest("hex"),
        byteSize: output.bytes.byteLength,
        mediaType: output.mediaType,
      };
      const reservation = await this.store.reserveOutput(identity);
      await this.storage.putVerified({
        storageKey: reservation.canonicalStorageKey,
        ...identity,
      }, output.bytes, signal);
      const published = await this.store.publishSucceeded(exportJobId, reservation);
      return { kind: "published", status: published, blobId: reservation.blobId, fileName: output.fileName };
    } catch (error) {
      if (error instanceof TerminalExportError || terminalInfrastructureError(error)) {
        const code = error instanceof TerminalExportError ? error.code : infrastructureCode(error);
        const detail = error instanceof TerminalExportError ? error.safeDetail : boundedDetail(error);
        await this.store.fail(exportJobId, code, detail);
        return { kind: "failed", code };
      }
      if (retry.retryCount >= retry.retryLimit) {
        await this.store.fail(exportJobId, "EXPORT_RETRY_EXHAUSTED", boundedDetail(error));
        return { kind: "failed", code: "EXPORT_RETRY_EXHAUSTED" };
      }
      throw error;
    }
  }
}

function terminalInfrastructureError(error: unknown) {
  if (error instanceof ReadyObjectIntegrityError) return true;
  if (!(error instanceof Error)) return false;
  return [
    "EXPORT_INPUT_SIZE_LIMIT_EXCEEDED",
    "EXPORT_OUTPUT_DIGEST_QUARANTINED",
    "EXPORT_OUTPUT_DIGEST_IDENTITY_CONFLICT",
    "EXPORT_STORAGE_IDENTITY_MISMATCH",
  ].some((code) => error.message.startsWith(code));
}

function infrastructureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "EXPORT_INFRASTRUCTURE_ERROR";
  return message.split(":", 1)[0]!.slice(0, 120);
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("EXPORT_ABORTED");
}
