import { randomUUID } from "node:crypto";
import { HttpException, Injectable } from "@nestjs/common";
import {
  createSubmissionIntentRequestSchema,
  currentSubmissionIntentSchema,
  startRunRequestSchema,
  submissionIntentRunRequestSchema,
  submitSubmissionIntentResponseSchema,
  type CreateSubmissionIntentRequest,
  type CurrentSubmissionIntent,
  type FileStatus,
  type SubmissionIntent,
  type SubmitSubmissionIntentResponse,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  submissionIntentStateConflictProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService, projectMembershipFilter, type ProjectCapability } from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { RunsService } from "../runs/runs.service.js";
import { RuntimeModelsService } from "../runtime/runtime-models.service.js";
import { ImportSourcesService } from "../import-sources/import-sources.service.js";
import {
  mapSubmissionIntent,
  submissionIntentSelect,
  type SubmissionIntentRecord,
} from "./submission-intent.mapper.js";

type LockedFile = Readonly<{ id: string; status: FileStatus }>;
type SubmissionClaim = Readonly<{
  kind: "start";
  threadId: string;
  runIdempotencyKey: string;
  request: ReturnType<typeof startRunRequestSchema.parse>;
}> | Readonly<{
  kind: "submitted";
  runId: string;
}>;

