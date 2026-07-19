import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  knowledgeToolResponseSchema,
  type KnowledgeToolResponse,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import {
  knowledgeToolGrantPayloadSha256,
  type KnowledgeToolGrantPayload,
} from "@workbench/workbench-knowledge";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  knowledgeGrantUnauthorizedProblem,
  knowledgeInvocationConflictProblem,
  knowledgeQuotaProblem,
  notFoundProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";

const LEASE_MILLISECONDS = 5 * 60_000;

type GrantLedgerRow = {
  grantId: string;
  runtimeAttemptId: string;
  runId: string;
  principalId: string;
  projectId: string;
  releaseId: string;
  payloadSha256: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  maxSuccessfulCalls: number;
  maxConcurrentCalls: number;
  maxStartsPerWindow: number;
  windowSeconds: number;
  maxAttemptsPerInvocation: number;
  maxTotalStarts: number;
  windowStartedAt: Date;
  windowStarts: number;
  totalStarts: number;
  runStatus: string;
  runAttempt: number;
  runKnowledgeReleaseId: string | null;
  runCreatedById: string;
  runProjectId: string;
  runThreadId: string;
  attemptStatus: string;
  attemptNumber: number;
  attemptRunId: string;
  threadStatus: string;
  threadProjectId: string;
  projectStatus: string;
  memberPrincipalId: string | null;
  now: Date;
};

export type KnowledgeToolReservation = {
  readonly id: string;
  readonly runtimeAttemptId: string;
  readonly invocationId: string;
  readonly querySha256: string;
  readonly leaseToken: string;
};

export type KnowledgeToolReserveResult =
  | { readonly kind: "reserved"; readonly reservation: KnowledgeToolReservation }
  | { readonly kind: "replay"; readonly response: KnowledgeToolResponse };

@Injectable()
export class KnowledgeToolLedgerService {
  constructor(private readonly db: WorkbenchDbService) {}

