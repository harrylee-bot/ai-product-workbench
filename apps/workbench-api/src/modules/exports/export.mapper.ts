import {
  exportBoardNodeIdsSchema,
  exportJobSchema,
  exportOptionsSchema,
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
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
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
  // Blob quarantine changes the public projection even though the immutable
  // ExportJob row has not been rewritten. Advance the public validator so a
  // cached succeeded response cannot survive as a 304 after output disappears.
  const publicRevision = outputUnavailable ? record.revision + 1 : record.revision;
  return exportJobSchema.parse({
    id: record.id,
    releaseId: requireValue(record.releaseId, "releaseId"),
    createdById: record.createdById,
    format: record.format,
    packaging: record.packaging,
    selection,
    status: outputUnavailable ? "failed" : record.status,
    revision: publicRevision,
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
  packaging: ExportPackaging,
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