@Injectable()
export class SubmissionIntentsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
    private readonly runs: RunsService,
    private readonly runtimeModels: RuntimeModelsService,
    private readonly importSources: ImportSourcesService,
  ) {}

  async create(
    principalId: string,
    threadId: string,
    idempotencyKey: string,
    request: CreateSubmissionIntentRequest,
  ): Promise<SubmissionIntent> {
    validateIdempotencyKey(idempotencyKey);
    const normalized = createSubmissionIntentRequestSchema.parse(request);
    const requestHash = hashRequest(normalized);
    const thread = await this.access.findThread(principalId, threadId, "edit");

    const replay = await this.db.submissionIntent.findUnique({
      where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
      select: submissionIntentSelect,
    });
    if (replay) return this.resolveCreateReplay(replay, principalId, requestHash);

    const active = await this.db.submissionIntent.findFirst({
      where: { threadId, createdById: principalId, status: { in: ["pending", "submitting"] } },
      select: { id: true },
    });
    if (active) {
      throw submissionIntentStateConflictProblem(
        "This Thread already has an active SubmissionIntent for the current principal",
        "SUBMISSION_INTENT_ALREADY_ACTIVE",
      );
    }

    await this.runtimeModels.assertAvailable(normalized.request.modelId, normalized.request.workflow);
    const intentId = `intent_${randomUUID()}`;
    const runIdempotencyKey = `submission-intent:${randomUUID()}`;

    try {
      const intent = await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, thread.projectId, principalId, "edit");
        const lockedThreads = await tx.$queryRaw<Array<{ projectId: string; status: string }>>(Prisma.sql`
          SELECT "project_id" AS "projectId", "status"::text AS "status"
          FROM "threads"
          WHERE "id" = ${threadId}
          FOR UPDATE
        `);
        if (
          lockedThreads[0]?.status !== "active"
          || lockedThreads[0].projectId !== thread.projectId
        ) throw notFoundProblem("Thread");

        const duplicate = await tx.submissionIntent.findUnique({
          where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
          select: submissionIntentSelect,
        });
        if (duplicate) {
          this.assertCreateReplay(duplicate, principalId, requestHash);
          return duplicate;
        }

        const current = await tx.submissionIntent.findFirst({
          where: { threadId, createdById: principalId, status: { in: ["pending", "submitting"] } },
          select: { id: true },
        });
        if (current) {
          throw submissionIntentStateConflictProblem(
            "This Thread already has an active SubmissionIntent for the current principal",
            "SUBMISSION_INTENT_ALREADY_ACTIVE",
          );
        }

        await this.assertExistingAttachmentsReady(tx, thread.projectId, normalized);
        await tx.submissionIntent.create({
          data: {
            id: intentId,
            projectId: thread.projectId,
            threadId,
            createdById: principalId,
            request: normalized.request as Prisma.InputJsonValue,
            requestHash,
            idempotencyKey,
            runIdempotencyKey,
          },
        });
        if (normalized.attachments.length > 0) {
          await tx.submissionIntentAttachment.createMany({
            data: normalized.attachments.map((attachment, position) => ({
              submissionIntentId: intentId,
              projectId: thread.projectId,
              position,
              kind: attachment.kind,
              fileAssetId: attachment.kind === "existing" ? attachment.fileAssetId : null,
              clientFingerprint: attachment.kind === "upload" ? attachment.clientFingerprint : null,
              fileName: attachment.kind === "upload" ? attachment.fileName : null,
              declaredMediaType: attachment.kind === "upload" ? attachment.declaredMediaType : null,
              byteSize: attachment.kind === "upload" ? BigInt(attachment.byteSize) : null,
              lastModified: attachment.kind === "upload" ? BigInt(attachment.lastModified) : null,
            })),
          });
        }
        return tx.submissionIntent.findUniqueOrThrow({
          where: { id: intentId },
          select: submissionIntentSelect,
        });
      });
      return mapSubmissionIntent(intent);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const duplicate = await this.db.submissionIntent.findUnique({
        where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
        select: submissionIntentSelect,
      });
      if (duplicate) return this.resolveCreateReplay(duplicate, principalId, requestHash);
      const current = await this.db.submissionIntent.findFirst({
        where: { threadId, createdById: principalId, status: { in: ["pending", "submitting"] } },
        select: { id: true },
      });
      if (current) {
        throw submissionIntentStateConflictProblem(
          "This Thread already has an active SubmissionIntent for the current principal",
          "SUBMISSION_INTENT_ALREADY_ACTIVE",
        );
      }
      throw error;
    }
  }

  async current(principalId: string, threadId: string): Promise<CurrentSubmissionIntent> {
    await this.access.findThread(principalId, threadId, "read");
    const item = await this.db.submissionIntent.findFirst({
      where: {
        threadId,
        createdById: principalId,
        status: { in: ["pending", "submitting"] },
      },
      select: submissionIntentSelect,
    });
    return currentSubmissionIntentSchema.parse({
      item: item ? mapSubmissionIntent(item) : null,
    });
  }

  async get(principalId: string, intentId: string): Promise<SubmissionIntent> {
    return mapSubmissionIntent(await this.requireOwnedIntent(principalId, intentId, "read"));
  }

  async submit(principalId: string, intentId: string): Promise<SubmitSubmissionIntentResponse> {
    const visible = await this.requireOwnedIntent(principalId, intentId, "edit");
    await this.access.findThread(principalId, visible.threadId, "edit");
    let claim: SubmissionClaim;
    try {
      claim = await this.claimForSubmission(principalId, visible);
    } catch (error) {
      const submitted = await this.tryResetAfterStartFailure(intentId, boundedFailure(error), error);
      if (submitted?.runId) return this.submittedReceipt(principalId, intentId, submitted.runId);
      throw error;
    }
    if (claim.kind === "submitted") return this.submittedReceipt(principalId, intentId, claim.runId);

    try {
      const run = await this.runs.start(
        principalId,
        claim.threadId,
        claim.runIdempotencyKey,
        claim.request,
      );
      const intent = await this.finalizeSubmission(intentId, run.id);
      return submitSubmissionIntentResponseSchema.parse({ intent, run });
    } catch (error) {
      const submitted = await this.tryResetAfterStartFailure(intentId, boundedFailure(error), error);
      if (submitted?.runId) return this.submittedReceipt(principalId, intentId, submitted.runId);
      throw error;
    }
  }

  async cancel(principalId: string, intentId: string, expectedRevision: number): Promise<void> {
    const visible = await this.requireOwnedIntent(principalId, intentId, "edit");
    await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, visible.projectId, principalId, "edit");
      await lockSubmissionIntent(tx, intentId);
      const current = await tx.submissionIntent.findUnique({
        where: { id: intentId },
        select: submissionIntentSelect,
      });
      if (!current || current.createdById !== principalId) throw notFoundProblem("Submission intent");
      if (current.revision !== expectedRevision) throw revisionConflictProblem();
      if (current.status !== "pending") {
        throw submissionIntentStateConflictProblem(
          `The SubmissionIntent cannot be cancelled while it is ${current.status}`,
        );
      }
      await tx.submissionIntent.update({
        where: { id: intentId },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          revision: { increment: 1 },
        },
      });
    });
  }

  private async claimForSubmission(
    principalId: string,
    visible: SubmissionIntentRecord,
  ): Promise<SubmissionClaim> {
    return this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, visible.projectId, principalId, "edit");
      await lockSubmissionIntent(tx, visible.id);
      let current = await tx.submissionIntent.findUnique({
        where: { id: visible.id },
        select: submissionIntentSelect,
      });
      if (!current || current.createdById !== principalId) throw notFoundProblem("Submission intent");
      if (current.status === "submitted") {
        if (!current.runId) throw new Error("Submitted SubmissionIntent is missing its Run");
        return { kind: "submitted", runId: current.runId };
      }
      if (current.status === "cancelled") {
        throw submissionIntentStateConflictProblem("A cancelled SubmissionIntent cannot be submitted");
      }

      const sourceIds = await this.readySourceIds(tx, current);
      if (current.status === "pending") {
        const claimed = await tx.submissionIntent.updateMany({
          where: { id: current.id, status: "pending", revision: current.revision },
          data: {
            status: "submitting",
            lastFailureCode: null,
            lastFailureDetail: null,
            lastFailureRetryable: null,
            revision: { increment: 1 },
          },
        });
        if (claimed.count !== 1) {
          throw submissionIntentStateConflictProblem("SubmissionIntent claim ownership was lost");
        }
        current = await tx.submissionIntent.findUniqueOrThrow({
          where: { id: current.id },
          select: submissionIntentSelect,
        });
      }

      return {
        kind: "start",
        threadId: current.threadId,
        runIdempotencyKey: current.runIdempotencyKey,
        request: startRunRequestSchema.parse({
          ...submissionIntentRunRequestSchema.parse(current.request),
          sourceIds,
        }),
      };
    });
  }

  private async finalizeSubmission(intentId: string, runId: string): Promise<SubmissionIntent> {
    const row = await this.db.$transaction(async (tx) => {
      await lockSubmissionIntent(tx, intentId);
      let current = await tx.submissionIntent.findUnique({
        where: { id: intentId },
        select: submissionIntentSelect,
      });
      if (!current) throw notFoundProblem("Submission intent");
      if (current.status === "submitted") {
        if (current.runId !== runId) {
          throw submissionIntentStateConflictProblem("SubmissionIntent references a different Run");
        }
        return current;
      }
      if (current.status === "cancelled") {
        throw submissionIntentStateConflictProblem("A cancelled SubmissionIntent cannot reference a Run");
      }
      if (current.status === "pending") {
        await tx.submissionIntent.update({
          where: { id: intentId },
          data: {
            status: "submitting",
            lastFailureCode: null,
            lastFailureDetail: null,
            lastFailureRetryable: null,
            revision: { increment: 1 },
          },
        });
        current = await tx.submissionIntent.findUniqueOrThrow({
          where: { id: intentId },
          select: submissionIntentSelect,
        });
      }
      if (current.status !== "submitting") {
        throw submissionIntentStateConflictProblem(
          `The SubmissionIntent cannot be finalized while it is ${current.status}`,
        );
      }
      return tx.submissionIntent.update({
        where: { id: intentId },
        data: {
          status: "submitted",
          runId,
          submittedAt: new Date(),
          lastFailureCode: null,
          lastFailureDetail: null,
          lastFailureRetryable: null,
          revision: { increment: 1 },
        },
        select: submissionIntentSelect,
      });
    });
    return mapSubmissionIntent(row);
  }

  private async resetAfterStartFailure(
    intentId: string,
    failure: Readonly<{ code: string; message: string; retryable: boolean }>,
  ): Promise<SubmissionIntentRecord | null> {
    return this.db.$transaction(async (tx) => {
      await lockSubmissionIntent(tx, intentId);
      const current = await tx.submissionIntent.findUnique({
        where: { id: intentId },
        select: submissionIntentSelect,
      });
      if (!current) return null;
      if (current.status === "submitted") return current;
      if (current.status !== "submitting") return null;
      return tx.submissionIntent.update({
        where: { id: intentId },
        data: {
          status: "pending",
          lastFailureCode: failure.code,
          lastFailureDetail: failure.message,
          lastFailureRetryable: failure.retryable,
          revision: { increment: 1 },
        },
        select: submissionIntentSelect,
      });
    });
  }

  private async tryResetAfterStartFailure(
    intentId: string,
    failure: Readonly<{ code: string; message: string; retryable: boolean }>,
    originalError: unknown,
  ) {
    try {
      return await this.resetAfterStartFailure(intentId, failure);
    } catch {
      // Preserve the actionable domain error if the recovery write itself is unavailable.
      throw originalError;
    }
  }

  private async submittedReceipt(
    principalId: string,
    intentId: string,
    runId: string,
  ): Promise<SubmitSubmissionIntentResponse> {
    const [intent, run] = await Promise.all([
      this.get(principalId, intentId),
      this.runs.get(principalId, runId),
    ]);
    return submitSubmissionIntentResponseSchema.parse({ intent, run });
  }

  private async readySourceIds(
    tx: Prisma.TransactionClient,
    intent: SubmissionIntentRecord,
  ): Promise<string[]> {
    const request = submissionIntentRunRequestSchema.parse(intent.request);
    const sourceIds = [...request.sourceIds];
    const fileIds: string[] = [];
    for (const [index, attachment] of intent.attachments.entries()) {
      if (attachment.position !== index) {
        throw submissionIntentStateConflictProblem(
          "SubmissionIntent attachment positions are not contiguous",
          "SUBMISSION_INTENT_ATTACHMENTS_INVALID",
        );
      }
      if (!attachment.fileAssetId) {
        throw submissionIntentStateConflictProblem(
          "All SubmissionIntent upload slots must be linked before submission",
          "SUBMISSION_INTENT_ATTACHMENTS_INCOMPLETE",
        );
      }
      fileIds.push(attachment.fileAssetId);
    }
    for (const [position, fileAssetId] of fileIds.entries()) {
      sourceIds.push(await this.importSources.materializeSubmissionFileSource(tx, {
        principalId: intent.createdById,
        projectId: intent.projectId,
        submissionIntentId: intent.id,
        position,
        fileAssetId,
      }));
    }
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw submissionIntentStateConflictProblem(
        "SubmissionIntent sources must be unique",
        "SUBMISSION_INTENT_SOURCES_INVALID",
      );
    }
    return sourceIds;
  }

  private async assertExistingAttachmentsReady(
    tx: Prisma.TransactionClient,
    projectId: string,
    request: CreateSubmissionIntentRequest,
  ) {
    const ids = request.attachments.flatMap((attachment) => (
      attachment.kind === "existing" ? [attachment.fileAssetId] : []
    ));
    if (ids.length === 0) return;
    const files = await tx.$queryRaw<LockedFile[]>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "file_assets"
      WHERE "project_id" = ${projectId}
        AND "id" IN (${Prisma.join([...ids].sort())})
      ORDER BY "id"
      FOR SHARE
    `);
    const byId = new Map(files.map((file) => [file.id, file.status]));
    if (ids.some((id) => !byId.has(id))) throw notFoundProblem("File");
    if (ids.some((id) => byId.get(id) !== "ready")) {
      throw submissionIntentStateConflictProblem(
        "Existing SubmissionIntent attachments must be ready",
        "SUBMISSION_INTENT_ATTACHMENTS_NOT_READY",
      );
    }
  }

  private async requireOwnedIntent(
    principalId: string,
    intentId: string,
    capability: ProjectCapability,
  ): Promise<SubmissionIntentRecord> {
    const intent = await this.db.submissionIntent.findFirst({
      where: {
        id: intentId,
        createdById: principalId,
        project: {
          status: "active",
          members: projectMembershipFilter(principalId, capability),
        },
      },
      select: submissionIntentSelect,
    });
    if (!intent) throw notFoundProblem("Submission intent");
    return intent;
  }

  private resolveCreateReplay(
    intent: SubmissionIntentRecord,
    principalId: string,
    requestHash: string,
  ): SubmissionIntent {
    this.assertCreateReplay(intent, principalId, requestHash);
    return mapSubmissionIntent(intent);
  }

  private assertCreateReplay(
    intent: SubmissionIntentRecord,
    principalId: string,
    requestHash: string,
  ) {
    if (intent.createdById !== principalId) throw idempotencyConflictProblem();
    if (intent.requestHash !== requestHash) throw idempotencyConflictProblem();
  }
}

async function lockSubmissionIntent(tx: Prisma.TransactionClient, intentId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "submission_intents" WHERE "id" = ${intentId} FOR UPDATE
  `);
}

function boundedFailure(error: unknown) {
  let code = "RUN_START_FAILED";
  let message = "The Run could not be started";
  let retryable = true;
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (response && typeof response === "object") {
      const body = response as Record<string, unknown>;
      if (typeof body.code === "string" && body.code.trim()) code = body.code;
      if (typeof body.detail === "string" && body.detail.trim()) message = body.detail;
    } else if (typeof response === "string" && response.trim()) {
      message = response;
    }
    const status = error.getStatus();
    retryable = status === 409 || status === 429 || status >= 500;
  }
  return {
    code: code.slice(0, 120),
    message: message.slice(0, 2_000),
    retryable,
  };
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
