import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ReadyObjectIntegrityError } from "@workbench/workbench-content-security";
import {
  TerminalExportError,
  boundedDetail,
  buildExport,
  type ExportBuildRequest,
} from "@workbench/workbench-export-core";
import type { ExportWorkerConfig } from "../config.js";
import { ExportBrowserCleanupError, type BrowserExportService } from "../browser/browser-export.service.js";
import type { ExportStoragePort } from "../storage/storage.port.js";
import {
  ExportExecutionLeaseLostError,
  type ExecutionLease,
  type OutputReservation,
  type PrismaExportStore,
} from "./export.store.js";
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
    executionOwner = "export-worker",
  ) {
    const started = await this.store.start(exportJobId, executionOwner);
    if (started.kind !== "run") return started;

    const { lease } = started;
    const monitor = this.startLeaseMonitor(exportJobId, lease, signal);
    const executionSignal = monitor.signal;
    let reservation: OutputReservation | undefined;
    try {
      executionSignal.throwIfAborted();
      await this.store.beginExecutionResources(exportJobId, lease);
      const command = await this.store.loadRunning(exportJobId);
      const source = await this.sourceLoader.load(command, executionSignal);
      const request: ExportBuildRequest = {
        format: command.format,
        packaging: command.packaging,
        selection: command.selection,
        options: command.options as ExportBuildRequest["options"],
        source,
        ...(command.purpose === "preview" && command.preview?.initialScreenId
          ? { initialScreenId: command.preview.initialScreenId }
          : {}),
      };
      const output = await buildExport(request, { signal: executionSignal });
      executionSignal.throwIfAborted();
      if (output.bytes.byteLength <= 0 || output.bytes.byteLength > this.config.maximumOutputBytes) {
        throw new TerminalExportError("EXPORT_OUTPUT_SIZE_LIMIT_EXCEEDED", "Generated export output exceeded its byte limit");
      }
      if (output.validationTarget === "html") {
        await this.browser.validateHtml(output.validationBytes ?? output.bytes, exportJobId, executionSignal);
      }
      executionSignal.throwIfAborted();
      const identity = {
        sha256: createHash("sha256").update(output.bytes).digest("hex"),
        byteSize: output.bytes.byteLength,
        mediaType: output.mediaType,
      };
      await monitor.checkLease();
      reservation = await this.store.reserveOutput(identity);
      await monitor.checkLease();
      await this.storage.putVerified({
        storageKey: reservation.storageKey,
        ...identity,
      }, output.bytes, executionSignal);
      executionSignal.throwIfAborted();
      const published = await this.store.publishSucceeded(exportJobId, reservation, lease);
      if (published !== "succeeded") throw new Error("EXPORT_CANCEL_REQUESTED");
      await this.store.endExecutionResources(exportJobId, lease);
      return { kind: "published", status: published, blobId: reservation.blobId, fileName: output.fileName };
    } catch (error) {
      if (error instanceof ExportBrowserCleanupError) throw error;
      if (reservation) await this.store.abandonOutput(reservation);
      await this.store.endExecutionResources(exportJobId, lease);
      const cancelled = await this.cancelIfRequested(exportJobId, lease);
      if (cancelled) return cancelled;
      const code = error instanceof TerminalExportError ? error.code
        : terminalInfrastructureError(error) ? infrastructureCode(error)
        : retry.retryCount >= retry.retryLimit ? "EXPORT_RETRY_EXHAUSTED" : null;
      if (error instanceof ExportExecutionLeaseLostError || code === null) throw error;
      const detail = error instanceof TerminalExportError ? error.safeDetail : boundedDetail(error);
      if (await this.store.fail(exportJobId, code, detail, lease)) return { kind: "failed", code };
      const racedCancellation = await this.cancelIfRequested(exportJobId, lease);
      if (racedCancellation) return racedCancellation;
      throw new ExportExecutionLeaseLostError();
    } finally {
      await monitor.stop();
      await this.store.releaseExecutionLease(exportJobId, lease);
    }
  }

  private async cancelIfRequested(exportJobId: string, lease: ExecutionLease) {
    const status = await this.store.status(exportJobId);
    if (status === "cancelled") return { kind: "terminal" as const, status: "cancelled" as const };
    if (status !== "cancelling") return null;
    const result = await this.store.acknowledgeCancellation(exportJobId, lease);
    return result === "cancelled"
      ? { kind: "terminal" as const, status: "cancelled" as const }
      : { kind: "skipped" as const, status: "cancelling" as const };
  }

  private startLeaseMonitor(exportJobId: string, lease: ExecutionLease, parentSignal?: AbortSignal) {
    const execution = new AbortController();
    const stop = new AbortController();
    const signal = parentSignal ? AbortSignal.any([execution.signal, parentSignal]) : execution.signal;
    const renew = async () => {
      const state = await this.store.pulseExecutionLease(exportJobId, lease);
      if (state === "cancelling") execution.abort(new Error("EXPORT_CANCEL_REQUESTED"));
      if (state === "lost") execution.abort(new ExportExecutionLeaseLostError());
      return state;
    };
    const monitor = (async () => {
      // Keep ownership during browser, network and reservation cleanup after abort.
      while (!stop.signal.aborted) {
        try {
          await delay(500, undefined, { signal: stop.signal, ref: false });
        } catch {
          break;
        }
        try {
          if (await renew() === "lost") break;
        } catch (error) {
          execution.abort(error);
        }
      }
    })();
    return {
      signal,
      checkLease: async () => {
        signal.throwIfAborted();
        await renew();
        signal.throwIfAborted();
      },
      stop: async () => {
        stop.abort();
        await monitor;
      },
    };
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
