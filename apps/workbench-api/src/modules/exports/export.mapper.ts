import {
  externalExportDeliverySchema,
  exportBoardNodeIdsSchema,
  exportJobSchema,
  exportOptionsSchema,
  externalExportPayloadSnapshotSchema,
  type ExternalExportDelivery,
  type ExternalExportPayloadSnapshot,
  type ExportPackaging,
  type ExportFormat,
  type ExportJob,
} from "@workbench/workbench-contracts";

export const exportJobInclude = {
  outputBlob: {
    select: {
      id: true,
      mediaType: true,
      byteSize: true,
      sha256: true,
      status: true,
      deletedAt: true,
    },
  },
} as const;

export type ExportJobRecord = {
  id: string;
  releaseId: string | null;
  createdById: string;
  requestHash: string;
  format: ExportFormat;
  packaging: ExportPackaging;
  selectionKind: "release" | "board" | "board_nodes" | "artifact";
  selectionArtifactId: string | null;
  selectionArtifactVersionId: string | null;
  selectionScreenId: string | null;
  selectionNodeIds: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  revision: number;
  options: unknown;
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
  outputBlob: {
    id: string;
    mediaType: string;
    byteSize: bigint;
    sha256: string;
    status: string;
    deletedAt: Date | null;
  } | null;
};

export function mapExportJob(record: ExportJobRecord): ExportJob {
  const publicOptions = exportOptionsSchema.parse(record.options);
  const selection = mapExportSelection(record);
  // A completed job is immutable, but its Blob can later be quarantined.
  // Report the unavailable delivery without hiding other jobs on the page.
  const outputUnavailable = record.status === "succeeded" && (
    record.outputBlob?.status !== "ready" || record.outputBlob.deletedAt !== null
  );
  const output = record.outputBlob === null || outputUnavailable
    ? null
    : {
        blobId: record.outputBlob.id,
        mediaType: record.outputBlob.mediaType,
        byteSize: safeByteSize(record.outputBlob.byteSize),
        sha256: record.outputBlob.sha256,
        fileName: outputFileName(record.id, record.format, record.packaging),
      };
  return exportJobSchema.parse({
    id: record.id,
    releaseId: requireValue(record.releaseId, "releaseId"),
    createdById: record.createdById,
    format: record.format,
    packaging: record.packaging,
    selection,
    status: outputUnavailable ? "failed" : record.status,
    revision: record.revision,
    options: publicOptions,
    output,
    failure: outputUnavailable
      ? { code: "EXPORT_OUTPUT_BLOB_NOT_READABLE", detail: "The generated file is unavailable. Create a new export to regenerate it." }
      : exportFailure(record),
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  });
}

export type ExternalExportDeliveryRecord = {
  id: string;
  exportJobId: string;
  createdById: string;
  requestHash: string;
  target: "ai_studio" | "netlify" | "lovable" | "bolt";
  authentication: "not_required" | "required" | "authenticated";
  status: "pending_confirmation" | "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  revision: number;
  attempt: number;
  payload: unknown;
  remoteReference: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  startedAt: Date | null;
  transferAuthorizedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
};

export function mapExternalExportDelivery(record: ExternalExportDeliveryRecord): ExternalExportDelivery {
  const payload = externalExportPayloadSnapshotSchema.parse(record.payload);
  return externalExportDeliverySchema.parse({
    id: record.id,
    exportJobId: record.exportJobId,
    createdById: record.createdById,
    target: record.target,
    authentication: record.authentication,
    status: record.status,
    revision: record.revision,
    attempt: record.attempt,
    payload,
    remoteReference: record.remoteReference,
    failure: record.failureCode === null
      ? null
      : { code: record.failureCode, detail: record.failureDetail },
    createdAt: record.createdAt.toISOString(),
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
    startedAt: record.startedAt?.toISOString() ?? null,
    transferAuthorizedAt: record.transferAuthorizedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function externalExportPayloadFromJob(job: {
  id: string;
  releaseId: string | null;
  format: ExportFormat;
  packaging: ExportPackaging;
  selection: ExportJob["selection"];
  outputBlob: { mediaType: string; byteSize: bigint; sha256: string };
}): ExternalExportPayloadSnapshot {
  if (!job.releaseId) throw new Error("EXPORT_EXTERNAL_RELEASE_MISSING");
  return externalExportPayloadSnapshotSchema.parse({
    exportJobId: job.id,
    releaseId: job.releaseId,
    format: job.format,
    packaging: job.packaging,
    selection: job.selection,
    output: {
      mediaType: job.outputBlob.mediaType,
      byteSize: safeByteSize(job.outputBlob.byteSize),
      sha256: job.outputBlob.sha256,
      fileName: outputFileName(job.id, job.format, job.packaging),
    },
  });
}

export function mapExportSelection(record: Pick<ExportJobRecord,
  | "selectionKind"
  | "selectionArtifactId"
  | "selectionArtifactVersionId"
  | "selectionScreenId"
  | "selectionNodeIds"
>) {
  return record.selectionKind === "artifact"
    ? {
        kind: "artifact" as const,
        artifactId: requireValue(record.selectionArtifactId, "selectionArtifactId"),
        artifactVersionId: requireValue(record.selectionArtifactVersionId, "selectionArtifactVersionId"),
        ...(record.selectionScreenId === null ? {} : { screenId: record.selectionScreenId }),
      }
    : record.selectionKind === "board_nodes"
      ? {
          kind: "board_nodes" as const,
          nodeIds: exportBoardNodeIdsSchema.parse(record.selectionNodeIds),
        }
      : { kind: record.selectionKind };
}

export function exportFailure(record: Pick<ExportJobRecord, "failureCode" | "failureDetail">) {
  return record.failureCode === null
    ? null
    : { code: record.failureCode, detail: record.failureDetail };
}

export function outputFileName(
  exportId: string,
  format: ExportFormat,
  packaging: ExportPackaging = format === "html" || format === "docx" || format === "pdf" ? "single_file" : "zip",
) {
  const extension: Record<ExportFormat, string> = {
    html: "html",
    react: "zip",
    figma: "zip",
    mcp: "zip",
    docx: "docx",
    pdf: "pdf",
  };
  const effectiveExtension = packaging === "zip" ? "zip" : extension[format];
  return `workbench-export-${exportId}.${effectiveExtension}`;
}

function requireValue(value: string | null, name: string) {
  if (value === null) throw new Error(`EXPORT_${name.toUpperCase()}_MISSING`);
  return value;
}

export function safeByteSize(value: bigint) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("EXPORT_OUTPUT_BYTE_SIZE_INVALID");
  return parsed;
}
