import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  exportBuildJobSchema,
  exportBuildQueue,
  projectReleaseManifestSchema,
  projectReleaseProtocol,
  prototypeDocumentSchema,
  requiredExportPackaging,
  resolveExportBoardNodeSelection,
  type CreateExportJobRequest,
  type ExportCapabilities,
  type ExportJob,
  type ExportJobList,
  type ExportSelection,
  type ProjectRelease,
  type CreateProjectPreviewRequest,
  type ProjectPreview,
  exportPreviewTokenResponseSchema,
  projectPreviewSchema,
  type ExportPreviewTokenResponse,
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
import {
  READY_BLOB_STORAGE_PORT,
  type ReadyBlobStoragePort,
} from "../../platform/object-storage/object-storage.port.js";
import { readReadyObject } from "../../platform/object-storage/read-ready-object.js";
import { readyObjectIntegrityRecorder } from "../../platform/object-storage/ready-object-integrity.js";
import { WorkbenchQueueService } from "../../platform/queue/workbench-queue.service.js";
import {
  AccessService,
  projectMembershipFilter,
  type ProjectCapability,
} from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";
import {
  canonicalSha256,
  mapProjectRelease,
  orderedReleaseArtifactPins,
  type ReleaseRecord,
} from "../releases/release.mapper.js";
import { loadPinnedProjectSnapshot } from "../releases/project-snapshot.js";
import { ExportPreviewConfig } from "./export-preview.config.js";
import { ExportCapabilitiesConfig } from "./export-capabilities.config.js";
import {
  exportJobInclude,
  exportFailure,
  mapExportJob,
  mapExportSelection,
  outputFileName,
  safeByteSize,
  type ExportJobRecord,
} from "./export.mapper.js";

type ExportCursor = { createdAt: string; id: string };
const previewLifetimeMs = 15 * 60 * 1_000;

type PreviewRecord = {
  id: string;
  projectId: string;
  boardId: string;
  boardRevision: number;
  initialScreenId: string | null;
  exportJobId: string;
  createdById: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  exportJob: ExportJobRecord;
};

