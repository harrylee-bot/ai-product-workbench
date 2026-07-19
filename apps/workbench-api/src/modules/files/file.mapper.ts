import {
  fileAssetSchema,
  fileExtractionSchema,
  fileUploadSessionSchema,
  type FileAsset,
  type FileExtraction,
  type FileUploadSession,
} from "@workbench/workbench-contracts";

type ExtractionRecord = {
  id: string;
  fileAssetId: string;
  attempt: number;
  status: "queued" | "running" | "ready" | "unsupported" | "failed";
  parser: string;
  parserVersion: string;
  outputSchemaVersion: number;
  contentSha256: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type FileRecord = {
  id: string;
  projectId: string;
  blobId: string | null;
  originalName: string;
  declaredMediaType: string;
  detectedMediaType: string | null;
  byteSize: bigint;
  status: "uploading" | "verifying" | "ready" | "failed" | "quarantined" | "deleted";
  revision: number;
  failureCode: string | null;
  failureDetail: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  blob: { sha256: string } | null;
  currentExtraction: ExtractionRecord | null;
  extractions: ExtractionRecord[];
};

type UploadRecord = {
  id: string;
  fileAssetId: string;
  status: "initiating" | "initiated" | "completing" | "completed" | "aborting" | "aborted" | "expired" | "failed";
  partSize: number;
  revision: number;
  expiresAt: Date;
};

export function mapFileExtraction(extraction: ExtractionRecord): FileExtraction {
  return fileExtractionSchema.parse({
    id: extraction.id,
    fileAssetId: extraction.fileAssetId,
    attempt: extraction.attempt,
    status: extraction.status,
    parser: extraction.parser,
    parserVersion: extraction.parserVersion,
    outputSchemaVersion: extraction.outputSchemaVersion,
    contentSha256: extraction.contentSha256,
    failure: publicFailure(extraction.failureCode),
    startedAt: extraction.startedAt?.toISOString() ?? null,
    finishedAt: extraction.finishedAt?.toISOString() ?? null,
    createdAt: extraction.createdAt.toISOString(),
    updatedAt: extraction.updatedAt.toISOString(),
  });
}

export function mapFileAsset(file: FileRecord): FileAsset {
  return fileAssetSchema.parse({
    id: file.id,
    projectId: file.projectId,
    blobId: file.blobId,
    originalName: file.originalName,
    declaredMediaType: file.declaredMediaType,
    detectedMediaType: file.detectedMediaType,
    byteSize: safeByteSize(file.byteSize),
    status: file.status,
    revision: file.revision,
    sha256: file.blob?.sha256 ?? null,
    failure: publicFailure(file.failureCode),
    currentExtraction: file.currentExtraction ? mapFileExtraction(file.currentExtraction) : null,
    latestExtraction: file.extractions[0] ? mapFileExtraction(file.extractions[0]) : null,
    verifiedAt: file.verifiedAt?.toISOString() ?? null,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  });
}

export function mapFileUploadSession(upload: UploadRecord): FileUploadSession {
  return fileUploadSessionSchema.parse({
    id: upload.id,
    fileAssetId: upload.fileAssetId,
    status: upload.status,
    partSize: upload.partSize,
    revision: upload.revision,
    expiresAt: upload.expiresAt.toISOString(),
  });
}

export function safeByteSize(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("File byte size is outside the public integer range");
  return number;
}

const publicFailureMessages: Record<string, string> = {
  UPLOAD_ABORTED: "The upload was cancelled.",
  UPLOAD_FAILED: "The file could not be uploaded.",
  OBJECT_NOT_FOUND: "The uploaded object could not be found.",
  BYTE_SIZE_MISMATCH: "The uploaded file size did not match the declared size.",
  SHA256_MISMATCH: "The uploaded file digest did not match the declared digest.",
  MEDIA_TYPE_UNSUPPORTED: "This file type is not supported.",
  MALWARE_DETECTED: "The uploaded file did not pass the security scan.",
  EXTRACTION_UNSUPPORTED: "Content extraction is not supported for this file.",
  EXTRACTION_FAILED: "The file content could not be extracted.",
};

function publicFailure(code: string | null) {
  if (!code) return null;
  const safeCode = /^[A-Z0-9_.-]{1,120}$/.test(code) ? code : "FILE_PROCESSING_FAILED";
  return {
    code: safeCode,
    message: publicFailureMessages[safeCode] ?? "The file could not be processed.",
  };
}
