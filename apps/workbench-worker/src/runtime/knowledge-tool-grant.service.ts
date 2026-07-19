import { randomUUID } from "node:crypto";
import {
  knowledgeToolDescriptorSchema,
  type KnowledgeToolDescriptor,
} from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import {
  createKnowledgeToolGrant,
  knowledgeToolGrantPayloadSha256,
  type KnowledgeToolGrantPayload,
} from "@workbench/workbench-knowledge";
import type { WorkerConfig } from "../config.js";

export const knowledgeToolBudgetPolicy = Object.freeze({
  maxSuccessfulCalls: 12,
  maxConcurrentCalls: 2,
  maxStartsPerWindow: 12,
  windowSeconds: 60,
  maxAttemptsPerInvocation: 3,
  maxTotalStarts: 36,
});

export type KnowledgeToolGrantScope = {
  readonly runId: string;
  readonly runtimeAttemptId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly releaseId: string | null;
};

export interface KnowledgeToolGrantIssuer {
  issue(scope: KnowledgeToolGrantScope): Promise<KnowledgeToolDescriptor | null>;
}

export class PrismaKnowledgeToolGrantIssuer implements KnowledgeToolGrantIssuer {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: WorkerConfig["knowledgeTool"],
  ) {}

  async issue(scope: KnowledgeToolGrantScope): Promise<KnowledgeToolDescriptor | null> {
    if (!scope.releaseId) return null;
    if (!this.config) throw new Error("KNOWLEDGE_TOOL_NOT_CONFIGURED");

    const now = floorToSecond(new Date());
    const reusableAfter = new Date(now.getTime() + 60_000);
    const payload = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "knowledge_tool_budgets" (
          "runtime_attempt_id",
          "max_successful_calls",
          "max_concurrent_calls",
          "max_starts_per_window",
          "window_seconds",
          "max_attempts_per_invocation",
          "max_total_starts",
          "window_started_at",
          "window_starts",
          "total_starts",
          "created_at",
          "updated_at"
        ) VALUES (
          ${scope.runtimeAttemptId},
          ${knowledgeToolBudgetPolicy.maxSuccessfulCalls},
          ${knowledgeToolBudgetPolicy.maxConcurrentCalls},
          ${knowledgeToolBudgetPolicy.maxStartsPerWindow},
          ${knowledgeToolBudgetPolicy.windowSeconds},
          ${knowledgeToolBudgetPolicy.maxAttemptsPerInvocation},
          ${knowledgeToolBudgetPolicy.maxTotalStarts},
          ${now},
          0,
          0,
          ${now},
          ${now}
        )
        ON CONFLICT ("runtime_attempt_id") DO NOTHING
      `);
      const [budget] = await tx.$queryRaw<Array<{
        maxSuccessfulCalls: number;
        maxConcurrentCalls: number;
        maxStartsPerWindow: number;
        windowSeconds: number;
        maxAttemptsPerInvocation: number;
        maxTotalStarts: number;
      }>>(Prisma.sql`
        SELECT
          "max_successful_calls" AS "maxSuccessfulCalls",
          "max_concurrent_calls" AS "maxConcurrentCalls",
          "max_starts_per_window" AS "maxStartsPerWindow",
          "window_seconds" AS "windowSeconds",
          "max_attempts_per_invocation" AS "maxAttemptsPerInvocation",
          "max_total_starts" AS "maxTotalStarts"
        FROM "knowledge_tool_budgets"
        WHERE "runtime_attempt_id" = ${scope.runtimeAttemptId}
        FOR UPDATE
      `);
      if (!budget) throw new Error("KNOWLEDGE_TOOL_BUDGET_MISSING");
      assertBudgetPolicy(budget);

      const reusable = await tx.knowledgeToolGrant.findFirst({
        where: {
          runtimeAttemptId: scope.runtimeAttemptId,
          runId: scope.runId,
          principalId: scope.principalId,
          projectId: scope.projectId,
          releaseId: scope.releaseId!,
          revokedAt: null,
          expiresAt: { gt: reusableAfter },
        },
        orderBy: [{ expiresAt: "desc" }, { id: "desc" }],
      });
      if (reusable) {
        const existing = grantPayload(reusable);
        if (knowledgeToolGrantPayloadSha256(existing) !== reusable.payloadSha256) {
          throw new Error("KNOWLEDGE_TOOL_GRANT_LEDGER_INTEGRITY_ERROR");
        }
        return existing;
      }

      const expiresAt = new Date(now.getTime() + this.config!.maximumTtlSeconds * 1_000);
      const created: KnowledgeToolGrantPayload = {
        grantId: randomUUID(),
        runId: scope.runId,
        runtimeAttemptId: scope.runtimeAttemptId,
        principalId: scope.principalId,
        projectId: scope.projectId,
        releaseId: scope.releaseId!,
        mode: "hybrid",
        routeScope: "production",
        issuedAt: now,
        expiresAt,
      };
      await tx.knowledgeToolGrant.create({
        data: {
          id: created.grantId,
          runtimeAttemptId: created.runtimeAttemptId,
          runId: created.runId,
          principalId: created.principalId,
          projectId: created.projectId,
          releaseId: created.releaseId,
          payloadSha256: knowledgeToolGrantPayloadSha256(created),
          issuedAt: created.issuedAt,
          expiresAt: created.expiresAt,
          createdAt: now,
        },
      });
      return created;
    });

    const token = createKnowledgeToolGrant(payload, this.config.secret, {
      now,
      maximumTtlSeconds: this.config.maximumTtlSeconds,
    });
    return knowledgeToolDescriptorSchema.parse({
      protocol: "workbench.knowledge-tool.v1",
      endpoint: this.config.endpoint,
      token,
      expiresAt: payload.expiresAt.toISOString(),
      releaseId: payload.releaseId,
      mode: payload.mode,
      routeScope: payload.routeScope,
    });
  }
}

function assertBudgetPolicy(budget: {
  maxSuccessfulCalls: number;
  maxConcurrentCalls: number;
  maxStartsPerWindow: number;
  windowSeconds: number;
  maxAttemptsPerInvocation: number;
  maxTotalStarts: number;
}) {
  for (const [key, value] of Object.entries(knowledgeToolBudgetPolicy)) {
    if (budget[key as keyof typeof knowledgeToolBudgetPolicy] !== value) {
      throw new Error("KNOWLEDGE_TOOL_BUDGET_POLICY_MISMATCH");
    }
  }
}

function grantPayload(grant: {
  id: string;
  runId: string;
  runtimeAttemptId: string;
  principalId: string;
  projectId: string;
  releaseId: string;
  issuedAt: Date;
  expiresAt: Date;
}): KnowledgeToolGrantPayload {
  return {
    grantId: grant.id,
    runId: grant.runId,
    runtimeAttemptId: grant.runtimeAttemptId,
    principalId: grant.principalId,
    projectId: grant.projectId,
    releaseId: grant.releaseId,
    mode: "hybrid",
    routeScope: "production",
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  };
}

function floorToSecond(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}
