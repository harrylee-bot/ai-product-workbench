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
import type { ExecutionLease, PrismaExportStore } from "./export.store.js";
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
    let activeLease: ExecutionLease | undefined;
    let stopLeaseMonitor: (() => Promise<void>) | undefined;
    let executionSignal = signal;
    try {
      const started = await this.store.start(exportJobId, executionOwner);
      if (started.kind !== "run") return started;
      activeLease = started.lease;
      if (activeLease) {
        const monitor = this.startLeaseMonitor(exportJobId, activeLease, signal);
        executionSignal = monitor.signal;
        stopLeaseMonitor = monitor.stop;
      }
      if (executionSignal?.aborted) {
        const cancelled = await this.cancelIfRequested(exportJobId, activeLease);
        if (cancelled) return cancelled;
        throw abortError(executionSignal);
      }
      const source = await this.sourceLoader.load(started.command, executionSignal);
      const request: ExportBuildRequest = {
        format: started.command.format,
        packaging: started.command.packaging,
        selection: started.command.selection,
        options: started.command.options as ExportBuildRequest["options"],
        source,
        ...(started.command.purpose === "preview" && started.command.preview?.initialScreenId
          ? { initialScreenId: started.command.preview.initialScreenId }
          : {}),
      };
      const output = await buildExport(request, { signal: executionSignal });
      if (executionSignal?.aborted) {
        const cancelled = await this.cancelIfRequested(exportJobId, activeLease);
        if (cancelled) return cancelled;
        throw abortError(executionSignal);
      }
      if (output.bytes.byteLength <= 0 || output.bytes.byteLength > this.config.maximumOutputBytes) {
        throw new TerminalExportError("EXPORT_OUTPUT_SIZE_LIMIT_EXCEEDED", "Generated export output exceeded its byte limit");
      }
      if (output.validationTarget === "html") {
        await this.browser.validateHtml(output.validationBytes ?? output.bytes, exportJobId, executionSignal);
      }
      const cancelled = await this.cancelIfRequested(exportJobId, activeLease);
      if (cancelled) return cancelled;
      const identity = {
        sha256: createHash("sha256").update(output.bytes).digest("hex"),
        byteSize: output.bytes.byteLength,
        mediaType: output.mediaType,
      };
      const reservation = await this.store.reserveOutput(identity);
      try {
        await this.storage.putVerified({
          storageKey: reservation.storageKey,
          ...identity,
        }, output.bytes, executionSignal);
      } catch (error) {
        await this.store.abandonOutput(reservation).catch(() => undefined);
        throw error;
      }
      const published = await this.store.publishSucceeded(exportJobId, reservation);
      if (published === "cancelled") {
        await this.store.abandonOutput(reservation).catch(() => undefined);
        await this.store.acknowledgeCancellation(exportJobId, activeLease);
        return { kind: "terminal", status: "cancelled" };
      }
      return { kind: "published", status: published, blobId: reservation.blobId, fileName: output.fileName };
    } catch (error) {
      const cancelled = await this.cancelIfRequested(exportJobId, activeLease).catch(() => null);
      if (cancelled) return cancelled;
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
    } finally {
      if (stopLeaseMonitor) await stopLeaseMonitor().catch(() => undefined);
      if (activeLease) await this.store.releaseExecutionLease(exportJobId, activeLease).catch(() => undefined);
    }
  }

  private async cancelIfRequested(exportJobId: string, lease?: ExecutionLease) {
    const status = await this.store.status(exportJobId);
    if (status === "cancelled") return { kind: "terminal" as const, status: "cancelled" as const };
    if (status !== "cancelling") return null;
    await this.store.acknowledgeCancellation(exportJobId, lease);
    return { kind: "terminal" as const, status: "cancelled" as const };
  }

  private startLeaseMonitor(exportJobId: string, lease: ExecutionLease, parentSignal?: AbortSignal) {
    const controller = new AbortController();
    const abortFromParent = () => {
      if (!controller.signal.aborted) controller.abort(parentSignal?.reason ?? new Error("EXPORT_QUEUE_ABORTED"));
    };
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const monitor = (async () => {
      while (!controller.signal.aborted) {
        try {
          await delay(500, controller.signal);
        } catch {
          break;
        }
        if (controller.signal.aborted) break;
        try {
          const state = await this.store.pulseExecutionLease(exportJobId, lease);
          if (state === "cancelling") {
            controller.abort(new Error("EXPORT_CANCEL_REQUESTED"));
            break;
          }
          if (state === "lost") {
            controller.abort(new Error("EXPORT_EXECUTION_LEASE_LOST"));
            break;
          }
        } catch (error) {
          controller.abort(error instanceof Error ? error : new Error("EXPORT_EXECUTION_LEASE_CHECK_FAILED"));
          break;
        }
      }
    })();
    return {
      signal: controller.signal,
      stop: async () => {
        controller.abort();
        parentSignal?.removeEventListener("abort", abortFromParent);
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

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("EXPORT_ABORTED");
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error("EXPORT_ABORTED")));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
