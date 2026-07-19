import type {
  FileAsset,
  FileExtraction,
} from "@workbench/workbench-contracts";

export type UploadLifecyclePhase =
  | "queued"
  | "preparing"
  | "uploading"
  | "paused"
  | "verifying"
  | "extracting"
  | "ready"
  | "failed"
  | "cancelled";

export type UploadLifecycleError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type UploadLifecycleProjection = {
  phase: UploadLifecyclePhase;
  extraction: FileExtraction | null;
  error: UploadLifecycleError | null;
};

export function projectUploadLifecycle(
  file: FileAsset,
  requestExtraction: boolean,
): UploadLifecycleProjection {
  const extraction = file.latestExtraction ?? file.currentExtraction;
  if (file.status === "uploading") return { phase: "uploading", extraction, error: null };
  if (file.status === "verifying") return { phase: "verifying", extraction, error: null };
  if (file.status !== "ready") {
    const fallback = fileTerminalFailure(file.status);
    return {
      phase: "failed",
      extraction,
      error: {
        code: file.failure?.code ?? fallback.code,
        message: file.failure?.message ?? fallback.message,
        retryable: false,
      },
    };
  }
  if (!requestExtraction) return { phase: "ready", extraction, error: null };
  if (!extraction || extraction.status === "queued" || extraction.status === "running") {
    return { phase: "extracting", extraction, error: null };
  }
  if (extraction.status === "ready") return { phase: "ready", extraction, error: null };

  const fallback = extraction.status === "unsupported"
    ? {
        code: "FILE_EXTRACTION_UNSUPPORTED",
        message: "This file type does not support content extraction",
      }
    : {
        code: "FILE_EXTRACTION_FAILED",
        message: "File content extraction failed",
      };
  return {
    phase: "failed",
    extraction,
    error: {
      code: extraction.failure?.code ?? fallback.code,
      message: extraction.failure?.message ?? fallback.message,
      retryable: false,
    },
  };
}

function fileTerminalFailure(status: Exclude<FileAsset["status"], "uploading" | "verifying" | "ready">) {
  if (status === "quarantined") {
    return { code: "FILE_QUARANTINED", message: "File processing quarantined this upload" };
  }
  if (status === "deleted") {
    return { code: "FILE_DELETED", message: "The uploaded file was deleted" };
  }
  return { code: "FILE_FAILED", message: "File processing failed" };
}
