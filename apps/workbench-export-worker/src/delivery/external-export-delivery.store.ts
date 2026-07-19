import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import {
  externalExportPayloadSnapshotSchema,
  type ExternalExportTarget,
} from "@workbench/workbench-contracts";
import type { ExportWorkerConfig } from "../config.js";

type DeliveryExecutionStatus = "running" | "cancelling";

export type ExternalDeliveryCommand = {
  id: string;
  leaseToken: string;
  status: DeliveryExecutionStatus;
  target: ExternalExportTarget;
  payload: ReturnType<typeof externalExportPayloadSnapshotSchema.parse>;
  remoteReference: string | null;
  transferAuthorizedAt: Date | null;
  output: {
    blobId: string;
    storageKey: string;
    sha256: string;
    byteSize: number;
    mediaType: string;
  };
};

export type DeliveryClaim =
  | { kind: "missing" }
  | { kind: "busy" }
  | { kind: "terminal"; status: string }
  | { kind: "run"; leaseToken: string };

export class PrismaExternalExportDeliveryStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: Pick<ExportWorkerConfig, "maximumInputBytes" | "staleRunningMs">,
  ) {}

  async claim(deliveryId: string): Promise<DeliveryClaim> {
    const current = await this.db.externalExportDelivery.findUnique({
      where: { id: deliveryId },
      select: { status: true, leaseToken: true, leaseExpiresAt: true },
    });
    if (!current) return { kind: "missing" };
    if (["succeeded", "failed", "cancelled"].includes(current.status)) {
      return { kind: "terminal", status: current.status };
    }
    if (current.status === "pending_confirmation") return { kind: "busy" };

    const now = new Date();
    const leaseToken = `export_delivery_${randomUUID()}`;
    const leaseExpiresAt = this.nextLeaseExpiry(now);
    const where = current.status === "queued"
      ? { id: deliveryId, status: "queued" as const, finishedAt: null, leaseToken: null }
      : {
          id: deliveryId,
          status: current.status as DeliveryExecutionStatus,
          finishedAt: null,
          OR: [
            { leaseToken: null, leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        };
    const claimed = await this.db.externalExportDelivery.updateMany({
      where,
      data: {
        status: current.status === "queued" ? "running" : current.status,
        ...(current.status === "queued" ? { startedAt: now } : {}),
        leaseToken,
        leaseExpiresAt,
        attempt: { increment: 1 },
        revision: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      const status = await this.status(deliveryId);
      if (!status) return { kind: "missing" };
      if (["succeeded", "failed", "cancelled"].includes(status)) return { kind: "terminal", status };
      return { kind: "busy" };
    }
    return { kind: "run", leaseToken };
  }

  async load(deliveryId: string, leaseToken: string): Promise<ExternalDeliveryCommand> {
    const delivery = await this.db.externalExportDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        exportJob: {
          select: {
            id: true,
            outputBlob: {
              select: {
                id: true,
                storageKey: true,
                sha256: true,
                byteSize: true,
                mediaType: true,
              },
            },
          },
        },
      },
    });
    if (!delivery || !["running", "cancelling"].includes(delivery.status)
      || delivery.finishedAt !== null || delivery.leaseToken !== leaseToken
      || !delivery.leaseExpiresAt) {
      throw new Error("EXPORT_DELIVERY_LEASE_LOST");
    }
    const output = delivery.exportJob.outputBlob;
    if (!output) throw new Error("EXPORT_DELIVERY_OUTPUT_MISSING");
    const byteSize = safeByteSize(output.byteSize);
    if (byteSize > this.config.maximumInputBytes) throw new Error("EXPORT_INPUT_SIZE_LIMIT_EXCEEDED");
    const payload = externalExportPayloadSnapshotSchema.parse(delivery.payload);
    if (payload.exportJobId !== delivery.exportJobId
      || payload.output.sha256 !== output.sha256
      || payload.output.byteSize !== byteSize
      || payload.output.mediaType !== output.mediaType) {
      throw new Error("EXPORT_DELIVERY_PAYLOAD_IDENTITY_MISMATCH");
    }
    return {
      id: delivery.id,
      leaseToken,
      status: delivery.status as DeliveryExecutionStatus,
      target: delivery.target,
      payload,
      remoteReference: delivery.remoteReference,
      transferAuthorizedAt: delivery.transferAuthorizedAt,
      output: {
        blobId: output.id,
        storageKey: output.storageKey,
        sha256: output.sha256,
        byteSize,
        mediaType: output.mediaType,
      },
    };
  }

  /** Linearization point for external transfer. Blob is locked before the
   * delivery row, so quarantine-before-authorization fails closed while an
   * authorization committed first remains a durable audit fact. */
  async authorizeTransfer(command: ExternalDeliveryCommand): Promise<"authorized" | "cancelling"> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "blobs" WHERE "id" = ${command.output.blobId} FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "external_export_deliveries" WHERE "id" = ${command.id} FOR UPDATE
      `);
      const [blob, delivery] = await Promise.all([
        tx.blob.findUnique({
          where: { id: command.output.blobId },
          select: { id: true, status: true, deletedAt: true, sha256: true, byteSize: true, mediaType: true },
        }),
        tx.externalExportDelivery.findUnique({
          where: { id: command.id },
          select: { status: true, leaseToken: true, remoteReference: true, transferAuthorizedAt: true },
        }),
      ]);
      if (!delivery || delivery.leaseToken !== command.leaseToken) throw new Error("EXPORT_DELIVERY_LEASE_LOST");
      if (delivery.status === "cancelling") return "cancelling" as const;
      if (delivery.status !== "running" || delivery.remoteReference !== null) throw new Error("EXPORT_DELIVERY_STATE_INVALID");
      const readable = blob !== null
        && blob.status === "ready"
        && blob.deletedAt === null
        && blob.sha256 === command.output.sha256
        && safeByteSize(blob.byteSize) === command.output.byteSize
        && blob.mediaType === command.output.mediaType;
      if (delivery.transferAuthorizedAt !== null && !readable) {
        const cancelling = await tx.externalExportDelivery.updateMany({
          where: {
            id: command.id,
            status: "running",
            leaseToken: command.leaseToken,
            transferAuthorizedAt: { not: null },
            remoteReference: null,
          },
          data: {
            status: "cancelling",
            leaseExpiresAt: this.nextLeaseExpiry(),
            revision: { increment: 1 },
          },
        });
        if (cancelling.count !== 1) throw new Error("EXPORT_DELIVERY_LEASE_LOST");
        return "cancelling" as const;
      }
      if (!readable) {
        throw new Error("EXPORT_DELIVERY_OUTPUT_NOT_READABLE");
      }
      const authorizedAt = new Date();
      const updated = await tx.externalExportDelivery.updateMany({
        where: { id: command.id, status: "running", leaseToken: command.leaseToken, remoteReference: null },
        data: {
          transferAuthorizedAt: delivery.transferAuthorizedAt ?? authorizedAt,
          leaseExpiresAt: this.nextLeaseExpiry(authorizedAt),
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("EXPORT_DELIVERY_LEASE_LOST");
      return "authorized" as const;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async recordRemoteReceipt(deliveryId: string, leaseToken: string, remoteReference: string) {
    if (!remoteReference || remoteReference.length > 500) throw new Error("EXPORT_DELIVERY_REMOTE_REFERENCE_INVALID");
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "external_export_deliveries" WHERE "id" = ${deliveryId} FOR UPDATE
      `);
      const delivery = await tx.externalExportDelivery.findUnique({
        where: { id: deliveryId },
        select: { status: true, leaseToken: true, remoteReference: true, transferAuthorizedAt: true },
      });
      if (!delivery || delivery.leaseToken !== leaseToken) throw new Error("EXPORT_DELIVERY_LEASE_LOST");
      if (delivery.transferAuthorizedAt === null) throw new Error("EXPORT_DELIVERY_TRANSFER_NOT_AUTHORIZED");
      if (delivery.remoteReference !== null && delivery.remoteReference !== remoteReference) {
        throw new Error("EXPORT_DELIVERY_REMOTE_RECEIPT_CONFLICT");
      }
      if (delivery.status === "running") {
        const updated = await tx.externalExportDelivery.updateMany({
          where: { id: deliveryId, status: "running", leaseToken },
          data: {
            status: "succeeded",
            remoteReference,
            finishedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new Error("EXPORT_DELIVERY_LEASE_LOST");
        return "succeeded" as const;
      }
      if (delivery.status === "cancelling") {
        const updated = await tx.externalExportDelivery.updateMany({
          where: { id: deliveryId, status: "cancelling", leaseToken },
          data: { remoteReference, leaseExpiresAt: this.nextLeaseExpiry(), revision: { increment: 1 } },
        });
        if (updated.count !== 1) throw new Error("EXPORT_DELIVERY_LEASE_LOST");
        return "cancelling" as const;
      }
      throw new Error("EXPORT_DELIVERY_STATE_INVALID");
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async finalizeCancelled(deliveryId: string, leaseToken: string, remoteReference: string | null) {
    const updated = await this.db.externalExportDelivery.updateMany({
      where: {
        id: deliveryId,
        status: "cancelling",
        leaseToken,
        remoteReference,
        transferAuthorizedAt: remoteReference === null ? null : { not: null },
      },
      data: {
        status: "cancelled",
        remoteReference: null,
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("EXPORT_DELIVERY_CANCELLATION_PUBLICATION_LOST");
  }

  async releaseForRetry(deliveryId: string, leaseToken: string) {
    const current = await this.db.externalExportDelivery.findUnique({
      where: { id: deliveryId },
      select: { status: true, leaseToken: true, transferAuthorizedAt: true },
    });
    if (!current || current.leaseToken !== leaseToken || !["running", "cancelling"].includes(current.status)) {
      throw new Error("EXPORT_DELIVERY_LEASE_LOST");
    }
    const updated = await this.db.externalExportDelivery.updateMany({
      where: { id: deliveryId, status: current.status, leaseToken },
      data: current.status === "running" && current.transferAuthorizedAt === null
        ? {
            status: "queued",
            startedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            revision: { increment: 1 },
          }
        : current.status === "running"
          ? {
              leaseExpiresAt: new Date(0),
              revision: { increment: 1 },
            }
          : {
            leaseToken: null,
            leaseExpiresAt: null,
            revision: { increment: 1 },
          },
    });
    if (updated.count !== 1) throw new Error("EXPORT_DELIVERY_LEASE_LOST");
  }

  async fail(deliveryId: string, leaseToken: string | null, code: string, detail: string) {
    const where = leaseToken === null
      ? { id: deliveryId, status: "queued" as const, leaseToken: null, finishedAt: null }
      : { id: deliveryId, status: "running" as const, leaseToken, finishedAt: null };
    const updated = await this.db.externalExportDelivery.updateMany({
      where,
      data: {
        status: "failed",
        ...(leaseToken === null ? { attempt: { increment: 1 } } : {}),
        failureCode: code.slice(0, 120),
        failureDetail: detail.slice(0, 4_000),
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        revision: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      const status = await this.status(deliveryId);
      if (!status || !["succeeded", "failed", "cancelled", "cancelling"].includes(status)) {
        throw new Error("EXPORT_DELIVERY_FAILURE_PUBLICATION_LOST");
      }
    }
  }

  async status(deliveryId: string) {
    return (await this.db.externalExportDelivery.findUnique({
      where: { id: deliveryId },
      select: { status: true },
    }))?.status ?? null;
  }

  async reconciliationCandidates(staleBefore: Date, limit = 100) {
    return this.db.externalExportDelivery.findMany({
      where: {
        OR: [
          { status: "queued" },
          { status: "running", leaseExpiresAt: { lt: staleBefore } },
          { status: "cancelling", leaseToken: null },
          { status: "cancelling", leaseExpiresAt: { lt: staleBefore } },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { id: true },
    });
  }

  private nextLeaseExpiry(now = new Date()) {
    return new Date(now.getTime() + this.config.staleRunningMs);
  }
}

function safeByteSize(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("EXPORT_BLOB_SIZE_INVALID");
  return number;
}