@Injectable()
export class ExportsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
    private readonly queue: WorkbenchQueueService,
    @Inject(READY_BLOB_STORAGE_PORT) private readonly storage: ReadyBlobStoragePort,
    private readonly preview: ExportPreviewConfig,
    private readonly capabilitiesConfig: ExportCapabilitiesConfig,
  ) {}

  capabilities(): ExportCapabilities {
    return this.capabilitiesConfig.catalog();
  }

  async list(
    principalId: string,
    projectId: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ExportJobList> {
    await this.access.findProject(principalId, projectId, "edit");
    const limit = clampLimit(requestedLimit);
    const decoded = cursor ? decodeExportCursor(cursor) : undefined;
    const rows = await this.db.exportJob.findMany({
      where: {
        purpose: "export",
        preview: null,
        release: { is: { projectId } },
        ...(decoded ? {
          OR: [
            { createdAt: { lt: new Date(decoded.createdAt) } },
            { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
          ],
        } : {}),
      },
      include: exportJobInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => mapExportJob(row as ExportJobRecord)),
      nextCursor: hasNext && last
        ? encodeExportCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    };
  }

  async create(
    principalId: string,
    projectId: string,
    idempotencyKey: string,
    request: CreateExportJobRequest,
  ): Promise<ExportJob> {
    validateIdempotencyKey(idempotencyKey);
    if (request.format === "figma" && Object.keys(request.options).length > 0) {
      throw validationProblem("Figma Export does not accept client options");
    }
    assertExportPackaging(request);
    await this.access.findProject(principalId, projectId, "edit");
    const requestHash = hashRequest(request);
    const authorizedRelease = await this.db.projectRelease.findFirst({
      where: { id: request.releaseId, projectId, status: "ready" },
      include: { artifactPins: orderedReleaseArtifactPins },
    });
    if (!authorizedRelease) throw notFoundProblem("Ready Project release");
    const releaseSnapshot = mapProjectRelease(authorizedRelease as ReleaseRecord);
    assertBoardNodeSelection(request.selection, releaseSnapshot);
    const existing = await this.findByReceipt(request.releaseId, idempotencyKey);
    if (existing) return this.resolveIdempotent(existing, principalId, requestHash);
    const persistedOptions = this.capabilitiesConfig.materializeOptions(request.format, request.options);
    assertFigmaSelection(request.format, request.selection, releaseSnapshot);

    try {
      const created = await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "edit");
        const duplicate = await tx.exportJob.findUnique({
          where: {
            releaseId_idempotencyKey: { releaseId: request.releaseId, idempotencyKey },
          },
          include: exportJobInclude,
        });
        if (duplicate) return this.resolveIdempotent(duplicate as ExportJobRecord, principalId, requestHash);

        const release = await tx.projectRelease.findFirst({
          where: { id: request.releaseId, projectId, status: "ready" },
          select: { id: true },
        });
        if (!release) throw notFoundProblem("Ready Project release");
        if (request.selection.kind === "artifact") {
          const pin = await tx.releaseArtifactVersion.findUnique({
            where: {
              releaseId_artifactId_artifactVersionId: {
                releaseId: release.id,
                artifactId: request.selection.artifactId,
                artifactVersionId: request.selection.artifactVersionId,
              },
            },
            select: {
              releaseId: true,
              kind: true,
              artifactVersion: {
                select: {
                  status: true,
                  content: true,
                  contentBlobId: true,
                  artifact: { select: { kind: true } },
                },
              },
            },
          });
          if (!pin) {
            throw validationProblem("The selected Artifact version is not pinned by this Project release");
          }
          assertArtifactScreenSelection(request.selection, pin);
        }

        const job = await tx.exportJob.create({
          data: {
            releaseId: release.id,
            createdById: principalId,
            idempotencyKey,
            requestHash,
            format: request.format,
            packaging: request.packaging,
            selectionKind: request.selection.kind,
            selectionArtifactId: request.selection.kind === "artifact"
              ? request.selection.artifactId
              : null,
            selectionArtifactVersionId: request.selection.kind === "artifact"
              ? request.selection.artifactVersionId
              : null,
            selectionScreenId: request.selection.kind === "artifact"
              ? request.selection.screenId ?? null
              : null,
            selectionNodeIds: request.selection.kind === "board_nodes"
              ? request.selection.nodeIds
              : [],
            options: persistedOptions as Prisma.InputJsonValue,
          },
        });
        const payload = exportBuildJobSchema.parse({ exportJobId: job.id });
        await this.queue.sendInTransaction(tx, exportBuildQueue, payload, {
          singletonKey: job.id,
        });
        return tx.exportJob.findUniqueOrThrow({
          where: { id: job.id },
          include: exportJobInclude,
        });
      });
      return mapExportJob(created as ExportJobRecord);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.findByReceipt(request.releaseId, idempotencyKey);
        if (duplicate) return this.resolveIdempotent(duplicate, principalId, requestHash);
      }
      throw error;
    }
  }

  /**
   * Queue a read-authorized, non-downloadable HTML Preview. This deliberately
   * does not call the public Export or Release commands: viewers can render an
   * immutable snapshot of the persisted Board, but cannot mutate the Project.
   */
  async createPreview(
    principalId: string,
    projectId: string,
    idempotencyKey: string,
    request: CreateProjectPreviewRequest,
  ): Promise<ProjectPreview> {
    validateIdempotencyKey(idempotencyKey);
    await this.access.findProject(principalId, projectId, "read");
    assertPreviewSelectionShape(request);
    const requestHash = hashRequest(request);
    const existing = await this.findPreviewByReceipt(projectId, idempotencyKey);
    if (existing) return this.resolvePreviewIdempotent(existing, principalId, requestHash);

    try {
      const created = await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "read");
        const duplicate = await tx.projectPreview.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
          include: { exportJob: { include: exportJobInclude } },
        });
        if (duplicate) {
          this.resolvePreviewIdempotent(duplicate as PreviewRecord, principalId, requestHash);
          return duplicate;
        }

        const {
          board,
          boardSnapshot,
          boardChecksum,
          artifactPins,
        } = await loadPinnedProjectSnapshot(
          tx,
          projectId,
          request.boardId,
          request.boardRevision,
        );
        assertBoardNodeSelection(request.selection, { boardSnapshot });
        if (request.selection.kind === "artifact") {
          const selectedSelection = request.selection;
          const pin = artifactPins.find((candidate) => (
            candidate.artifactId === selectedSelection.artifactId
            && candidate.artifactVersionId === selectedSelection.artifactVersionId
          ));
          if (!pin) throw validationProblem("The selected Artifact version is not pinned by this Project preview");
          const artifactVersion = await tx.artifactVersion.findFirst({
            where: {
              id: pin.artifactVersionId,
              artifactId: pin.artifactId,
              projectId,
              status: "ready",
            },
            select: {
              status: true,
              content: true,
              contentBlobId: true,
              artifact: { select: { kind: true } },
            },
          });
          if (!artifactVersion) throw validationProblem("The selected Artifact version is unavailable");
          assertPreviewInitialScreen(request.initialScreenId ?? null, { kind: pin.kind, artifactVersion });
        }

        const manifest = projectReleaseManifestSchema.parse({
          protocol: projectReleaseProtocol,
          projectId,
          releaseVersion: 1,
          board: { id: board.id, revision: board.revision, checksum: boardChecksum },
          artifacts: artifactPins,
        });
        const manifestSha256 = canonicalSha256(manifest);

        const exportJob = await tx.exportJob.create({
          data: {
            releaseId: null,
            createdById: principalId,
            idempotencyKey: `preview:${idempotencyKey}`,
            requestHash,
            format: "html",
            packaging: "single_file",
            purpose: "preview",
            selectionKind: request.selection.kind,
            selectionArtifactId: request.selection.kind === "artifact"
              ? request.selection.artifactId
              : null,
            selectionArtifactVersionId: request.selection.kind === "artifact"
              ? request.selection.artifactVersionId
              : null,
            selectionScreenId: null,
            selectionNodeIds: request.selection.kind === "board_nodes"
              ? request.selection.nodeIds
              : [],
            options: {},
          },
        });
        const expiresAt = new Date(Date.now() + previewLifetimeMs);
        const preview = await tx.projectPreview.create({
          data: {
            projectId,
            boardId: board.id,
            boardRevision: board.revision,
            initialScreenId: request.initialScreenId ?? null,
            boardSnapshot: boardSnapshot as Prisma.InputJsonValue,
            boardChecksum,
            manifest: manifest as Prisma.InputJsonValue,
            manifestSha256,
            exportJobId: exportJob.id,
            createdById: principalId,
            idempotencyKey,
            requestHash,
            expiresAt,
            artifactPins: {
              create: artifactPins.map((pin) => ({
                position: pin.position,
                artifactId: pin.artifactId,
                artifactVersionId: pin.artifactVersionId,
                title: pin.title,
                kind: pin.kind,
              })),
            },
          },
        });
        const payload = exportBuildJobSchema.parse({ exportJobId: exportJob.id });
        await this.queue.sendInTransaction(tx, exportBuildQueue, payload, {
          singletonKey: exportJob.id,
        });
        return tx.projectPreview.findUniqueOrThrow({
          where: { id: preview.id },
          include: { exportJob: { include: exportJobInclude } },
        });
      });
      return mapProjectPreview(created as PreviewRecord);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.findPreviewByReceipt(projectId, idempotencyKey);
        if (duplicate) return this.resolvePreviewIdempotent(duplicate, principalId, requestHash);
      }
      throw error;
    }
  }

  async getPreview(principalId: string, previewId: string): Promise<ProjectPreview> {
    const preview = await this.db.projectPreview.findFirst({
      where: {
        id: previewId,
        project: {
          status: "active",
          members: projectMembershipFilter(principalId, "read"),
        },
      },
      include: { exportJob: { include: exportJobInclude } },
    });
    if (!preview) throw notFoundProblem("Project preview");
    return mapProjectPreview(preview as PreviewRecord);
  }

  async createProjectPreviewToken(
    principalId: string,
    previewId: string,
  ): Promise<ExportPreviewTokenResponse> {
    const now = new Date();
    const preview = await this.db.projectPreview.findFirst({
      where: {
        id: previewId,
        expiresAt: { gt: new Date(now.getTime() + 1_000) },
        project: {
          status: "active",
          members: projectMembershipFilter(principalId, "read"),
        },
      },
      include: {
        exportJob: {
          select: {
            id: true,
            status: true,
            format: true,
            packaging: true,
            outputBlob: { select: { status: true, deletedAt: true, mediaType: true } },
          },
        },
      },
    });
    if (!preview) throw notFoundProblem("Project preview");
    const job = preview.exportJob;
    if (
      job.status !== "succeeded"
      || job.format !== "html"
      || job.packaging !== "single_file"
      || job.outputBlob?.status !== "ready"
      || job.outputBlob.deletedAt !== null
      || !/^text\/html(?:;\s*charset=utf-8)?$/i.test(job.outputBlob.mediaType)
    ) {
      throw exportStateConflictProblem("Only a succeeded Project preview with a readable output can be opened");
    }
    const capability = this.preview.createCapability(job.id, now, preview.expiresAt);
    return exportPreviewTokenResponseSchema.parse({
      url: capability.url,
      expiresAt: capability.expiresAt.toISOString(),
    });
  }

  async get(principalId: string, exportId: string): Promise<ExportJob> {
    return mapExportJob(await this.findAuthorized(principalId, exportId, "edit"));
  }

  async createPreviewToken(
    principalId: string,
    exportId: string,
  ): Promise<ExportPreviewTokenResponse> {
    const job = await this.db.exportJob.findFirst({
      where: {
        id: exportId,
        purpose: "export",
        preview: null,
        release: {
          is: {
            project: {
              is: {
                status: "active",
                members: projectMembershipFilter(principalId, "edit"),
              },
            },
          },
        },
      },
      select: {
        id: true,
        status: true,
        format: true,
        packaging: true,
        outputBlob: {
          select: { status: true, deletedAt: true, mediaType: true },
        },
      },
    });
    if (!job) throw notFoundProblem("Export job");
    if (
      job.status !== "succeeded"
      || job.format !== "html"
      || job.packaging !== "single_file"
      || job.outputBlob?.status !== "ready"
      || job.outputBlob.deletedAt !== null
      || !/^text\/html(?:;\s*charset=utf-8)?$/i.test(job.outputBlob.mediaType)
    ) {
      throw exportStateConflictProblem("Only a succeeded HTML Export with a readable output can be previewed");
    }
    const capability = this.preview.createCapability(job.id);
    return exportPreviewTokenResponseSchema.parse({
      url: capability.url,
      expiresAt: capability.expiresAt.toISOString(),
    });
  }

  async cancel(
    principalId: string,
    exportId: string,
    expectedRevision: number,
  ): Promise<ExportJob> {
    const current = await this.findAuthorized(principalId, exportId, "edit");
    if (current.revision !== expectedRevision) throw revisionConflictProblem();
    if (current.status === "cancelled") return mapExportJob(current);
    if (!["queued", "running"].includes(current.status)) {
      throw exportStateConflictProblem(`The Export cannot be cancelled while it is ${current.status}`);
    }
    if (!current.releaseId) throw notFoundProblem("Project release");
    const release = await this.db.projectRelease.findUnique({
      where: { id: current.releaseId },
      select: { projectId: true },
    });
    if (!release) throw notFoundProblem("Project release");
    const cancelled = await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, release.projectId, principalId, "edit");
      const result = await tx.exportJob.updateMany({
        where: {
          id: exportId,
          revision: expectedRevision,
          status: { in: ["queued", "running"] },
        },
        data: {
          status: "cancelled",
          finishedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      const latest = await tx.exportJob.findUnique({
        where: { id: exportId },
        include: exportJobInclude,
      });
      if (!latest) throw notFoundProblem("Export job");
      if (result.count !== 1) {
        if (latest.revision !== expectedRevision) throw revisionConflictProblem();
        throw exportStateConflictProblem(`The Export cannot be cancelled while it is ${latest.status}`);
      }
      return latest as ExportJobRecord;
    });
    return mapExportJob(cancelled);
  }

  async getContent(
    principalId: string,
    exportId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
    signal?: AbortSignal,
  ) {
    const job = await this.db.exportJob.findFirst({
      where: {
        id: exportId,
        purpose: "export",
        preview: null,
        release: {
          is: {
            project: {
              is: {
                status: "active",
                members: projectMembershipFilter(principalId, "edit"),
              },
            },
          },
        },
      },
      select: {
        id: true,
        status: true,
        format: true,
        packaging: true,
        outputBlob: {
          select: {
            storageKey: true,
            sha256: true,
            byteSize: true,
            mediaType: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });
    const blob = job?.outputBlob;
    if (!job) throw notFoundProblem("Export job");
    if (job.status !== "succeeded" || !blob || blob.status !== "ready" || blob.deletedAt !== null) {
      throw exportStateConflictProblem("Export content is available only after a successful build");
    }
    const byteSize = safeByteSize(blob.byteSize);
    const content = await readReadyObject(this.storage, {
      storageKey: blob.storageKey,
      sha256: blob.sha256,
      byteSize,
      mediaType: blob.mediaType,
    }, rangeHeader, ifNoneMatch, {
      signal,
      recordIntegrityFailure: readyObjectIntegrityRecorder(this.db),
    });
    return {
      ...content,
      fileName: outputFileName(job.id, job.format, job.packaging),
    };
  }

  private findPreviewByReceipt(projectId: string, idempotencyKey: string) {
    return this.db.projectPreview.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      include: { exportJob: { include: exportJobInclude } },
    }) as Promise<PreviewRecord | null>;
  }

  private findByReceipt(releaseId: string, idempotencyKey: string) {
    return this.db.exportJob.findUnique({
      where: { releaseId_idempotencyKey: { releaseId, idempotencyKey } },
      include: exportJobInclude,
    }) as Promise<ExportJobRecord | null>;
  }

  private async findAuthorized(
    principalId: string,
    exportId: string,
    capability: ProjectCapability,
  ): Promise<ExportJobRecord> {
    const job = await this.db.exportJob.findFirst({
      where: {
        id: exportId,
        purpose: "export",
        preview: null,
        release: {
          is: {
            project: {
              is: {
                status: "active",
                members: projectMembershipFilter(principalId, capability),
              },
            },
          },
        },
      },
      include: exportJobInclude,
    });
    if (!job) throw notFoundProblem("Export job");
    return job as ExportJobRecord;
  }

  private resolveIdempotent(job: ExportJobRecord, principalId: string, requestHash: string) {
    if (job.requestHash !== requestHash || job.createdById !== principalId) {
      throw idempotencyConflictProblem();
    }
    return mapExportJob(job);
  }

  private resolvePreviewIdempotent(job: PreviewRecord, principalId: string, requestHash: string) {
    if (job.requestHash !== requestHash || job.createdById !== principalId) {
      throw idempotencyConflictProblem();
    }
    return mapProjectPreview(job);
  }
}

