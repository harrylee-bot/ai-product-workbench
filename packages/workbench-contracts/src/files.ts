import { z } from "zod";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const safeIntegerSchema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const maximumUserUploadByteSize = 25 * 1024 ** 2;

export const fileExtractionParser = "docling-serve";
export const fileExtractionParserComponents = {
  "docling-serve": "1.26.0",
  docling: "2.107.0",
  "docling-core": "2.85.0",
  "docling-parse": "7.2.0",
  "docling-jobkit": "2.0.0",
  "docling-ibm-models": "3.13.3",
} as const;
export const fileExtractionParserVersion = "docling-serve/1.26.0+docling/2.107.0+core/2.85.0+parse/7.2.0";
export const fileExtractionOutputSchemaVersion = 1;

export const uploadObjectByteSizeSchema = z.number()
  .int()
  .positive()
  .max(maximumUserUploadByteSize);

export const uploadPartByteSizeSchema = z.number()
  .int()
  .positive()
  .max(5 * 1024 ** 3);

export const uploadPartSizeSchema = z.number()
  .int()
  .min(5 * 1024 ** 2)
  .max(2_147_483_647);

export const mediaTypeSchema = z.string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);

export const fileNameSchema = z.string()
  .min(1)
  .max(500)
  .regex(/^(?=.*\S)(?!\.{1,2}$)[^\u0000-\u001f\u007f/\\]+$/, {
    message: "File names cannot be blank, relative path segments, or contain path/control characters",
  });

export const multipartEtagSchema = z.string()
  .min(3)
  .max(258)
  .regex(/^"[\x21\x23-\x7e]{1,256}"$/);

export const uploadPartNumberSchema = z.number().int().min(1).max(10_000);

export const fileStatusSchema = z.enum([
  "uploading",
  "verifying",
  "ready",
  "failed",
  "quarantined",
  "deleted",
]);

export const uploadStatusSchema = z.enum([
  "initiating",
  "initiated",
  "completing",
  "completed",
  "aborting",
  "aborted",
  "expired",
  "failed",
]);

export const extractionStatusSchema = z.enum([
  "queued",
  "running",
  "ready",
  "unsupported",
  "failed",
]);

export const fileFailureSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(2_000),
}).strict();

export const fileExtractionSchema = z.object({
  id: opaqueIdSchema,
  fileAssetId: opaqueIdSchema,
  attempt: z.number().int().positive(),
  status: extractionStatusSchema,
  parser: z.string().min(1).max(120),
  parserVersion: z.string().min(1).max(120),
  outputSchemaVersion: z.number().int().positive(),
  contentSha256: sha256Schema.nullable(),
  failure: fileFailureSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((extraction, context) => {
  const terminal = ["ready", "unsupported", "failed"].includes(extraction.status);
  if (extraction.status === "queued" && (extraction.startedAt !== null || extraction.finishedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Queued extractions cannot have execution timestamps",
    });
  }
  if (extraction.status === "running" && (extraction.startedAt === null || extraction.finishedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Running extractions require startedAt and cannot have finishedAt",
    });
  }
  if (terminal && extraction.finishedAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["finishedAt"],
      message: "Terminal extractions require finishedAt",
    });
  }
  if (extraction.status === "ready" && (extraction.contentSha256 === null || extraction.failure !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Ready extractions require contentSha256 and cannot carry a failure",
    });
  }
});

export const fileAssetSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  blobId: opaqueIdSchema.nullable(),
  originalName: fileNameSchema,
  declaredMediaType: mediaTypeSchema,
  detectedMediaType: mediaTypeSchema.nullable(),
  byteSize: safeIntegerSchema,
  status: fileStatusSchema,
  revision: revisionSchema,
  sha256: sha256Schema.nullable(),
  failure: fileFailureSchema.nullable(),
  currentExtraction: fileExtractionSchema.nullable(),
  latestExtraction: fileExtractionSchema.nullable(),
  verifiedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((file, context) => {
  if (file.status === "ready" && (
    file.blobId === null
    || file.detectedMediaType === null
    || file.sha256 === null
    || file.verifiedAt === null
    || file.failure !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Ready files require verified blob metadata and cannot carry a failure",
    });
  }
  if (file.currentExtraction && (
    file.currentExtraction.fileAssetId !== file.id
    || file.currentExtraction.status !== "ready"
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currentExtraction"],
      message: "The current extraction must be a ready extraction for this file",
    });
  }
  if (file.latestExtraction && file.latestExtraction.fileAssetId !== file.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["latestExtraction"],
      message: "The latest extraction must belong to this file",
    });
  }
  if (file.currentExtraction && file.latestExtraction
    && file.latestExtraction.attempt < file.currentExtraction.attempt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["latestExtraction", "attempt"],
      message: "The latest extraction cannot precede the current ready extraction",
    });
  }
});

