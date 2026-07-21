import { createHash } from "node:crypto";
import { ReadyObjectIntegrityError } from "@workbench/workbench-content-security";
import { boundedDetail, TerminalExportError } from "@workbench/workbench-export-core";
import type { ExportWorkerConfig } from "../config.js";
import type { ExportStoragePort } from "../storage/storage.port.js";
import type { ExternalExportDeliveryAdapter } from "./external-export-delivery.adapter.js";
import type {
  ExternalDeliveryCommand,
  PrismaExternalExportDeliveryStore,
} from "./external-export-delivery.store.js";

export class ExternalExportDeliveryProcessor {
  private readonly adapters: ReadonlyMap<string, ExternalExportDeliveryAdapter>;

  constructor(
    private readonly store: PrismaExternalExportDeliveryStore,
    private readonly storage: ExportStoragePort,
    adapters: readonly ExternalExportDeliveryAdapter[],
    private readonly config: Pick<ExportWorkerConfig, "maximumInputBytes">,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.target, adapter]));
  }

  async process(deliveryId: string, signal?: AbortSignal, retry = { retryCount: 0, retryLimit: 0 }) {
    let leaseToken: string | null = null;
    let command: ExternalDeliveryCommand | null = null;
    try {
      const claim = await this.store.claim(deliveryId);
      if (claim.kind !== "run") return claim;
      leaseToken = claim.leaseToken;
      command = await this.store.load(deliveryId, leaseToken);
      if (signal?.aborted) throw abortError(signal);

      if (command.status === "cancelling" && command.remoteReference) {
        const adapter = this.requireAdapter(command.target);
        await this.revokeAndFinalize(command, adapter, signal);
        return { kind: "terminal", status: "cancelled" } as const;
      }
      if (command.status === "cancelling" && command.transferAuthorizedAt === null) {
        await this.store.finalizeCancelled(deliveryId, leaseToken, null);
        return { kind: "terminal", status: "cancelled" } as const;
      }

      const adapter = this.adapters.get(command.target);
      if (!adapter) throw new TerminalExportError("EXPORT_EXTERNAL_TARGET_UNAVAILABLE", "External target is unavailable");
      const bytes = await this.storage.readVerified(command.output, this.config.maximumInputBytes, signal);
      if (createHash("sha256").update(bytes).digest("hex") !== command.output.sha256) {
        throw new TerminalExportError("EXPORT_DELIVERY_OUTPUT_IDENTITY_MISMATCH", "External delivery output digest changed");
      }

      const authorization = await this.store.authorizeTransfer(command);
      if (authorization === "cancelling" && command.transferAuthorizedAt === null) {
        await this.store.finalizeCancelled(deliveryId, leaseToken, null);
        return { kind: "terminal", status: "cancelled" } as const;
      }

      const result = await adapter.deliver({
        deliveryId,
        idempotencyKey: deliveryId,
        target: command.target,
        payload: command.payload,
        bytes,
        signal,
        // Once a cancellation is recovering an authorized transfer, it must
        // obtain the stable remote receipt so that compensation can complete.
        isCancelled: command.status === "cancelling" || authorization === "cancelling"
          ? async () => false
          : () => this.cancellationRequested(deliveryId),
      });

      const status = await this.store.recordRemoteReceipt(deliveryId, leaseToken, result.remoteReference);
      if (status === "cancelling") {
        await adapter.revoke({ idempotencyKey: deliveryId, remoteReference: result.remoteReference, signal });
        await this.store.finalizeCancelled(deliveryId, leaseToken, result.remoteReference);
        return { kind: "terminal", status: "cancelled" } as const;
      }
      return { kind: "published", status, remoteReference: result.remoteReference } as const;
    } catch (error) {
      if (leaseLost(error)) return { kind: "busy" } as const;

      const current = leaseToken === null
        ? null
        : await this.loadOwnedCommand(deliveryId, leaseToken);
      if (current?.status === "cancelling") {
        if (current.remoteReference === null && current.transferAuthorizedAt === null) {
          await this.store.finalizeCancelled(deliveryId, leaseToken!, null);
          return { kind: "terminal", status: "cancelled" } as const;
        }
        const released = await this.releaseForRetry(deliveryId, leaseToken!);
        if (!released) return { kind: "busy" } as const;
        throw error;
      }
      if ((await this.store.status(deliveryId)) === "cancelled") {
        return { kind: "terminal", status: "cancelled" } as const;
      }

      if (error instanceof TerminalExportError || terminalInfrastructureError(error)) {
        const code = error instanceof TerminalExportError ? error.code : infrastructureCode(error);
        const detail = error instanceof TerminalExportError ? error.safeDetail : boundedDetail(error);
        await this.store.fail(deliveryId, leaseToken, code, detail);
        return { kind: "failed", code } as const;
      }
      if (retry.retryCount >= retry.retryLimit) {
        await this.store.fail(deliveryId, leaseToken, "EXPORT_DELIVERY_RETRY_EXHAUSTED", boundedDetail(error));
        return { kind: "failed", code: "EXPORT_DELIVERY_RETRY_EXHAUSTED" } as const;
      }
      if (leaseToken !== null) {
        const released = await this.releaseForRetry(deliveryId, leaseToken);
        if (!released) return { kind: "busy" } as const;
      }
      throw error;
    }
  }

  private requireAdapter(target: string) {
    const adapter = this.adapters.get(target);
    if (!adapter) throw new TerminalExportError("EXPORT_EXTERNAL_TARGET_UNAVAILABLE", "External target is unavailable");
    return adapter;
  }

  private async revokeAndFinalize(
    command: ExternalDeliveryCommand,
    adapter: ExternalExportDeliveryAdapter,
    signal?: AbortSignal,
  ) {
    const remoteReference = command.remoteReference;
    if (!remoteReference) throw new Error("EXPORT_DELIVERY_REMOTE_REFERENCE_MISSING");
    await adapter.revoke({ idempotencyKey: command.id, remoteReference, signal });
    await this.store.finalizeCancelled(command.id, command.leaseToken, remoteReference);
  }

  private async cancellationRequested(deliveryId: string) {
    const status = await this.store.status(deliveryId);
    return status === "cancelling" || status === "cancelled";
  }

  private async loadOwnedCommand(deliveryId: string, leaseToken: string) {
    try {
      return await this.store.load(deliveryId, leaseToken);
    } catch (error) {
      if (leaseLost(error)) return null;
      return null;
    }
  }

  private async releaseForRetry(deliveryId: string, leaseToken: string) {
    try {
      await this.store.releaseForRetry(deliveryId, leaseToken);
      return true;
    } catch (error) {
      if (leaseLost(error)) return false;
      throw error;
    }
  }
}

function terminalInfrastructureError(error: unknown) {
  if (error instanceof ReadyObjectIntegrityError) return true;
  if (!(error instanceof Error)) return false;
  return [
    "EXPORT_INPUT_SIZE_LIMIT_EXCEEDED",
    "EXPORT_BLOB_SIZE_INVALID",
    "EXPORT_DELIVERY_OUTPUT_MISSING",
    "EXPORT_DELIVERY_OUTPUT_IDENTITY_MISMATCH",
    "EXPORT_DELIVERY_PAYLOAD_IDENTITY_MISMATCH",
    "EXPORT_DELIVERY_OUTPUT_NOT_READABLE",
    "EXPORT_DELIVERY_REMOTE_REFERENCE_INVALID",
    "EXPORT_EXTERNAL_TARGET_UNAVAILABLE",
    "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE",
    "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
  ].some((code) => error.message.startsWith(code));
}

function leaseLost(error: unknown) {
  return error instanceof Error && error.message.startsWith("EXPORT_DELIVERY_LEASE_LOST");
}

function infrastructureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "EXPORT_DELIVERY_INFRASTRUCTURE_ERROR";
  return message.split(":", 1)[0]!.slice(0, 120);
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("EXPORT_ABORTED");
}