function mapProjectPreview(record: PreviewRecord): ProjectPreview {
  const expired = record.expiresAt.getTime() <= Date.now();
  return projectPreviewSchema.parse({
    id: record.id,
    projectId: record.projectId,
    boardId: record.boardId,
    boardRevision: record.boardRevision,
    selection: mapExportSelection(record.exportJob),
    initialScreenId: record.initialScreenId ?? null,
    status: expired ? "expired" : record.exportJob.status,
    revision: record.exportJob.revision,
    failure: exportFailure(record.exportJob),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function assertFigmaSelection(
  format: CreateExportJobRequest["format"],
  selection: ExportSelection,
  release: ProjectRelease,
) {
  if (format !== "figma") return;
  const selected = selectedReleasePins(selection, release);
  if (selection.kind === "artifact" && selected.length !== 1) {
    throw validationProblem("The selected Artifact version is not pinned by this Project release");
  }
  if (selected.length > 0 && selected.every((pin) => pin.kind === "design_system")) {
    throw validationProblem("Figma Export does not support Design System-only selections");
  }
  if (!selected.some((pin) => pin.kind === "prototype")) {
    throw validationProblem("Figma Export requires at least one pinned Prototype Artifact version");
  }
  if (selected.some((pin) => pin.kind !== "prototype")) {
    throw validationProblem("Figma Export cannot omit non-Prototype artifacts from a mixed selection");
  }
}

function assertExportPackaging(request: Pick<CreateExportJobRequest, "format" | "packaging">) {
  const requiredPackaging = requiredExportPackaging(request.format);
  if (requiredPackaging !== null && request.packaging !== requiredPackaging) {
    throw validationProblem(`${request.format} exports must use ${requiredPackaging} packaging`);
  }
}

function assertBoardNodeSelection(
  selection: ExportSelection,
  release: Pick<ProjectRelease, "boardSnapshot">,
) {
  if (selection.kind !== "board_nodes") return;
  const { missingNodeIds } = resolveExportBoardNodeSelection(
    release.boardSnapshot.nodes,
    selection.nodeIds,
  );
  if (missingNodeIds.length > 0) {
    throw validationProblem("Every selected Board node must belong to this Project release");
  }
}

function assertArtifactScreenSelection(
  selection: Extract<ExportSelection, { kind: "artifact" }>,
  pin: ArtifactScreenPin,
) {
  assertArtifactScreenId(selection.screenId, pin, "screenId");
}

type ArtifactScreenPin = {
  kind: string;
  artifactVersion: {
    status: string;
    content: unknown;
    contentBlobId: string | null;
    artifact: { kind: string };
  };
};

function assertArtifactScreenId(
  screenId: string | undefined,
  pin: ArtifactScreenPin,
  field: "screenId" | "initialScreenId",
) {
  if (screenId === undefined) return;
  if (pin.kind !== "prototype" || pin.artifactVersion.artifact.kind !== "prototype") {
    throw validationProblem(`${field} is supported only for Prototype Artifact selections`);
  }
  if (
    pin.artifactVersion.status !== "ready"
    || pin.artifactVersion.contentBlobId !== null
    || pin.artifactVersion.content === null
  ) {
    throw validationProblem(`${field} requires a ready inline Prototype Artifact version`);
  }
  const document = prototypeDocumentSchema.safeParse(pin.artifactVersion.content);
  if (!document.success) {
    throw validationProblem("The selected Prototype Artifact version has invalid content");
  }
  if (!document.data.screens.some((screen) => screen.id === screenId)) {
    throw validationProblem("The selected screen does not exist in this Prototype Artifact version");
  }
}

function assertPreviewSelectionShape(request: CreateProjectPreviewRequest) {
  if (request.selection.kind === "artifact" && request.selection.screenId !== undefined) {
    throw validationProblem("Project Preview selection cannot crop a Prototype to one screen");
  }
  if (request.initialScreenId != null && request.selection.kind !== "artifact") {
    throw validationProblem("initialScreenId requires an Artifact selection");
  }
}

function assertPreviewInitialScreen(
  initialScreenId: string | null,
  pin: ArtifactScreenPin,
) {
  if (initialScreenId === null) return;
  assertArtifactScreenId(initialScreenId, pin, "initialScreenId");
}

function selectedReleasePins(selection: ExportSelection, release: ProjectRelease) {
  if (selection.kind === "release") return release.artifactPins;
  if (selection.kind === "artifact") {
    return release.artifactPins.filter((pin) => pin.artifactId === selection.artifactId
      && pin.artifactVersionId === selection.artifactVersionId);
  }
  const selectedNodes = selection.kind === "board_nodes"
    ? resolveExportBoardNodeSelection(release.boardSnapshot.nodes, selection.nodeIds).selectedNodes
    : release.boardSnapshot.nodes;
  const versionIds = new Set(selectedNodes.flatMap((node) => (
    node.artifactVersionId ? [node.artifactVersionId] : []
  )));
  return release.artifactPins.filter((pin) => versionIds.has(pin.artifactVersionId));
}

export function encodeExportCursor(cursor: ExportCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeExportCursor(value: string): ExportCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ExportCursor>;
    if (!parsed.id || !parsed.createdAt || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch {
    throw validationProblem("The Export cursor is invalid");
  }
}

function clampLimit(value?: number) {
  return Math.min(Math.max(value ?? 30, 1), 100);
}