export const fileUploadSessionSchema = z.object({
  id: opaqueIdSchema,
  fileAssetId: opaqueIdSchema,
  status: uploadStatusSchema,
  partSize: uploadPartSizeSchema,
  revision: revisionSchema,
  expiresAt: isoDateTimeSchema,
}).strict();

export const submissionIntentClientFingerprintSchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => /\S/u.test(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value), {
    message: "SubmissionIntent client fingerprints cannot be blank or contain control characters",
  });

export const submissionIntentUploadBindingSchema = z.object({
  submissionIntentId: opaqueIdSchema,
  attachmentPosition: z.number().int().nonnegative().max(49),
  clientFingerprint: submissionIntentClientFingerprintSchema,
}).strict();

export const createFileUploadRequestSchema = z.object({
  fileName: fileNameSchema,
  declaredMediaType: mediaTypeSchema,
  byteSize: uploadObjectByteSizeSchema,
  sha256: sha256Schema.optional(),
  submissionIntent: submissionIntentUploadBindingSchema.optional(),
}).strict();

export const createFileUploadResponseSchema = z.object({
  file: fileAssetSchema,
  upload: fileUploadSessionSchema,
}).strict();

export const signUploadPartRequestSchema = z.object({
  contentLength: uploadPartByteSizeSchema,
}).strict();

export const signedHeadersSchema = z.record(
  z.string().min(1).max(128).regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/),
  z.string().max(4_096).regex(/^[^\u0000-\u001f\u007f]*$/, {
    message: "Signed upload header values cannot contain control characters",
  }),
).superRefine((headers, context) => {
  for (const name of Object.keys(headers)) {
    if (["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase())) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: "Signed upload headers cannot carry ambient credentials",
      });
    }
  }
});

export const signedUploadUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}, {
  message: "Signed upload URLs require HTTPS, except loopback HTTP in local development",
});

export const signUploadPartResponseSchema = z.object({
  uploadSessionId: opaqueIdSchema,
  partNumber: uploadPartNumberSchema,
  method: z.literal("PUT"),
  url: signedUploadUrlSchema,
  headers: signedHeadersSchema,
  expiresAt: isoDateTimeSchema,
}).strict();

export const uploadedPartSchema = z.object({
  partNumber: uploadPartNumberSchema,
  etag: multipartEtagSchema,
  byteSize: uploadPartByteSizeSchema,
}).strict();

export const completedPartSchema = z.object({
  partNumber: uploadPartNumberSchema,
  etag: multipartEtagSchema,
}).strict();

function strictlyAscendingParts<T extends { partNumber: number }>(
  parts: T[],
  context: z.RefinementCtx,
) {
  for (let index = 1; index < parts.length; index += 1) {
    const previous = parts[index - 1];
    const current = parts[index];
    if (previous && current && current.partNumber <= previous.partNumber) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "partNumber"],
        message: "Multipart parts must have unique, strictly ascending part numbers",
      });
      return;
    }
  }
}

export const listUploadPartsResponseSchema = z.object({
  parts: z.array(uploadedPartSchema).max(10_000),
}).strict().superRefine((value, context) => strictlyAscendingParts(value.parts, context));

export const completeFileUploadRequestSchema = z.object({
  parts: z.array(completedPartSchema).min(1).max(10_000),
  sha256: sha256Schema.optional(),
}).strict().superRefine((value, context) => strictlyAscendingParts(value.parts, context));

export const completeFileUploadResponseSchema = z.object({
  file: fileAssetSchema,
  upload: fileUploadSessionSchema,
}).strict();

export const fileListSchema = z.object({
  items: z.array(fileAssetSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export type FileStatus = z.infer<typeof fileStatusSchema>;
export type UploadStatus = z.infer<typeof uploadStatusSchema>;
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;
export type FileFailure = z.infer<typeof fileFailureSchema>;
export type FileExtraction = z.infer<typeof fileExtractionSchema>;
export type FileAsset = z.infer<typeof fileAssetSchema>;
export type FileUploadSession = z.infer<typeof fileUploadSessionSchema>;
export type SubmissionIntentUploadBinding = z.infer<typeof submissionIntentUploadBindingSchema>;
export type CreateFileUploadRequest = z.infer<typeof createFileUploadRequestSchema>;
export type CreateFileUploadResponse = z.infer<typeof createFileUploadResponseSchema>;
export type SignUploadPartRequest = z.infer<typeof signUploadPartRequestSchema>;
export type SignUploadPartResponse = z.infer<typeof signUploadPartResponseSchema>;
export type UploadedPart = z.infer<typeof uploadedPartSchema>;
export type CompletedPart = z.infer<typeof completedPartSchema>;
export type ListUploadPartsResponse = z.infer<typeof listUploadPartsResponseSchema>;
export type CompleteFileUploadRequest = z.infer<typeof completeFileUploadRequestSchema>;
export type CompleteFileUploadResponse = z.infer<typeof completeFileUploadResponseSchema>;
export type FileList = z.infer<typeof fileListSchema>;
