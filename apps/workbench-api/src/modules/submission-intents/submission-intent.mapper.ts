import {
  submissionIntentRunRequestSchema,
  submissionIntentSchema,
  type SubmissionIntent,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";

export const submissionIntentSelect = {
  id: true,
  projectId: true,
  threadId: true,
  createdById: true,
  status: true,
  request: true,
  requestHash: true,
  idempotencyKey: true,
  runIdempotencyKey: true,
  runId: true,
  lastFailureCode: true,
  lastFailureDetail: true,
  lastFailureRetryable: true,
  revision: true,
  submittedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  attachments: {
    orderBy: { position: "asc" as const },
    select: {
      position: true,
      kind: true,
      fileAssetId: true,
      clientFingerprint: true,
      fileName: true,
      declaredMediaType: true,
      byteSize: true,
      lastModified: true,
      file: { select: { status: true } },
    },
  },
} as const;

export type SubmissionIntentRecord = Prisma.SubmissionIntentGetPayload<{
  select: typeof submissionIntentSelect;
}>;

export function mapSubmissionIntent(intent: SubmissionIntentRecord): SubmissionIntent {
  return submissionIntentSchema.parse({
    id: intent.id,
    projectId: intent.projectId,
    threadId: intent.threadId,
    status: intent.status,
    request: submissionIntentRunRequestSchema.parse(intent.request),
    attachments: intent.attachments.map((attachment) => {
      if (attachment.kind === "existing") {
        if (!attachment.fileAssetId) {
          throw new Error("Persisted existing SubmissionIntent attachment is not linked");
        }
        return {
          kind: "existing" as const,
          position: attachment.position,
          fileAssetId: attachment.fileAssetId,
          fileStatus: attachment.file?.status ?? null,
        };
      }
      if (
        attachment.clientFingerprint === null
        || attachment.fileName === null
        || attachment.declaredMediaType === null
        || attachment.byteSize === null
        || attachment.lastModified === null
      ) {
        throw new Error("Persisted upload SubmissionIntent attachment metadata is incomplete");
      }
      return {
        kind: "upload" as const,
        position: attachment.position,
        fileAssetId: attachment.fileAssetId,
        fileStatus: attachment.file?.status ?? null,
        clientFingerprint: attachment.clientFingerprint,
        fileName: attachment.fileName,
        declaredMediaType: attachment.declaredMediaType,
        byteSize: safeInteger(attachment.byteSize, "byteSize"),
        lastModified: safeInteger(attachment.lastModified, "lastModified"),
      };
    }),
    runId: intent.runId,
    lastFailure: mapLastFailure(intent),
    revision: intent.revision,
    submittedAt: intent.submittedAt?.toISOString() ?? null,
    cancelledAt: intent.cancelledAt?.toISOString() ?? null,
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
  });
}

function mapLastFailure(intent: Pick<
  SubmissionIntentRecord,
  "lastFailureCode" | "lastFailureDetail" | "lastFailureRetryable"
>): SubmissionIntent["lastFailure"] {
  if (
    intent.lastFailureCode === null
    && intent.lastFailureDetail === null
    && intent.lastFailureRetryable === null
  ) return null;
  if (
    intent.lastFailureCode === null
    || intent.lastFailureDetail === null
    || intent.lastFailureRetryable === null
  ) throw new Error("Persisted SubmissionIntent failure snapshot is incomplete");
  return {
    code: intent.lastFailureCode,
    message: intent.lastFailureDetail,
    retryable: intent.lastFailureRetryable,
  };
}

function safeInteger(value: bigint, field: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Persisted SubmissionIntent ${field} is outside the JSON safe-integer range`);
  }
  return number;
}
