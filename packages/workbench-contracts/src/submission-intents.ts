import { z } from "zod";
import {
  fileNameSchema,
  fileStatusSchema,
  mediaTypeSchema,
  safeIntegerSchema,
  submissionIntentClientFingerprintSchema,
  uploadObjectByteSizeSchema,
} from "./files.js";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";
import {
  runFailureSchema,
  runSchema,
  hasMissingPrdRequirementSource,
  missingPrdRequirementSourceMessage,
  refineRunWorkflowArtifactTargets,
  startRunRequestObjectSchema,
} from "./runs.js";

export const submissionIntentStatusSchema = z.enum([
  "pending",
  "submitting",
  "submitted",
  "cancelled",
]);

export const submissionIntentRunRequestSchema = startRunRequestObjectSchema
  .strict()
  .superRefine((request, context) => {
    refineRunWorkflowArtifactTargets(request, context);
    if (request.canvasSnapshot != null && request.canvasSnapshot.runId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canvasSnapshot", "runId"],
        message: "A client Canvas snapshot cannot claim a Run before submission",
      });
    }
  });

export const submissionIntentAttachmentRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("existing"),
    fileAssetId: opaqueIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("upload"),
    clientFingerprint: submissionIntentClientFingerprintSchema,
    fileName: fileNameSchema,
    declaredMediaType: mediaTypeSchema,
    byteSize: uploadObjectByteSizeSchema,
    lastModified: safeIntegerSchema,
  }).strict(),
]);

function refineSubmissionIntentSourceAttachments(
  value: Readonly<{
    request: {
      workflow: z.infer<typeof submissionIntentRunRequestSchema>["workflow"];
      sourceIds: readonly string[];
    };
    attachments: readonly unknown[];
  }>,
  context: z.RefinementCtx,
): void {
  if (
    value.request.workflow === "redesign"
    && value.attachments.length === 0
    && value.request.sourceIds.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachments"],
      message: "The redesign workflow requires at least one ready Import Source or upload slot",
    });
  }
}

export const createSubmissionIntentRequestSchema = z.object({
  request: submissionIntentRunRequestSchema,
  attachments: z.array(submissionIntentAttachmentRequestSchema).max(50),
}).strict().superRefine((value, context) => {
  const existingIds = new Set<string>();
  const uploadFingerprints = new Set<string>();
  for (const [index, attachment] of value.attachments.entries()) {
    if (attachment.kind === "existing") {
      if (existingIds.has(attachment.fileAssetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attachments", index, "fileAssetId"],
          message: "Existing attachment File ids must be unique",
        });
      }
      existingIds.add(attachment.fileAssetId);
      continue;
    }
    if (uploadFingerprints.has(attachment.clientFingerprint)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments", index, "clientFingerprint"],
        message: "Upload attachment client fingerprints must be unique",
      });
    }
    uploadFingerprints.add(attachment.clientFingerprint);
  }

  if (hasMissingPrdRequirementSource(value.request, value.attachments.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request", "prompt"],
      message: missingPrdRequirementSourceMessage,
    });
  }

  refineSubmissionIntentSourceAttachments(value, context);
});

const submissionIntentAttachmentOutputBase = {
  position: z.number().int().nonnegative().max(49),
  fileStatus: fileStatusSchema.nullable(),
};

export const submissionIntentAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({
    ...submissionIntentAttachmentOutputBase,
    kind: z.literal("existing"),
    fileAssetId: opaqueIdSchema,
  }).strict(),
  z.object({
    ...submissionIntentAttachmentOutputBase,
    kind: z.literal("upload"),
    fileAssetId: opaqueIdSchema.nullable(),
    clientFingerprint: submissionIntentClientFingerprintSchema,
    fileName: fileNameSchema,
    declaredMediaType: mediaTypeSchema,
    byteSize: uploadObjectByteSizeSchema,
    lastModified: safeIntegerSchema,
  }).strict(),
]);

export const submissionIntentSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  threadId: opaqueIdSchema,
  status: submissionIntentStatusSchema,
  request: submissionIntentRunRequestSchema,
  attachments: z.array(submissionIntentAttachmentSchema).max(50),
  runId: opaqueIdSchema.nullable(),
  lastFailure: runFailureSchema.nullable(),
  revision: revisionSchema,
  submittedAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((intent, context) => {
  refineSubmissionIntentSourceAttachments(intent, context);
  for (const [index, attachment] of intent.attachments.entries()) {
    if (attachment.position !== index) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments", index, "position"],
        message: "SubmissionIntent attachments must use contiguous request positions",
      });
    }
  }
  const submitted = intent.status === "submitted";
  if (submitted !== (intent.runId !== null && intent.submittedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Only a submitted SubmissionIntent may reference its Run and submitted timestamp",
    });
  }
  if (!submitted && (intent.runId !== null || intent.submittedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runId"],
      message: "A non-submitted SubmissionIntent cannot reference a Run",
    });
  }
  if ((intent.status === "cancelled") !== (intent.cancelledAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cancelledAt"],
      message: "A cancelled SubmissionIntent requires its cancelled timestamp",
    });
  }
});

export const currentSubmissionIntentSchema = z.object({
  item: submissionIntentSchema.nullable(),
}).strict();

export const submitSubmissionIntentResponseSchema = z.object({
  intent: submissionIntentSchema,
  run: runSchema,
}).strict();

export type SubmissionIntentStatus = z.infer<typeof submissionIntentStatusSchema>;
export type SubmissionIntentRunRequest = z.infer<typeof submissionIntentRunRequestSchema>;
export type SubmissionIntentAttachmentRequest = z.infer<typeof submissionIntentAttachmentRequestSchema>;
export type CreateSubmissionIntentRequest = z.infer<typeof createSubmissionIntentRequestSchema>;
export type SubmissionIntentAttachment = z.infer<typeof submissionIntentAttachmentSchema>;
export type SubmissionIntent = z.infer<typeof submissionIntentSchema>;
export type CurrentSubmissionIntent = z.infer<typeof currentSubmissionIntentSchema>;
export type SubmitSubmissionIntentResponse = z.infer<typeof submitSubmissionIntentResponseSchema>;