  async reserve(
    grant: KnowledgeToolGrantPayload,
    invocationId: string | undefined,
    query: string,
  ): Promise<KnowledgeToolReserveResult> {
    validateIdempotencyKey(invocationId ?? "");
    const stableInvocationId = invocationId!;
    const querySha256 = queryHash(query);

    return this.db.$transaction(async (tx) => {
      const scope = await this.lockGrant(tx, grant, true);
      if (!scope.dynamicScopeValid) throw notFoundProblem("Knowledge capability scope");
      const { row } = scope;

      await tx.knowledgeRetrievalInvocation.updateMany({
        where: {
          runtimeAttemptId: grant.runtimeAttemptId,
          status: "in_flight",
          leaseExpiresAt: { lte: row.now },
        },
        data: {
          status: "abandoned",
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: "KNOWLEDGE_INVOCATION_LEASE_EXPIRED",
          finishedAt: row.now,
          updatedAt: row.now,
        },
      });

      const existing = await tx.knowledgeRetrievalInvocation.findUnique({
        where: {
          runtimeAttemptId_invocationId: {
            runtimeAttemptId: grant.runtimeAttemptId,
            invocationId: stableInvocationId,
          },
        },
      });
      if (existing && existing.querySha256 !== querySha256) throw idempotencyConflictProblem();
      if (existing?.status === "succeeded") {
        return {
          kind: "replay" as const,
          response: knowledgeToolResponseSchema.parse(existing.response),
        };
      }
      if (existing?.status === "in_flight") {
        throw knowledgeInvocationConflictProblem(
          "KNOWLEDGE_INVOCATION_IN_PROGRESS",
          "The Knowledge invocation is already in progress",
        );
      }
      if (existing?.status === "discarded") {
        throw notFoundProblem("Knowledge capability scope");
      }
      if (existing && existing.attemptCount >= row.maxAttemptsPerInvocation) {
        throw knowledgeQuotaProblem(
          "KNOWLEDGE_INVOCATION_RETRY_EXHAUSTED",
          "The Knowledge invocation retry budget is exhausted",
        );
      }

      const successfulCalls = await tx.knowledgeRetrievalInvocation.count({
        where: { runtimeAttemptId: grant.runtimeAttemptId, status: "succeeded" },
      });
      if (successfulCalls >= row.maxSuccessfulCalls) {
        throw knowledgeQuotaProblem(
          "KNOWLEDGE_SUCCESS_QUOTA_EXHAUSTED",
          "The Runtime attempt Knowledge retrieval quota is exhausted",
        );
      }
      const activeCalls = await tx.knowledgeRetrievalInvocation.count({
        where: { runtimeAttemptId: grant.runtimeAttemptId, status: "in_flight" },
      });
      if (activeCalls >= row.maxConcurrentCalls) {
        throw knowledgeQuotaProblem(
          "KNOWLEDGE_CONCURRENCY_LIMIT_REACHED",
          "The Runtime attempt has too many concurrent Knowledge invocations",
        );
      }
      if (row.totalStarts >= row.maxTotalStarts) {
        throw knowledgeQuotaProblem(
          "KNOWLEDGE_TOTAL_START_LIMIT_REACHED",
          "The Runtime attempt Knowledge provider start budget is exhausted",
        );
      }

      const resetWindow = row.now.getTime() - row.windowStartedAt.getTime() >= row.windowSeconds * 1_000;
      const currentWindowStarts = resetWindow ? 0 : row.windowStarts;
      if (currentWindowStarts >= row.maxStartsPerWindow) {
        throw knowledgeQuotaProblem(
          "KNOWLEDGE_START_RATE_LIMIT_REACHED",
          "The Runtime attempt Knowledge retrieval rate limit is reached",
        );
      }

      await tx.knowledgeToolBudget.update({
        where: { runtimeAttemptId: grant.runtimeAttemptId },
        data: {
          ...(resetWindow ? { windowStartedAt: row.now, windowStarts: 1 } : { windowStarts: { increment: 1 } }),
          totalStarts: { increment: 1 },
          updatedAt: row.now,
        },
      });

      const leaseToken = randomBytes(32).toString("base64url");
      const receiptStartedAt = existing && row.now.getTime() <= existing.lastStartedAt.getTime()
        ? new Date(existing.lastStartedAt.getTime() + 1)
        : row.now;
      const leaseExpiresAt = new Date(receiptStartedAt.getTime() + LEASE_MILLISECONDS);
      const receipt = existing
        ? await tx.knowledgeRetrievalInvocation.update({
            where: { id: existing.id },
            data: {
              lastGrantId: grant.grantId,
              status: "in_flight",
              attemptCount: { increment: 1 },
              leaseToken,
              leaseExpiresAt,
              response: Prisma.DbNull,
              responseSha256: null,
              lastErrorCode: null,
              lastStartedAt: receiptStartedAt,
              finishedAt: null,
              updatedAt: row.now,
            },
          })
        : await tx.knowledgeRetrievalInvocation.create({
            data: {
              id: randomUUID(),
              runtimeAttemptId: grant.runtimeAttemptId,
              invocationId: stableInvocationId,
              lastGrantId: grant.grantId,
              querySha256,
              status: "in_flight",
              attemptCount: 1,
              leaseToken,
              leaseExpiresAt,
              lastStartedAt: receiptStartedAt,
              createdAt: row.now,
              updatedAt: row.now,
            },
          });

      return {
        kind: "reserved" as const,
        reservation: {
          id: receipt.id,
          runtimeAttemptId: receipt.runtimeAttemptId,
          invocationId: receipt.invocationId,
          querySha256,
          leaseToken,
        },
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
  }

  async commit(
    grant: KnowledgeToolGrantPayload,
    reservation: KnowledgeToolReservation,
    response: KnowledgeToolResponse,
  ): Promise<KnowledgeToolResponse> {
    const canonicalResponse = knowledgeToolResponseSchema.parse(response);
    const settled = await this.db.$transaction(async (tx) => {
      const scope = await this.lockGrant(tx, grant, false);
      if (!scope.dynamicScopeValid) {
        await tx.knowledgeRetrievalInvocation.updateMany({
          where: {
            id: reservation.id,
            runtimeAttemptId: reservation.runtimeAttemptId,
            status: "in_flight",
            leaseToken: reservation.leaseToken,
          },
          data: {
            status: "discarded",
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: "KNOWLEDGE_CAPABILITY_SCOPE_REVOKED",
            finishedAt: scope.row.now,
            updatedAt: scope.row.now,
          },
        });
        return { kind: "discarded" as const };
      }

      const updated = await tx.knowledgeRetrievalInvocation.updateMany({
        where: {
          id: reservation.id,
          runtimeAttemptId: reservation.runtimeAttemptId,
          querySha256: reservation.querySha256,
          status: "in_flight",
          leaseToken: reservation.leaseToken,
          leaseExpiresAt: { gt: scope.row.now },
        },
        data: {
          status: "succeeded",
          leaseToken: null,
          leaseExpiresAt: null,
          response: canonicalResponse as Prisma.InputJsonValue,
          responseSha256: hashRequest(canonicalResponse),
          finishedAt: scope.row.now,
          updatedAt: scope.row.now,
        },
      });
      if (updated.count === 1) return { kind: "response" as const, response: canonicalResponse };

      const current = await tx.knowledgeRetrievalInvocation.findUnique({ where: { id: reservation.id } });
      if (current?.status === "succeeded" && current.querySha256 === reservation.querySha256) {
        return {
          kind: "response" as const,
          response: knowledgeToolResponseSchema.parse(current.response),
        };
      }
      throw knowledgeInvocationConflictProblem(
        "KNOWLEDGE_INVOCATION_LEASE_LOST",
        "The Knowledge invocation reservation is no longer active",
      );
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });

    if (settled.kind === "discarded") throw notFoundProblem("Knowledge capability scope");
    return settled.response;
  }

  async release(reservation: KnowledgeToolReservation, errorCode: string): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE public."knowledge_retrieval_invocations"
      SET
        "status" = 'failed',
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "last_error_code" = ${safeErrorCode(errorCode)},
        "finished_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
      WHERE "id" = ${reservation.id}
        AND "runtime_attempt_id" = ${reservation.runtimeAttemptId}
        AND "status" = 'in_flight'
        AND "lease_token" = ${reservation.leaseToken}
    `);
  }

  private async lockGrant(
    tx: Prisma.TransactionClient,
    grant: KnowledgeToolGrantPayload,
    requireUnexpired: boolean,
  ): Promise<{ row: GrantLedgerRow; dynamicScopeValid: boolean }> {
    const rows = await tx.$queryRaw<GrantLedgerRow[]>(Prisma.sql`
      SELECT
        capability."id" AS "grantId",
        capability."runtime_attempt_id" AS "runtimeAttemptId",
        capability."run_id" AS "runId",
        capability."principal_id" AS "principalId",
        capability."project_id" AS "projectId",
        capability."release_id" AS "releaseId",
        capability."payload_sha256" AS "payloadSha256",
        capability."issued_at" AS "issuedAt",
        capability."expires_at" AS "expiresAt",
        capability."revoked_at" AS "revokedAt",
        budget."max_successful_calls" AS "maxSuccessfulCalls",
        budget."max_concurrent_calls" AS "maxConcurrentCalls",
        budget."max_starts_per_window" AS "maxStartsPerWindow",
        budget."window_seconds" AS "windowSeconds",
        budget."max_attempts_per_invocation" AS "maxAttemptsPerInvocation",
        budget."max_total_starts" AS "maxTotalStarts",
        budget."window_started_at" AS "windowStartedAt",
        budget."window_starts" AS "windowStarts",
        budget."total_starts" AS "totalStarts",
        run."status"::TEXT AS "runStatus",
        run."attempt" AS "runAttempt",
        run."knowledge_release_id" AS "runKnowledgeReleaseId",
        run."created_by_id" AS "runCreatedById",
        run."project_id" AS "runProjectId",
        run."thread_id" AS "runThreadId",
        attempt."status"::TEXT AS "attemptStatus",
        attempt."attempt" AS "attemptNumber",
        attempt."run_id" AS "attemptRunId",
        thread."status"::TEXT AS "threadStatus",
        thread."project_id" AS "threadProjectId",
        project."status"::TEXT AS "projectStatus",
        NULL::TEXT AS "memberPrincipalId",
        clock_timestamp() AS "now"
      FROM public."knowledge_tool_grants" AS capability
      JOIN public."knowledge_tool_budgets" AS budget
        ON budget."runtime_attempt_id" = capability."runtime_attempt_id"
      JOIN public."runtime_attempts" AS attempt
        ON attempt."id" = capability."runtime_attempt_id"
      JOIN public."runs" AS run ON run."id" = capability."run_id"
      JOIN public."threads" AS thread ON thread."id" = run."thread_id"
      JOIN public."projects" AS project ON project."id" = run."project_id"
      WHERE capability."id" = ${grant.grantId}
      FOR UPDATE OF budget
      FOR SHARE OF capability, attempt, run, thread, project
    `);
    const row = rows[0];
    if (!row || !ledgerIdentityMatches(row, grant)) throw knowledgeGrantUnauthorizedProblem();
    const members = await tx.$queryRaw<Array<{ principalId: string }>>(Prisma.sql`
      SELECT "principal_id" AS "principalId"
      FROM public."project_members"
      WHERE "project_id" = ${grant.projectId}
        AND "principal_id" = ${grant.principalId}
      FOR SHARE
    `);
    row.memberPrincipalId = members[0]?.principalId ?? null;
    if (requireUnexpired && row.expiresAt.getTime() <= row.now.getTime()) {
      throw knowledgeGrantUnauthorizedProblem();
    }
    return { row, dynamicScopeValid: dynamicScopeMatches(row, grant) };
  }
}

function ledgerIdentityMatches(row: GrantLedgerRow, grant: KnowledgeToolGrantPayload): boolean {
  return row.grantId === grant.grantId
    && row.runtimeAttemptId === grant.runtimeAttemptId
    && row.runId === grant.runId
    && row.principalId === grant.principalId
    && row.projectId === grant.projectId
    && row.releaseId === grant.releaseId
    && row.issuedAt.getTime() === grant.issuedAt.getTime()
    && row.expiresAt.getTime() === grant.expiresAt.getTime()
    && row.payloadSha256 === knowledgeToolGrantPayloadSha256(grant);
}

function dynamicScopeMatches(row: GrantLedgerRow, grant: KnowledgeToolGrantPayload): boolean {
  return row.revokedAt === null
    && row.runStatus === "running"
    && (row.attemptStatus === "submitting" || row.attemptStatus === "running")
    && row.runAttempt === row.attemptNumber
    && row.attemptRunId === grant.runId
    && row.runKnowledgeReleaseId === grant.releaseId
    && row.runCreatedById === grant.principalId
    && row.runProjectId === grant.projectId
    && row.threadStatus === "active"
    && row.threadProjectId === grant.projectId
    && row.runThreadId.length > 0
    && row.projectStatus === "active"
    && row.memberPrincipalId === grant.principalId;
}

function queryHash(query: string): string {
  return createHash("sha256").update(query.normalize("NFC"), "utf8").digest("hex");
}

function safeErrorCode(value: string): string {
  const normalized = value.trim().slice(0, 128);
  return normalized || "KNOWLEDGE_RETRIEVAL_FAILED";
}
