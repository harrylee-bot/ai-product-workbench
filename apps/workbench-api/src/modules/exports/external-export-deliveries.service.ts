import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  exportDeliveryQueue,
  type CreateExternalExportDeliveryRequest,
  type ExternalExportDelivery,
  type ExternalExportDeliveryList,
  type ExternalExportTarget,
  externalExportTargetSchema,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  exportStateConflictProblem,
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { WorkbenchQueueService } from "../../platform/queue/workbench-queue.service.js";
import { projectMembershipFilter } from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { ExportCapabilitiesConfig } from "./export-capabilities.config.js";
import {
  externalExportPayloadFromJob,
  exportJobInclude,
  mapExternalExportDelivery,
  mapExportSelection,
  type ExternalExportDeliveryRecord,
  type ExportJobRecord,
} from "./export.mapper.js";

type AuthorizedDelivery = ExternalExportDeliveryRecord & {
  exportJob: ExportJobRecord & { release: { projectId: string } | null };
};

@Injectable()
export class ExternalExportDeliveriesService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly queue: WorkbenchQueueService,
    private readonly capabilities: ExportCapabilitiesConfig,
  ) {}

  async list(principalId: string, exportJobId: string): Promise<ExternalExportDeliveryList> {
    const job = await this.authorizedExport(principalId, exportJobId);
    const rows = await this.db.externalExportDelivery.findMany({
      where: { exportJobId: job.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return { items: rows.map((row) => mapExternalExportDelivery(row as ExternalExportDeliveryRecord)) };
  }

  async create(
    principalId: string,
    exportJobId: string,
    idempotencyKey: string,
    request: CreateExternalExportDeliveryRequest,
  ): Promise<ExternalExportDelivery> {
    validateIdempotencyKey(idempotencyKey);
    externalExportTargetSchema.parse(request.target);
    const job = await this.authorizedExport(principalId, exportJobId);
    assertOutputReady(job);
    this.assertCapability(request.target);
    const requestHash = hashRequest(request);
    const existing = await this.db.externalExportDelivery.findUnique({
      where: { exportJobId_idempotencyKey: { exportJobId, idempotencyKey } },
    });
    if (existing) return this.resolveIdempotent(existing as ExternalExportDeliveryRecord, principalId, requestHash);

    try {
      const created = await this.db.$transaction(async (tx) => {
        await lockExportOutput(tx, exportJobId);
        const lockedJob = await tx.exportJob.findUnique({
          where: { id: exportJobId },
          include: { ...exportJobInclude, release: { select: { projectId: true } } },
        });
        if (!lockedJob) throw notFoundProblem("Export job");
        const lockedRecord = lockedJob as unknown as ExportJobRecord & { release: { projectId: string } | null };
        assertOutputReady(lockedRecord);
        const release = lockedRecord.release;
        if (!release) throw notFoundProblem("Project release");
        await lockActiveProject(tx, release.projectId, principalId, "edit");
        const duplicate = await tx.externalExportDelivery.findUnique({
          where: { exportJobId_idempotencyKey: { exportJobId, idempotencyKey } },
        });
        if (duplicate) return this.resolveIdempotent(duplicate as ExternalExportDeliveryRecord, principalId, requestHash);
        const payload = externalExportPayloadFromJob({
          id: lockedRecord.id,
          releaseId: lockedRecord.releaseId,
          format: lockedRecord.format,
          packaging: lockedRecord.packaging,
          selection: mapExportSelection(lockedRecord),
          outputBlob: lockedRecord.outputBlob!,
        });
        return tx.externalExportDelivery.create({
          data: {
            exportJobId,
            createdById: principalId,
            idempotencyKey,
            requestHash,
            target: request.target,
            authentication: this.capabilities.external(request.target).authentication,
            status: "pending_confirmation",
            revision: 0,
            attempt: 0,
            leaseToken: null,
            leaseExpiresAt: null,
            transferAuthorizedAt: null,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        });
      });
      return mapExternalExportDelivery(created as ExternalExportDeliveryRecord);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.db.externalExportDelivery.findUnique({
          where: { exportJobId_idempotencyKey: { exportJobId, idempotencyKey } },
        });
        if (duplicate) return this.resolveIdempotent(duplicate as ExternalExportDeliveryRecord, principalId, requestHash);
      }
      throw error;
    }
  }

  async get(principalId: string, deliveryId: string): Promise<ExternalExportDelivery> {
    return mapExternalExportDelivery(await this.authorizedDelivery(principalId, deliveryId));
  }

  async confirm(principalId: string, deliveryId: string, expectedRevision: number): Promise<ExternalExportDelivery> {
    const current = await this.authorizedDelivery(principalId, deliveryId);
    assertRevision(current, expectedRevision);
    assertOutputReady(current.exportJob);
    if (current.status !== "pending_confirmation") {
      throw exportStateConflictProblem(`The external delivery cannot be confirmed while it is ${current.status}`);
    }
    this.assertCapability(current.target);
    const queued = await this.db.$transaction(async (tx) => {
      const release = current.exportJob.release;
      if (!release) throw notFoundProblem("Project release");
      await lockActiveProject(tx, release.projectId, principalId, "edit");
      const changed = await tx.externalExportDelivery.updateMany({
        where: { id: deliveryId, revision: expectedRevision, status: "pending_confirmation" },
        data: {
          status: "queued",
          attempt: 0,
          confirmedAt: new Date(),
          startedAt: null,
          transferAuthorizedAt: null,
          finishedAt: null,
          remoteReference: null,
          failureCode: null,
          failureDetail: null,
          leaseToken: null,
          leaseExpiresAt: null,
          revision: { increment: 1 },
        },
      });
      const latest = await tx.externalExportDelivery.findUnique({ where: { id: deliveryId } });
      if (!latest) throw notFoundProblem("External export delivery");
      if (changed.count !== 1) throw revisionConflictProblem();
      await this.queue.sendInTransaction(tx, exportDeliveryQueue, { deliveryId }, { singletonKey: deliveryId });
      return latest;
    });
    return mapExternalExportDelivery(queued as ExternalExportDeliveryRecord);
  }

  async retry(principalId: string, deliveryId: string, expectedRevision: number): Promise<ExternalExportDelivery> {
    const current = await this.authorizedDelivery(principalId, deliveryId);
    assertRevision(current, expectedRevision);
    assertOutputReady(current.exportJob);
    if (current.status !== "failed") {
      throw exportStateConflictProblem(`The external delivery cannot be retried while it is ${current.status}`);
    }
    this.assertCapability(current.target);
    const queued = await this.db.$transaction(async (tx) => {
      const release = current.exportJob.release;
      if (!release) throw notFoundProblem("Project release");
      await lockActiveProject(tx, release.projectId, principalId, "edit");
      const changed = await tx.externalExportDelivery.updateMany({
        where: { id: deliveryId, revision: expectedRevision, status: "failed" },
        data: {
          status: "queued",
          failureCode: null,
          failureDetail: null,
          confirmedAt: new Date(),
          startedAt: null,
          transferAuthorizedAt: null,
          finishedAt: null,
          remoteReference: null,
          leaseToken: null,
          leaseExpiresAt: null,
          revision: { increment: 1 },
        },
      });
      const latest = await tx.externalExportDelivery.findUnique({ where: { id: deliveryId } });
      if (!latest) throw notFoundProblem("External export delivery");
      if (changed.count !== 1) throw revisionConflictProblem();
      await this.queue.sendInTransaction(tx, exportDeliveryQueue, { deliveryId }, { singletonKey: deliveryId });
      return latest;
    });
    return mapExternalExportDelivery(queued as ExternalExportDeliveryRecord);
  }

  async cancel(principalId: string, deliveryId: string, expectedRevision: number): Promise<ExternalExportDelivery> {
    const current = await this.authorizedDelivery(principalId, deliveryId);
    assertRevision(current, expectedRevision);
    if (current.status === "cancelled") return mapExternalExportDelivery(current);
    if (current.status === "cancelling") return mapExternalExportDelivery(current);
    if (!["pending_confirmation", "queued", "running", "succeeded"].includes(current.status)) {
      throw exportStateConflictProblem(`The external delivery cannot be cancelled while it is ${current.status}`);
    }
    const needsRevocation = current.status === "running" || current.status === "succeeded";
    const enqueueRevocation = current.status === "succeeded";
    const cancelled = await this.db.$transaction(async (tx) => {
      const release = current.exportJob.release;
      if (!release) throw notFoundProblem("Project release");
      await lockActiveProject(tx, release.projectId, principalId, "edit");
      const changed = await tx.externalExportDelivery.updateMany({
        where: { id: deliveryId, revision: expectedRevision, status: current.status },
        data: needsRevocation
          ? {
              status: "cancelling",
              finishedAt: null,
              revision: { increment: 1 },
            }
          : {
              status: "cancelled",
              transferAuthorizedAt: null,
              remoteReference: null,
              failureCode: null,
              failureDetail: null,
              finishedAt: new Date(),
              leaseToken: null,
              leaseExpiresAt: null,
              revision: { increment: 1 },
            },
      });
      const latest = await tx.externalExportDelivery.findUnique({ where: { id: deliveryId } });
      if (!latest) throw notFoundProblem("External export delivery");
      if (changed.count !== 1) throw revisionConflictProblem();
      if (enqueueRevocation) {
        await this.queue.sendInTransaction(tx, exportDeliveryQueue, { deliveryId }, { singletonKey: deliveryId });
      }
      return latest;
    });
    return mapExternalExportDelivery(cancelled as ExternalExportDeliveryRecord);
  }

  private async authorizedExport(principalId: string, exportJobId: string): Promise<ExportJobRecord & { release: { projectId: string } | null }> {
    const job = await this.db.exportJob.findFirst({
      where: {
        id: exportJobId,
        purpose: "export",
        release: { is: { project: { is: { status: "active", members: projectMembershipFilter(principalId, "edit") } } } },
      },
      include: { ...exportJobInclude, release: { select: { projectId: true } } },
    });
    if (!job) throw notFoundProblem("Export job");
    return job as unknown as ExportJobRecord & { release: { projectId: string } | null };
  }

  private async authorizedDelivery(principalId: string, deliveryId: string): Promise<AuthorizedDelivery> {
    const delivery = await this.db.externalExportDelivery.findFirst({
      where: {
        id: deliveryId,
        exportJob: {
          purpose: "export",
          release: { is: { project: { is: { status: "active", members: projectMembershipFilter(principalId, "edit") } } } },
        },
      },
      include: {
        exportJob: {
          include: { ...exportJobInclude, release: { select: { projectId: true } } },
        },
      },
    });
    if (!delivery) throw notFoundProblem("External export delivery");
    return delivery as unknown as AuthorizedDelivery;
  }

  private assertCapability(target: ExternalExportTarget) {
    const capability = this.capabilities.external(target);
    if (!capability.available) {
      throw exportStateConflictProblem(capability.reasonCode ?? "External export target is unavailable");
    }
    if (capability.authentication !== "authenticated" && capability.authentication !== "not_required") {
      throw exportStateConflictProblem("External export target authentication is required before publishing");
    }
  }

  private resolveIdempotent(row: ExternalExportDeliveryRecord, principalId: string, requestHash: string) {
    if (row.createdById !== principalId || row.requestHash !== requestHash) throw idempotencyConflictProblem();
    return mapExternalExportDelivery(row);
  }
}

function assertOutputReady(job: ExportJobRecord) {
  if (job.status !== "succeeded" || !job.outputBlob || job.outputBlob.status !== "ready" || job.outputBlob.deletedAt !== null) {
    throw exportStateConflictProblem("External delivery requires a succeeded Export with a readable output");
  }
}

function assertRevision(row: { revision: number }, expectedRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw validationProblem("A valid delivery revision is required");
  if (row.revision !== expectedRevision) throw revisionConflictProblem();
}

async function lockExportOutput(tx: Prisma.TransactionClient, exportJobId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT job."id", blob."id" AS "blob_id"
    FROM "export_jobs" AS job
    INNER JOIN "blobs" AS blob ON blob."id" = job."output_blob_id"
    WHERE job."id" = ${exportJobId}
    FOR UPDATE OF job, blob
  `);
}
