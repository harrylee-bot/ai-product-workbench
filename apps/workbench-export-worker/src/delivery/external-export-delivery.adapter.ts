import type {
  ExternalExportTarget,
  ExternalExportPayloadSnapshot,
} from "@workbench/workbench-contracts";

export type ExternalExportDeliveryRequest = {
  deliveryId: string;
  /** Stable across queue redelivery and lease takeover. Remote adapters must
   * use this as their provider idempotency key. */
  idempotencyKey: string;
  target: ExternalExportTarget;
  payload: ExternalExportPayloadSnapshot;
  bytes: Uint8Array;
  /** Adapters must stop waiting when this signal aborts. The queue's maximum
   * execution time is shorter than the database lease takeover window. */
  signal?: AbortSignal;
  isCancelled: () => Promise<boolean>;
};

export type ExternalExportDeliveryResult = {
  remoteReference: string;
};

export interface ExternalExportDeliveryAdapter {
  readonly target: ExternalExportTarget;
  deliver(request: ExternalExportDeliveryRequest): Promise<ExternalExportDeliveryResult>;
  revoke(request: { idempotencyKey: string; remoteReference: string; signal?: AbortSignal }): Promise<void>;
}

/** Production default: an explicit capability failure, never a best-effort upload. */
export class UnavailableExternalExportDeliveryAdapter implements ExternalExportDeliveryAdapter {
  constructor(
    readonly target: ExternalExportTarget,
    private readonly reasonCode = "EXPORT_EXTERNAL_TARGET_UNAVAILABLE",
  ) {}

  async deliver(_request: ExternalExportDeliveryRequest): Promise<ExternalExportDeliveryResult> {
    throw new Error(this.reasonCode);
  }

  async revoke(_request: { idempotencyKey: string; remoteReference: string; signal?: AbortSignal }): Promise<void> {
    throw new Error(this.reasonCode);
  }
}

/** Deterministic adapter used by integration tests and local contract probes.
 * It records only a digest/size and never accepts credentials or a remote URL. */
export class FakeExternalExportDeliveryAdapter implements ExternalExportDeliveryAdapter {
  readonly calls: ExternalExportDeliveryRequest[] = [];
  readonly revocations: Array<{ idempotencyKey: string; remoteReference: string }> = [];
  private invocation = 0;
  private readonly receipts = new Map<string, ExternalExportDeliveryResult>();

  constructor(
    readonly target: ExternalExportTarget,
    private readonly options: {
      failCount?: number;
      failureCode?: string;
      delayMs?: number;
    } = {},
  ) {}

  async deliver(request: ExternalExportDeliveryRequest): Promise<ExternalExportDeliveryResult> {
    this.calls.push({ ...request, bytes: new Uint8Array(request.bytes) });
    const existing = this.receipts.get(request.idempotencyKey);
    if (existing) return existing;
    const call = this.invocation;
    this.invocation += 1;
    if (this.options.delayMs && this.options.delayMs > 0) {
      await delay(this.options.delayMs, request.signal, request.isCancelled);
    }
    if (await request.isCancelled()) throw new Error("EXPORT_DELIVERY_CANCELLED");
    if (call < (this.options.failCount ?? 0)) {
      throw new Error(this.options.failureCode ?? "EXPORT_EXTERNAL_FAKE_FAILURE");
    }
    const result = { remoteReference: `fake://${this.target}/${request.deliveryId}` };
    this.receipts.set(request.idempotencyKey, result);
    return result;
  }

  async revoke(request: { idempotencyKey: string; remoteReference: string; signal?: AbortSignal }) {
    const existing = this.receipts.get(request.idempotencyKey);
    if (existing && existing.remoteReference !== request.remoteReference) {
      throw new Error("EXPORT_EXTERNAL_FAKE_REVOKE_IDENTITY_MISMATCH");
    }
    this.revocations.push({ idempotencyKey: request.idempotencyKey, remoteReference: request.remoteReference });
    this.receipts.delete(request.idempotencyKey);
  }
}

function delay(milliseconds: number, signal: AbortSignal | undefined, isCancelled: () => Promise<boolean>) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      void isCancelled().then(() => resolve(), reject);
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("EXPORT_ABORTED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
