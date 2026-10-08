import { verifyKnowledgeToolGrant } from "@workbench/workbench-knowledge";
import {
  knowledgeToolBudgetPolicy,
  PrismaKnowledgeToolGrantIssuer,
  type KnowledgeToolGrantScope,
} from "../src/runtime/knowledge-tool-grant.service.js";

const now = new Date("2026-07-14T12:00:00.000Z");
const secret = Buffer.alloc(32, 29);
const config = {
  endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
  secret,
  maximumTtlSeconds: 900,
};
const scope: KnowledgeToolGrantScope = {
  runId: "run_1",
  runtimeAttemptId: "runtime_attempt_1",
  principalId: "principal_1",
  projectId: "project_1",
  releaseId: "release_1",
};

function issuerHarness() {
  let budget: null | (typeof knowledgeToolBudgetPolicy & {
    windowStarts: number;
    totalStarts: number;
  }) = null;
  let budgetCreationCount = 0;
  const grants: Array<Record<string, unknown>> = [];
  const tx = {
    knowledgeToolBudget: { createMany: vi.fn(async () => {
      if (!budget) {
        budget = {
          ...knowledgeToolBudgetPolicy,
          windowStarts: 0,
          totalStarts: 0,
        };
        budgetCreationCount += 1;
      }
      return { count: 1 };
    }) },
    $queryRaw: vi.fn(async () => budget ? [budget] : []),
    knowledgeToolGrant: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const threshold = (where.expiresAt as { gt: Date }).gt;
        return grants
          .filter((grant) => (
            grant.runtimeAttemptId === where.runtimeAttemptId
            && grant.runId === where.runId
            && grant.principalId === where.principalId
            && grant.projectId === where.projectId
            && grant.releaseId === where.releaseId
            && grant.revokedAt === null
            && (grant.expiresAt as Date) > threshold
          ))
          .sort((left, right) => (right.expiresAt as Date).getTime() - (left.expiresAt as Date).getTime())[0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, revokedAt: null };
        grants.push(row);
        return row;
      }),
    },
  };
  const db = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  return {
    budget: () => budget,
    budgetCreationCount: () => budgetCreationCount,
    db,
    grants,
    issuer: new PrismaKnowledgeToolGrantIssuer(db as never, config),
    tx,
  };
}

describe("PrismaKnowledgeToolGrantIssuer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates one immutable budget and reuses an active grant for the same RuntimeAttempt", async () => {
    const harness = issuerHarness();

    const first = await harness.issuer.issue(scope);
    const replay = await harness.issuer.issue(scope);

    expect(first).not.toBeNull();
    expect(replay).toEqual(first);
    expect(harness.budgetCreationCount()).toBe(1);
    expect(harness.tx.knowledgeToolBudget.createMany).toHaveBeenCalledWith({
      data: {
        runtimeAttemptId: scope.runtimeAttemptId,
        ...knowledgeToolBudgetPolicy,
        windowStartedAt: now,
        windowStarts: 0,
        totalStarts: 0,
        createdAt: now,
        updatedAt: now,
      },
      skipDuplicates: true,
    });
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(harness.tx.knowledgeToolGrant.create).toHaveBeenCalledTimes(1);
    expect(harness.grants).toHaveLength(1);
    expect(JSON.stringify(harness.grants)).not.toContain("wbkg1.");
    expect(verifyKnowledgeToolGrant(first!.token, secret, { now })).toMatchObject({
      runId: scope.runId,
      runtimeAttemptId: scope.runtimeAttemptId,
      principalId: scope.principalId,
      projectId: scope.projectId,
      releaseId: scope.releaseId,
    });
  });

  it("issues a replacement grant without resetting the RuntimeAttempt budget", async () => {
    const harness = issuerHarness();
    await harness.issuer.issue(scope);
    const budget = harness.budget()!;
    budget.windowStarts = 5;
    budget.totalStarts = 8;
    harness.grants[0]!.revokedAt = now;

    const replacement = await harness.issuer.issue(scope);

    expect(replacement).not.toBeNull();
    expect(harness.tx.knowledgeToolGrant.create).toHaveBeenCalledTimes(2);
    expect(harness.budget()).toBe(budget);
    expect(harness.budget()).toMatchObject({ windowStarts: 5, totalStarts: 8 });
    expect(harness.budgetCreationCount()).toBe(1);
  });

  it("fails closed for a pinned release when Knowledge tool configuration is absent", async () => {
    const db = { $transaction: vi.fn() };
    const issuer = new PrismaKnowledgeToolGrantIssuer(db as never, null);

    await expect(issuer.issue(scope)).rejects.toThrow("KNOWLEDGE_TOOL_NOT_CONFIGURED");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("does not create a capability when the Run has no pinned Knowledge release", async () => {
    const db = { $transaction: vi.fn() };
    const issuer = new PrismaKnowledgeToolGrantIssuer(db as never, null);

    await expect(issuer.issue({ ...scope, releaseId: null })).rejects.toThrow("KNOWLEDGE_RELEASE_REQUIRED");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
