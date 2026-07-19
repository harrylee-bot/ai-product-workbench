import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import {
  canonicalSha256,
  createKnowledgeToolGrant,
  knowledgeToolGrantPayloadSha256,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
  type EmbeddingProfileV1,
  type JsonValue,
  type RetrievalProfileV1,
} from "@workbench/workbench-knowledge";
import { describe, expect, it } from "vitest";
import { AccessService } from "../src/modules/access/access.service.js";
import { KnowledgeRetrievalService } from "../src/modules/knowledge/knowledge-retrieval.service.js";
import { KnowledgeRetrievalConfig } from "../src/modules/knowledge/knowledge-retrieval.config.js";
import { KnowledgeToolService } from "../src/modules/knowledge/knowledge-tool.service.js";
import { KnowledgeToolLedgerService } from "../src/modules/knowledge/knowledge-tool-ledger.service.js";
import { JiebaQuerySegmenterAdapter } from "../src/modules/knowledge/jieba-query-segmenter.adapter.js";
import { PrismaKnowledgeRetrievalStore } from "../src/modules/knowledge/prisma-knowledge-retrieval.store.js";

const databaseUrl =
  process.env.WORKBENCH_KNOWLEDGE_RETRIEVAL_TEST_DATABASE_URL ??
  process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Knowledge retrieval PostgreSQL boundaries", () => {
  it("works with an isolated workbench search_path and enforces all retrieval boundaries", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const rollback = new Error("ROLLBACK_KNOWLEDGE_RETRIEVAL_POSTGRES_TEST");
    let verified = false;
    try {
      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL search_path TO "workbench"');
          const fixture = await seedFixture(tx);
          const access = new AccessService(tx as never);
          const store = new PrismaKnowledgeRetrievalStore(tx as never);
          const service = new KnowledgeRetrievalService(access, store, {
            segmenter: {
              identity: segmenterIdentity,
              segment: (text) => text.split(/\s+/u),
            },
            queryEmbedding: {
              async embedQuery() {
                return [1, 0, 0];
              },
            },
            reranker: {
              identity: {
                id: "integration/reranker",
                revision: "commit-reranker-r1",
              },
              async rerank() {
                throw new Error("simulated reranker outage");
              },
            },
          });

          const result = await service.retrieve({
            principalId: fixture.ownerId,
            projectId: fixture.projectId,
            releaseId: fixture.releaseId,
            query: "产品 工作台",
            mode: "hybrid",
            routeScope: "production",
          });
          expect(result.evidence).toMatchObject({
            degraded: true,
            candidateCounts: { lexical: 1, dense: 2, fused: 2 },
            reranker: {
              status: "degraded",
              id: "integration/reranker",
              revision: "commit-reranker-r1",
              reason: "RERANKER_REQUEST_FAILED",
            },
          });
          expect(result.items.map((item) => item.citation.chunkId)).toEqual([
            fixture.productionChunkId,
            fixture.secondaryChunkId,
          ]);
          expect(
            result.items.every((item) => item.citation.route === "production"),
          ).toBe(true);

          await expect(
            service.retrieve({
              principalId: fixture.outsiderId,
              projectId: fixture.projectId,
              releaseId: fixture.releaseId,
              query: "产品 工作台",
              mode: "lexical",
              routeScope: "production",
            }),
          ).rejects.toMatchObject({ status: 404 });

          await expect(
            service.retrieve({
              principalId: fixture.outsiderId,
              projectId: fixture.outsiderProjectId,
              releaseId: fixture.releaseId,
              query: "产品 工作台",
              mode: "lexical",
              routeScope: "production",
            }),
          ).rejects.toMatchObject({ status: 404 });

          const sourceLookup = await service.retrieve({
            principalId: fixture.ownerId,
            projectId: fixture.projectId,
            releaseId: fixture.releaseId,
            query: "内部 来源",
            mode: "lexical",
            routeScope: "source_lookup",
          });
          expect(
            sourceLookup.items.some(
              (item) => item.citation.chunkId === fixture.sourceLookupChunkId,
            ),
          ).toBe(true);

          const wrongPin = await store.denseCandidates({
            releaseId: fixture.releaseId,
            profileId: fixture.profileId,
            profileSpecSha256: "f".repeat(64),
            dimension: 3,
            routes: ["production"],
            vector: [1, 0, 0],
            limit: 40,
          });
          expect(wrongPin).toEqual([]);

          const wrongDimension = new KnowledgeRetrievalService(access, store, {
            segmenter: {
              identity: segmenterIdentity,
              segment: (text) => text.split(/\s+/u),
            },
            queryEmbedding: {
              async embedQuery() {
                return [1, 0];
              },
            },
            reranker: {
              identity: {
                id: "integration/reranker",
                revision: "commit-reranker-r1",
              },
              async rerank() {
                return [];
              },
            },
          });
          await expect(
            wrongDimension.retrieve({
              principalId: fixture.ownerId,
              projectId: fixture.projectId,
              releaseId: fixture.releaseId,
              query: "产品 工作台",
              mode: "hybrid",
              routeScope: "production",
            }),
          ).rejects.toMatchObject({
            code: "KNOWLEDGE_QUERY_EMBEDDING_INVALID",
          });

          await tx.$executeRawUnsafe("SAVEPOINT knowledge_pin_drift");
          await expect(
            tx.$executeRaw(Prisma.sql`
          UPDATE public."knowledge_releases"
          SET "embedding_dimension" = 4
          WHERE "id" = ${fixture.releaseId}
        `),
          ).rejects.toThrow();
          await tx.$executeRawUnsafe(
            "ROLLBACK TO SAVEPOINT knowledge_pin_drift",
          );

          const pin = await tx.knowledgeRelease.findUniqueOrThrow({
            where: { id: fixture.releaseId },
          });
          expect(pin).toMatchObject({
            status: "ready",
            embeddingProfileId: fixture.profileId,
            embeddingProfileSpecSha256: fixture.profileSpecSha256,
            embeddingDimension: 3,
          });
          verified = true;
          throw rollback;
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$disconnect();
    }
    expect(verified).toBe(true);
  });

  it("serves an authorized signed Run capability through the production provider and citation boundary", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const rollback = new Error("ROLLBACK_KNOWLEDGE_TOOL_POSTGRES_TEST");
    const secret = Buffer.alloc(32, 29);
    let verified = false;
    let rerankerUnavailable = false;
    let embeddingUnavailable = false;
    const providerRequest = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === "embedding.test") {
          if (embeddingUnavailable) {
            return Response.json(
              {
                detail: "private embedding provider failure",
                secret: "must-not-leak",
              },
              { status: 503 },
            );
          }
          if (url.pathname === "/info")
            return Response.json(embeddingRuntimeInfo());
          if (url.pathname === "/tokenize")
            return Response.json([[{ id: 1 }, { id: 2 }]]);
          if (url.pathname === "/embed") {
            expect(JSON.parse(String(init?.body))).toMatchObject({
              normalize: true,
              truncate: false,
              dimensions: 3,
            });
            return Response.json([[1, 0, 0]]);
          }
        }
        if (url.hostname === "reranker.test") {
          if (rerankerUnavailable) {
            return Response.json(
              {
                detail: "private reranker provider failure",
                secret: "must-not-leak",
              },
              { status: 503 },
            );
          }
          if (url.pathname === "/info")
            return Response.json(rerankerRuntimeInfo());
          if (url.pathname === "/rerank") {
            const body = JSON.parse(String(init?.body)) as {
              texts: string[];
              truncate: boolean;
            };
            expect(body.truncate).toBe(false);
            return Response.json(
              body.texts.map((_, index) => ({ index, score: 1 - index / 10 })),
            );
          }
        }
        throw new Error(`Unexpected Knowledge provider request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", providerRequest);
    try {
      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL search_path TO "workbench"');
          const fixture = await seedFixture(tx);
          const runtime = await seedRuntimeFixture(tx, fixture);
          const config = new KnowledgeRetrievalConfig(
            new ConfigService({
              WORKBENCH_KNOWLEDGE_TOOL_SECRET: secret.toString("base64url"),
              WORKBENCH_KNOWLEDGE_TOOL_MAX_TTL_SECONDS: "600",
              WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: fixture.profileId,
              WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256:
                fixture.profileSpecSha256,
              WORKBENCH_TEI_URL: "https://embedding.test",
              WORKBENCH_TEI_IMAGE_DIGEST: `sha256:${"1".repeat(64)}`,
              WORKBENCH_KNOWLEDGE_RERANKER_URL: "https://reranker.test",
              WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST: `sha256:${"7".repeat(64)}`,
              WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID: "integration/reranker",
              WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION: "commit-reranker-r1",
              WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION: "1.8.3",
              WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS: "512",
            }),
          );
          const transactionalDb = transactionFacade(tx);
          const ledger = new KnowledgeToolLedgerService(
            transactionalDb as never,
          );
          const tool = new KnowledgeToolService(
            config,
            new AccessService(tx as never),
            tx as never,
            ledger,
          );
          const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
          const grantPayload = {
            grantId: `grant_${runtime.runId}`,
            runId: runtime.runId,
            runtimeAttemptId: runtime.runtimeAttemptId,
            principalId: fixture.ownerId,
            projectId: fixture.projectId,
            releaseId: fixture.releaseId,
            mode: "hybrid",
            routeScope: "production",
            issuedAt: now,
            expiresAt: new Date(now.getTime() + 5 * 60_000),
          } as const;
          await registerGrantLedger(tx, grantPayload);
          const grant = createKnowledgeToolGrant(grantPayload, secret, {
            now,
            maximumTtlSeconds: 600,
          });
          const request = {
            protocol: "workbench.knowledge-retrieval-request.v1" as const,
            query: "产品工作台",
          };

          const result = await tool.retrieve(
            `Bearer ${grant}`,
            invocationKey("success"),
            request,
          );
          expect(result).toMatchObject({
            protocol: "workbench.knowledge-retrieval-result.v1",
            evidence: {
              mode: "hybrid",
              routeScope: "production",
              release: { id: fixture.releaseId },
              embeddingProfile: {
                id: fixture.profileId,
                specSha256: fixture.profileSpecSha256,
                dimension: 3,
              },
              retrievalProfile: {
                id: fixture.retrievalProfileId,
                specSha256: fixture.retrievalProfileSpecSha256,
              },
              candidateCounts: { lexical: 1, dense: 2, fused: 2 },
              fusion: { algorithm: "rrf", k: 60 },
              reranker: {
                status: "applied",
                id: "integration/reranker",
                revision: "commit-reranker-r1",
              },
              degraded: false,
            },
          });
          expect(result.items.map((item) => item.citation.chunkId)).toEqual([
            fixture.productionChunkId,
            fixture.secondaryChunkId,
          ]);
          expect(
            result.items.every(
              (item) =>
                item.citation.id.startsWith("knowledge_") &&
                item.citation.locator.startLine === null &&
                item.citation.locator.endLine === null,
            ),
          ).toBe(true);

          const callsBeforeUnauthorized = providerRequest.mock.calls.length;
          const outsiderGrant = createKnowledgeToolGrant(
            {
              grantId: `outsider_${runtime.runId}`,
              runId: runtime.runId,
              runtimeAttemptId: runtime.runtimeAttemptId,
              principalId: fixture.outsiderId,
              projectId: fixture.projectId,
              releaseId: fixture.releaseId,
              mode: "hybrid",
              routeScope: "production",
              issuedAt: now,
              expiresAt: new Date(now.getTime() + 5 * 60_000),
            },
            secret,
            { now, maximumTtlSeconds: 600 },
          );
          await expect(
            tool.retrieve(
              `Bearer ${outsiderGrant}`,
              invocationKey("outsider"),
              request,
            ),
          ).rejects.toMatchObject({ status: 401 });
          await expect(
            tool.retrieve(
              `Bearer ${grant.slice(0, -1)}x`,
              invocationKey("tampered"),
              request,
            ),
          ).rejects.toMatchObject({ status: 401 });
          expect(providerRequest).toHaveBeenCalledTimes(
            callsBeforeUnauthorized,
          );

          rerankerUnavailable = true;
          const degraded = await tool.retrieve(
            `Bearer ${grant}`,
            invocationKey("degraded"),
            request,
          );
          expect(degraded.evidence).toMatchObject({
            degraded: true,
            reranker: { status: "degraded", reason: "RERANKER_REQUEST_FAILED" },
          });
          expect(JSON.stringify(degraded)).not.toContain(
            "private reranker provider failure",
          );
          expect(JSON.stringify(degraded)).not.toContain("must-not-leak");

          rerankerUnavailable = false;
          embeddingUnavailable = true;
          const failure = (await tool
            .retrieve(
              `Bearer ${grant}`,
              invocationKey("embedding-failure"),
              request,
            )
            .catch((error: unknown) => error)) as {
            status: number;
            getResponse(): unknown;
          };
          expect(failure.status).toBe(503);
          expect(failure.getResponse()).toMatchObject({
            code: "KNOWLEDGE_QUERY_EMBEDDING_FAILED",
            detail: "Hybrid Knowledge retrieval is temporarily unavailable",
          });
          expect(JSON.stringify(failure.getResponse())).not.toContain(
            "private embedding provider failure",
          );
          expect(JSON.stringify(failure.getResponse())).not.toContain(
            "must-not-leak",
          );

          verified = true;
          throw rollback;
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      vi.unstubAllGlobals();
      await db.$disconnect();
    }
    expect(verified).toBe(true);
  });

  it("settles a failed receipt with the database clock when the API clock is behind", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const fixture = await db.$transaction((tx) => seedFixture(tx), {
        timeout: 60_000,
      });
      const harness = await createLedgerHarness(
        db,
        fixture,
        "release-database-clock",
      );
      const reservation = reserved(
        await harness.ledger.reserve(
          harness.grant,
          invocationKey("release-database-clock"),
          "database clock query",
        ),
      );

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
      await expect(
        harness.ledger.release(reservation, "TEST_DATABASE_CLOCK"),
      ).resolves.toBeUndefined();
      const receipt = await db.knowledgeRetrievalInvocation.findUniqueOrThrow({
        where: { id: reservation.id },
      });
      expect(receipt).toMatchObject({
        status: "failed",
        lastErrorCode: "TEST_DATABASE_CLOCK",
      });
      expect(receipt.finishedAt!.getTime()).toBeGreaterThanOrEqual(
        receipt.lastStartedAt.getTime(),
      );
      expect(receipt.finishedAt!.getUTCFullYear()).toBeGreaterThan(2000);
    } finally {
      vi.useRealTimers();
      await db.$disconnect();
    }
  });

  it("authorizes submitting tool calls after the POST fence and rejects pending attempts", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const fixture = await db.$transaction((tx) => seedFixture(tx), {
        timeout: 60_000,
      });
      const response = ledgerResponse(fixture);
      const submitting = await createLedgerHarness(
        db,
        fixture,
        "submitting-scope",
        0,
        "submitting",
      );
      const submittingReservation = reserved(
        await submitting.ledger.reserve(
          submitting.grant,
          invocationKey("submitting-scope"),
          "submitting query",
        ),
      );
      await expect(
        submitting.ledger.commit(
          submitting.grant,
          submittingReservation,
          response,
        ),
      ).resolves.toEqual(response);

      const pending = await createLedgerHarness(
        db,
        fixture,
        "pending-scope",
        0,
        "pending",
      );
      await expect(
        pending.ledger.reserve(
          pending.grant,
          invocationKey("pending-scope"),
          "pending query",
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        db.knowledgeToolBudget.findUniqueOrThrow({
          where: { runtimeAttemptId: pending.grant.runtimeAttemptId },
        }),
      ).resolves.toMatchObject({ windowStarts: 0, totalStarts: 0 });
    } finally {
      await db.$disconnect();
    }
  });

  it("enforces the durable grant budget, receipt replay, retries, leases, quotas, and membership revocation under PostgreSQL concurrency", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const peer = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const fixture = await db.$transaction((tx) => seedFixture(tx), {
        timeout: 60_000,
      });
      const response = ledgerResponse(fixture);

      const idempotency = await createLedgerHarness(db, fixture, "idempotency");
      const key = invocationKey("durable-replay");
      const first = reserved(
        await idempotency.ledger.reserve(idempotency.grant, key, "same query"),
      );
      await idempotency.ledger.release(first, "KNOWLEDGE_PROVIDER_UNAVAILABLE");
      const retry = reserved(
        await idempotency.ledger.reserve(idempotency.grant, key, "same query"),
      );
      await expect(
        idempotency.ledger.commit(idempotency.grant, retry, response),
      ).resolves.toEqual(response);
      const startsBeforeReplay = await db.knowledgeToolBudget.findUniqueOrThrow(
        {
          where: { runtimeAttemptId: idempotency.grant.runtimeAttemptId },
          select: { totalStarts: true },
        },
      );
      await expect(
        idempotency.ledger.reserve(idempotency.grant, key, "same query"),
      ).resolves.toEqual({
        kind: "replay",
        response,
      });
      await expect(
        idempotency.ledger.reserve(idempotency.grant, key, "different query"),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await db.knowledgeToolBudget.findUniqueOrThrow({
            where: { runtimeAttemptId: idempotency.grant.runtimeAttemptId },
          })
        ).totalStarts,
      ).toBe(startsBeforeReplay.totalStarts);
      expect(
        await db.knowledgeRetrievalInvocation.findUnique({
          where: {
            runtimeAttemptId_invocationId: {
              runtimeAttemptId: idempotency.grant.runtimeAttemptId,
              invocationId: key,
            },
          },
        }),
      ).toMatchObject({ status: "succeeded", attemptCount: 2 });

      const concurrency = await createLedgerHarness(db, fixture, "concurrency");
      const peerLedger = new KnowledgeToolLedgerService(peer as never);
      const active = reserved(
        await concurrency.ledger.reserve(
          concurrency.grant,
          invocationKey("concurrency-active"),
          "active query",
        ),
      );
      const competitors = await Promise.allSettled([
        concurrency.ledger.reserve(
          concurrency.grant,
          invocationKey("concurrency-left"),
          "left query",
        ),
        peerLedger.reserve(
          concurrency.grant,
          invocationKey("concurrency-right"),
          "right query",
        ),
      ]);
      const accepted = competitors.filter(
        (item) => item.status === "fulfilled",
      );
      const rejected = competitors.filter((item) => item.status === "rejected");
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
      });
      expect(
        (
          await db.knowledgeToolBudget.findUniqueOrThrow({
            where: { runtimeAttemptId: concurrency.grant.runtimeAttemptId },
          })
        ).totalStarts,
      ).toBe(2);
      await concurrency.ledger.release(active, "TEST_RELEASE");
      const acceptedReservation = reserved(
        (
          accepted[0] as PromiseFulfilledResult<
            Awaited<ReturnType<KnowledgeToolLedgerService["reserve"]>>
          >
        ).value,
      );
      await concurrency.ledger.release(acceptedReservation, "TEST_RELEASE");

      const retries = await createLedgerHarness(db, fixture, "retry-cap");
      const retryKey = invocationKey("retry-cap");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reservation = reserved(
          await retries.ledger.reserve(retries.grant, retryKey, "retry query"),
        );
        await retries.ledger.release(
          reservation,
          "KNOWLEDGE_PROVIDER_UNAVAILABLE",
        );
      }
      await expect(
        retries.ledger.reserve(retries.grant, retryKey, "retry query"),
      ).rejects.toMatchObject({ status: 429 });
      expect(
        await db.knowledgeRetrievalInvocation.findUnique({
          where: {
            runtimeAttemptId_invocationId: {
              runtimeAttemptId: retries.grant.runtimeAttemptId,
              invocationId: retryKey,
            },
          },
        }),
      ).toMatchObject({ status: "failed", attemptCount: 3 });

      const stale = await createLedgerHarness(
        db,
        fixture,
        "stale-lease",
        -10_000,
      );
      const staleKey = invocationKey("stale-lease");
      await seedExpiredInvocation(db, stale.grant, staleKey, "stale query");
      const recovered = reserved(
        await stale.ledger.reserve(stale.grant, staleKey, "stale query"),
      );
      expect(
        await db.knowledgeRetrievalInvocation.findUnique({
          where: { id: recovered.id },
        }),
      ).toMatchObject({ status: "in_flight", attemptCount: 2 });
      await stale.ledger.release(recovered, "TEST_RELEASE");

      const successQuota = await createLedgerHarness(
        db,
        fixture,
        "success-quota",
      );
      for (let index = 0; index < 12; index += 1) {
        const reservation = reserved(
          await successQuota.ledger.reserve(
            successQuota.grant,
            invocationKey(`success-quota-${index}`),
            `success query ${index}`,
          ),
        );
        await successQuota.ledger.commit(
          successQuota.grant,
          reservation,
          response,
        );
      }
      await expect(
        successQuota.ledger.reserve(
          successQuota.grant,
          invocationKey("success-quota-overflow"),
          "overflow",
        ),
      ).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({
          code: "KNOWLEDGE_SUCCESS_QUOTA_EXHAUSTED",
        }),
      });

      const rateQuota = await createLedgerHarness(db, fixture, "rate-quota");
      for (let index = 0; index < 12; index += 1) {
        const reservation = reserved(
          await rateQuota.ledger.reserve(
            rateQuota.grant,
            invocationKey(`rate-quota-${index}`),
            `failed query ${index}`,
          ),
        );
        await rateQuota.ledger.release(
          reservation,
          "KNOWLEDGE_PROVIDER_UNAVAILABLE",
        );
      }
      await expect(
        rateQuota.ledger.reserve(
          rateQuota.grant,
          invocationKey("rate-quota-overflow"),
          "overflow",
        ),
      ).rejects.toMatchObject({ status: 429 });

      const totalQuota = await createLedgerHarness(
        db,
        fixture,
        "total-quota",
        -4 * 60_000,
      );
      await seedHistoricalStarts(db, totalQuota.grant, 36);
      await expect(
        totalQuota.ledger.reserve(
          totalQuota.grant,
          invocationKey("total-quota-overflow"),
          "overflow",
        ),
      ).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({
          code: "KNOWLEDGE_TOTAL_START_LIMIT_REACHED",
        }),
      });

      const constraints = await createLedgerHarness(db, fixture, "constraints");
      await expect(
        db.knowledgeToolBudget.update({
          where: { runtimeAttemptId: constraints.grant.runtimeAttemptId },
          data: { maxSuccessfulCalls: 13 },
        }),
      ).rejects.toThrow(/KNOWLEDGE_TOOL_BUDGET_POLICY_IMMUTABLE/u);
      const forged = {
        ...constraints.grant,
        grantId: `forged_${constraints.grant.grantId}`,
        projectId: fixture.outsiderProjectId,
      };
      await expect(
        db.knowledgeToolGrant.create({
          data: {
            id: forged.grantId,
            runtimeAttemptId: forged.runtimeAttemptId,
            runId: forged.runId,
            principalId: forged.principalId,
            projectId: forged.projectId,
            releaseId: forged.releaseId,
            payloadSha256: knowledgeToolGrantPayloadSha256(forged),
            issuedAt: forged.issuedAt,
            expiresAt: forged.expiresAt,
            createdAt: forged.issuedAt,
          },
        }),
      ).rejects.toThrow(/KNOWLEDGE_TOOL_GRANT_SCOPE_INVALID/u);
      await expect(
        db.knowledgeRetrievalInvocation.create({
          data: {
            id: `unaccounted_${Date.now()}`,
            runtimeAttemptId: constraints.grant.runtimeAttemptId,
            invocationId: invocationKey("unaccounted-start"),
            lastGrantId: constraints.grant.grantId,
            querySha256: "a".repeat(64),
            status: "in_flight",
            attemptCount: 1,
            leaseToken: "unaccounted_lease_token_1234",
            leaseExpiresAt: new Date(Date.now() + 60_000),
            lastStartedAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/KNOWLEDGE_RETRIEVAL_START_LEDGER_MISMATCH/u);

      const membership = await createLedgerHarness(
        db,
        fixture,
        "membership-race",
      );
      const membershipReservation = reserved(
        await membership.ledger.reserve(
          membership.grant,
          invocationKey("membership-race"),
          "membership query",
        ),
      );
      const replacement = await db.principal.create({
        data: {
          issuer: `knowledge-replacement-${Date.now()}`,
          subject: `replacement-${Date.now()}`,
        },
      });
      await db.workspaceMember.create({
        data: {
          workspaceId: fixture.workspaceId,
          principalId: replacement.id,
          role: "member",
        },
      });
      await db.projectMember.create({
        data: {
          projectId: fixture.projectId,
          workspaceId: fixture.workspaceId,
          principalId: replacement.id,
          role: "owner",
        },
      });
      const lockAcquired = deferred<void>();
      const allowRemoval = deferred<void>();
      const removal = peer.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM public."projects" WHERE "id" = ${fixture.projectId} FOR UPDATE
        `);
        lockAcquired.resolve();
        await allowRemoval.promise;
        await tx.projectMember.delete({
          where: {
            projectId_principalId: {
              projectId: fixture.projectId,
              principalId: fixture.ownerId,
            },
          },
        });
        await tx.project.update({
          where: { id: fixture.projectId },
          data: { revision: { increment: 1 } },
        });
      });
      await lockAcquired.promise;
      const settlement = membership.ledger.commit(
        membership.grant,
        membershipReservation,
        response,
      );
      await new Promise((resolve) => setImmediate(resolve));
      allowRemoval.resolve();
      await removal;
      await expect(settlement).rejects.toMatchObject({ status: 404 });
      expect(
        await db.knowledgeRetrievalInvocation.findUnique({
          where: { id: membershipReservation.id },
        }),
      ).toMatchObject({
        status: "discarded",
        lastErrorCode: "KNOWLEDGE_CAPABILITY_SCOPE_REVOKED",
      });
    } finally {
      await peer.$disconnect();
      await db.$disconnect();
    }
  }, 120_000);
});

async function seedFixture(tx: Prisma.TransactionClient) {
  const suffix =
    `${Date.now()}_${Math.random().toString(36).slice(2)}`.toLowerCase();
  const owner = await tx.principal.create({
    data: { issuer: `knowledge-${suffix}`, subject: `owner-${suffix}` },
  });
  const outsider = await tx.principal.create({
    data: { issuer: `knowledge-${suffix}`, subject: `outsider-${suffix}` },
  });
  await tx.knowledgeProfileOperatorEvent.create({
    data: {
      principalId: owner.id,
      action: "grant",
      authorizedBy: "knowledge-retrieval.postgres.fixture",
      changeReference: `knowledge-retrieval/${suffix}`,
    },
  });
  const workspace = await tx.workspace.create({
    data: {
      slug: `knowledge-${suffix}`,
      name: "Knowledge retrieval",
      createdById: owner.id,
    },
  });
  const outsiderWorkspace = await tx.workspace.create({
    data: {
      slug: `knowledge-outsider-${suffix}`,
      name: "Other workspace",
      createdById: outsider.id,
    },
  });
  await tx.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
      {
        workspaceId: outsiderWorkspace.id,
        principalId: outsider.id,
        role: "owner",
      },
    ],
  });
  const project = await tx.project.create({
    data: {
      workspaceId: workspace.id,
      createdById: owner.id,
      title: "Knowledge project",
    },
  });
  const outsiderProject = await tx.project.create({
    data: {
      workspaceId: outsiderWorkspace.id,
      createdById: outsider.id,
      title: "Other project",
    },
  });
  await tx.projectMember.createMany({
    data: [
      {
        projectId: project.id,
        workspaceId: workspace.id,
        principalId: owner.id,
        role: "owner",
      },
      {
        projectId: outsiderProject.id,
        workspaceId: outsiderWorkspace.id,
        principalId: outsider.id,
        role: "owner",
      },
    ],
  });

  const profile = parseEmbeddingProfileV1(
    embeddingSpec(`knowledge-retrieval-${suffix}`),
  );
  await tx.embeddingProfile.create({
    data: {
      id: profile.spec.id,
      spec: profile.spec as unknown as Prisma.InputJsonValue,
      specSha256: profile.specSha256,
      dimension: profile.dimension,
    },
  });
  await tx.embeddingProfile.update({
    where: { id: profile.spec.id },
    data: { status: "poc" },
  });
  await tx.embeddingProfile.update({
    where: { id: profile.spec.id },
    data: { status: "adopted" },
  });
  await tx.knowledgeProfileAdoptionReceipt.create({
    data: {
      id: `embedding-adoption-${suffix}`,
      profileKind: "embedding",
      embeddingProfileId: profile.spec.id,
      embeddingProfileSpecSha256: profile.specSha256,
      actorPrincipalId: owner.id,
    },
  });
  const retrievalProfile = parseRetrievalProfileV1(
    retrievalSpec(
      `knowledge-retrieval-policy-${suffix}`,
      profile.spec.id,
      profile.specSha256,
      profile.dimension,
    ),
  );
  await tx.retrievalProfile.create({
    data: {
      id: retrievalProfile.spec.id,
      spec: retrievalProfile.spec as unknown as Prisma.InputJsonValue,
      specSha256: retrievalProfile.specSha256,
      embeddingProfileId: retrievalProfile.embeddingProfileId,
      embeddingProfileSpecSha256: retrievalProfile.embeddingProfileSpecSha256,
      embeddingDimension: retrievalProfile.embeddingDimension,
    },
  });
  await tx.retrievalProfile.update({
    where: { id: retrievalProfile.spec.id },
    data: { status: "poc" },
  });
  await tx.retrievalProfile.update({
    where: { id: retrievalProfile.spec.id },
    data: { status: "adopted" },
  });
  await tx.knowledgeProfileAdoptionReceipt.create({
    data: {
      id: `retrieval-adoption-${suffix}`,
      profileKind: "retrieval",
      retrievalProfileId: retrievalProfile.spec.id,
      retrievalProfileSpecSha256: retrievalProfile.specSha256,
      actorPrincipalId: owner.id,
    },
  });
  const manifest = {
    schema: "workbench.knowledge-release.v1",
    releaseKey: `knowledge-${suffix}`,
    profile: {
      embedding: { id: profile.spec.id, specSha256: profile.specSha256 },
      retrieval: {
        id: retrievalProfile.spec.id,
        specSha256: retrievalProfile.specSha256,
      },
      segmenter: {
        id: segmenterIdentity.implementationId,
        version: segmenterIdentity.version,
        dictionaryChecksum: segmenterIdentity.dictionarySha256,
        stopwordsChecksum: segmenterIdentity.stopwordsSha256,
      },
    },
  };
  const release = await tx.knowledgeRelease.create({
    data: {
      key: `knowledge-${suffix}`,
      workspaceId: workspace.id,
      version: 1,
      embeddingProfileId: profile.spec.id,
      embeddingProfileSpecSha256: profile.specSha256,
      embeddingDimension: profile.dimension,
      retrievalProfileId: retrievalProfile.spec.id,
      retrievalProfileSpecSha256: retrievalProfile.specSha256,
      manifest: manifest as Prisma.InputJsonValue,
      manifestSha256: canonicalSha256(manifest as JsonValue),
    },
  });

  const documents = [
    {
      id: `kdoc_production_${suffix}`,
      path: "00-rules/product.md",
      title: "产品规则",
      route: "production" as const,
    },
    {
      id: `kdoc_secondary_${suffix}`,
      path: "00-rules/design.md",
      title: "设计规范",
      route: "production" as const,
    },
    {
      id: `kdoc_source_${suffix}`,
      path: "07-sources/internal.md",
      title: "内部来源",
      route: "source_lookup" as const,
    },
  ];
  for (const document of documents) {
    await tx.knowledgeDocument.create({
      data: {
        id: document.id,
        releaseId: release.id,
        sourceKind: "vault_markdown",
        sourcePath: document.path,
        title: document.title,
        checksum: "a".repeat(64),
        route: document.route,
        metadata: { sourceLocator: `vault://knowledge-vault/${document.path}` },
      },
    });
  }
  const chunks = [
    {
      id: `kchunk_production_${suffix}`,
      documentId: documents[0]!.id,
      content: "产品 工作台 用户 规则",
      vector: "[1,0,0]",
    },
    {
      id: `kchunk_secondary_${suffix}`,
      documentId: documents[1]!.id,
      content: "设计 系统 规范",
      vector: "[0.8,0.6,0]",
    },
    {
      id: `kchunk_source_${suffix}`,
      documentId: documents[2]!.id,
      content: "内部 来源 原始 资料",
      vector: "[1,0,0]",
    },
  ];
  for (const [sequence, chunk] of chunks.entries()) {
    await tx.knowledgeChunk.create({
      data: {
        id: chunk.id,
        documentId: chunk.documentId,
        releaseId: release.id,
        sequence,
        headingPath: ["规则"],
        content: chunk.content,
        tokenCount: 4,
      },
    });
    const searchText = integrationSegmenter.segment(chunk.content).join(" ");
    await tx.$executeRaw(Prisma.sql`
      UPDATE public."knowledge_chunks"
      SET "search_vector" = to_tsvector('simple', ${searchText})
      WHERE "id" = ${chunk.id}
    `);
  }
  const batchId = `kbatch_${suffix}`;
  await tx.knowledgeEmbeddingBatch.create({
    data: {
      id: batchId,
      releaseId: release.id,
      profileId: profile.spec.id,
      profileSpecSha256: profile.specSha256,
      dimension: profile.dimension,
      sequence: 0,
      chunkIds: chunks.map((chunk) => chunk.id),
      inputCount: chunks.length,
      inputSha256: "b".repeat(64),
    },
  });
  const startedAt = new Date();
  await tx.knowledgeEmbeddingBatch.update({
    where: { id: batchId },
    data: {
      status: "running",
      attemptCount: 1,
      leaseToken: `lease-${suffix}`,
      queueJobId: `job-${suffix}`,
      queueRetryCount: 0,
      startedAt,
    },
  });
  for (const chunk of chunks) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_chunk_embeddings" (
        "chunk_id", "release_id", "profile_id", "profile_spec_sha256",
        "dimension", "embedding", "embedding_sha256"
      ) VALUES (
        ${chunk.id}, ${release.id}, ${profile.spec.id}, ${profile.specSha256},
        ${profile.dimension}, ${chunk.vector}::public.vector, ${"c".repeat(64)}
      )
    `);
  }
  await tx.knowledgeEmbeddingBatch.update({
    where: { id: batchId },
    data: {
      status: "ready",
      leaseToken: null,
      tokenCount: 12,
      outputSha256: "d".repeat(64),
      finishedAt: new Date(),
    },
  });
  await tx.knowledgeRelease.update({
    where: { id: release.id },
    data: { chunksReadyAt: new Date(), status: "ready", readyAt: new Date() },
  });

  return {
    workspaceId: workspace.id,
    ownerId: owner.id,
    outsiderId: outsider.id,
    projectId: project.id,
    outsiderProjectId: outsiderProject.id,
    releaseId: release.id,
    profileId: profile.spec.id,
    profileSpecSha256: profile.specSha256,
    retrievalProfileId: retrievalProfile.spec.id,
    retrievalProfileSpecSha256: retrievalProfile.specSha256,
    productionChunkId: chunks[0]!.id,
    secondaryChunkId: chunks[1]!.id,
    sourceLookupChunkId: chunks[2]!.id,
  };
}

async function seedRuntimeFixture(
  tx: Prisma.TransactionClient,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  attemptStatus: "pending" | "submitting" | "running" = "running",
) {
  const runtimeSuffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const thread = await tx.thread.create({
    data: {
      projectId: fixture.projectId,
      createdById: fixture.ownerId,
      title: "Knowledge Runtime",
    },
  });
  const request = {
    prompt: "Use the pinned Knowledge release",
    modelId: "quality",
    workflow: "generate",
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    artifactTargets: [],
    requestedArtifactKinds: ["prd"],
  };
  const run = await tx.run.create({
    data: {
      projectId: fixture.projectId,
      threadId: thread.id,
      createdById: fixture.ownerId,
      knowledgeReleaseId: fixture.releaseId,
      idempotencyKey: `knowledge-tool-${runtimeSuffix}`,
      requestHash: "e".repeat(64),
      requestId: `request_${runtimeSuffix}`,
      request,
      status: "running",
      modelId: request.modelId,
      traceId: `trace_${runtimeSuffix}`,
      attempt: 1,
      startedAt: new Date(),
    },
  });
  const binding = await tx.runtimeBinding.create({
    data: {
      threadId: thread.id,
      adapter: "deerflow",
      externalThreadId: `external_${thread.id}`,
      metadata: { projectId: fixture.projectId },
    },
  });
  const attempt = await tx.runtimeAttempt.create({
    data: {
      runId: run.id,
      runtimeBindingId: binding.id,
      attempt: 1,
      adapter: "deerflow",
      externalThreadId: binding.externalThreadId,
    },
  });
  if (attemptStatus !== "pending") {
    await tx.runtimeAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "submitting",
        startedAt: new Date(),
        providerIdempotencyKey: `wbrt:${createHash("sha256").update(attempt.id).digest("hex")}`,
      },
    });
  }
  if (attemptStatus === "running") {
    await tx.runtimeAttempt.update({
      where: { id: attempt.id },
      data: { status: "running", externalRunId: `external_run_${run.id}` },
    });
  }
  return { runId: run.id, runtimeAttemptId: attempt.id };
}

type TestGrantPayload = {
  grantId: string;
  runId: string;
  runtimeAttemptId: string;
  principalId: string;
  projectId: string;
  releaseId: string;
  mode: "hybrid";
  routeScope: "production";
  issuedAt: Date;
  expiresAt: Date;
};

async function registerGrantLedger(
  tx: Prisma.TransactionClient,
  payload: TestGrantPayload,
) {
  await tx.knowledgeToolBudget.create({
    data: {
      runtimeAttemptId: payload.runtimeAttemptId,
      maxSuccessfulCalls: 12,
      maxConcurrentCalls: 2,
      maxStartsPerWindow: 12,
      windowSeconds: 60,
      maxAttemptsPerInvocation: 3,
      maxTotalStarts: 36,
      windowStartedAt: payload.issuedAt,
      createdAt: payload.issuedAt,
      updatedAt: payload.issuedAt,
    },
  });
  await tx.knowledgeToolGrant.create({
    data: {
      id: payload.grantId,
      runtimeAttemptId: payload.runtimeAttemptId,
      runId: payload.runId,
      principalId: payload.principalId,
      projectId: payload.projectId,
      releaseId: payload.releaseId,
      payloadSha256: knowledgeToolGrantPayloadSha256(payload),
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      createdAt: payload.issuedAt,
    },
  });
}

function transactionFacade(tx: Prisma.TransactionClient) {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return async (
          callback: (client: Prisma.TransactionClient) => unknown,
        ) => callback(tx);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function invocationKey(label: string) {
  return `knowledge:${canonicalSha256(label)}`;
}

function reserved(
  result: Awaited<ReturnType<KnowledgeToolLedgerService["reserve"]>>,
) {
  if (result.kind !== "reserved")
    throw new Error("Expected a new Knowledge reservation");
  return result.reservation;
}

async function createLedgerHarness(
  db: PrismaClient,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  label: string,
  issuedAtOffsetMs = 0,
  attemptStatus: "pending" | "submitting" | "running" = "running",
) {
  const runtime = await seedRuntimeFixture(db as never, fixture, attemptStatus);
  const issuedAt = new Date(
    Math.floor((Date.now() + issuedAtOffsetMs) / 1_000) * 1_000,
  );
  const grant: TestGrantPayload = {
    grantId: `grant_${label.replace(/-/gu, "_")}_${runtime.runId}`,
    runId: runtime.runId,
    runtimeAttemptId: runtime.runtimeAttemptId,
    principalId: fixture.ownerId,
    projectId: fixture.projectId,
    releaseId: fixture.releaseId,
    mode: "hybrid",
    routeScope: "production",
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 15 * 60_000),
  };
  await registerGrantLedger(db as never, grant);
  return { grant, ledger: new KnowledgeToolLedgerService(db as never) };
}

function ledgerResponse(fixture: Awaited<ReturnType<typeof seedFixture>>) {
  return {
    protocol: "workbench.knowledge-retrieval-result.v1" as const,
    evidence: {
      schema: "workbench.knowledge-retrieval-evidence.v1" as const,
      mode: "hybrid" as const,
      routeScope: "production" as const,
      release: { id: fixture.releaseId, key: "knowledge", version: 1 },
      embeddingProfile: {
        id: fixture.profileId,
        specSha256: fixture.profileSpecSha256,
        dimension: 3,
      },
      retrievalProfile: {
        id: fixture.retrievalProfileId,
        specSha256: fixture.retrievalProfileSpecSha256,
      },
      candidateCounts: { lexical: 0, dense: 0, fused: 0 },
      fusion: { algorithm: "rrf" as const, k: 60 },
      reranker: { status: "not_needed" as const },
      degraded: false,
    },
    items: [],
  };
}

async function seedExpiredInvocation(
  db: PrismaClient,
  grant: TestGrantPayload,
  invocationId: string,
  query: string,
) {
  const leaseExpiresAt = new Date(grant.issuedAt.getTime() + 1_000);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "runtime_attempt_id"
      FROM public."knowledge_tool_budgets"
      WHERE "runtime_attempt_id" = ${grant.runtimeAttemptId}
      FOR UPDATE
    `);
    await tx.knowledgeToolBudget.update({
      where: { runtimeAttemptId: grant.runtimeAttemptId },
      data: {
        windowStarts: { increment: 1 },
        totalStarts: { increment: 1 },
        updatedAt: grant.issuedAt,
      },
    });
    await tx.knowledgeRetrievalInvocation.create({
      data: {
        id: `stale_${randomTestSuffix()}`,
        runtimeAttemptId: grant.runtimeAttemptId,
        invocationId,
        lastGrantId: grant.grantId,
        querySha256: queryDigest(query),
        status: "in_flight",
        attemptCount: 1,
        leaseToken: "stale_lease_token_123456789",
        leaseExpiresAt,
        lastStartedAt: grant.issuedAt,
        createdAt: grant.issuedAt,
        updatedAt: grant.issuedAt,
      },
    });
  });
}

async function seedHistoricalStarts(
  db: PrismaClient,
  grant: TestGrantPayload,
  count: number,
) {
  for (let index = 0; index < count; index += 1) {
    const windowIndex = Math.floor(index / 12);
    const position = index % 12;
    const windowStartedAt = new Date(
      grant.issuedAt.getTime() + windowIndex * 60_000,
    );
    const startedAt = new Date(windowStartedAt.getTime() + position * 1_000);
    const finishedAt = new Date(startedAt.getTime() + 500);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "runtime_attempt_id"
        FROM public."knowledge_tool_budgets"
        WHERE "runtime_attempt_id" = ${grant.runtimeAttemptId}
        FOR UPDATE
      `);
      await tx.knowledgeToolBudget.update({
        where: { runtimeAttemptId: grant.runtimeAttemptId },
        data: {
          ...(position === 0 && windowIndex > 0
            ? { windowStartedAt, windowStarts: 1 }
            : { windowStarts: { increment: 1 } }),
          totalStarts: { increment: 1 },
          updatedAt: startedAt,
        },
      });
      const receipt = await tx.knowledgeRetrievalInvocation.create({
        data: {
          id: `historical_${index}_${randomTestSuffix()}`,
          runtimeAttemptId: grant.runtimeAttemptId,
          invocationId: invocationKey(
            `historical-${grant.runtimeAttemptId}-${index}`,
          ),
          lastGrantId: grant.grantId,
          querySha256: queryDigest(`historical query ${index}`),
          status: "in_flight",
          attemptCount: 1,
          leaseToken: `historical_lease_${index}_123456789`,
          leaseExpiresAt: new Date(startedAt.getTime() + 250),
          lastStartedAt: startedAt,
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      });
      await tx.knowledgeRetrievalInvocation.update({
        where: { id: receipt.id },
        data: {
          status: "failed",
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: "TEST_HISTORICAL_FAILURE",
          finishedAt,
          updatedAt: finishedAt,
        },
      });
    });
  }
}

function queryDigest(value: string) {
  return createHash("sha256")
    .update(value.normalize("NFC"), "utf8")
    .digest("hex");
}

function randomTestSuffix() {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const integrationSegmenter = new JiebaQuerySegmenterAdapter();
const segmenterIdentity = integrationSegmenter.identity;

function embeddingRuntimeInfo() {
  return {
    model_id: "integration/model",
    model_sha: "commit-r1",
    version: "1.8.3",
    max_input_length: 512,
    max_batch_tokens: 8_192,
    max_client_batch_size: 32,
    auto_truncate: false,
  };
}

function rerankerRuntimeInfo() {
  return {
    model_id: "integration/reranker",
    model_sha: "commit-reranker-r1",
    version: "1.8.3",
    max_input_length: 512,
    max_batch_tokens: 8_192,
    max_client_batch_size: 24,
    auto_truncate: false,
  };
}

function embeddingSpec(id: string): EmbeddingProfileV1 {
  return {
    schema: "workbench.embedding-profile.v1",
    id,
    protocol: "tei.embed.v1",
    engine: {
      id: "huggingface/text-embeddings-inference",
      version: "1.8.3",
      imageDigest: `sha256:${"1".repeat(64)}`,
    },
    model: {
      id: "integration/model",
      revision: "commit-r1",
      artifactSha256: "2".repeat(64),
    },
    tokenizer: {
      id: "integration/tokenizer",
      revision: "commit-r1",
      artifactSha256: "3".repeat(64),
      modelMaximumTokens: 512,
      chunkMaximumTokens: 256,
      overflow: "reject",
    },
    input: {
      queryPrefix: "",
      documentPrefix: "",
      normalization: "utf8-nfc-lf-v1",
    },
    output: {
      dimension: 3,
      dtype: "float32",
      pooling: "cls",
      normalization: "l2",
      distance: "cosine",
    },
    batch: { maximumInputs: 32, maximumTokens: 8_192 },
    conformanceProbeSha256: "4".repeat(64),
  };
}

function retrievalSpec(
  id: string,
  embeddingProfileId: string,
  embeddingProfileSpecSha256: string,
  embeddingDimension: number,
): RetrievalProfileV1 {
  return {
    schema: "workbench.retrieval-profile.v1",
    id,
    embedding: {
      profileId: embeddingProfileId,
      profileSpecSha256: embeddingProfileSpecSha256,
      dimension: embeddingDimension,
    },
    segmenter: {
      ...segmenterIdentity,
      normalization: "utf8-nfc-lf-v1",
    },
    recall: {
      lexical: {
        algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1",
        limit: 40,
      },
      dense: { distance: "cosine", limit: 40 },
      fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" },
    },
    reranker: {
      protocol: "tei.rerank.v1",
      engine: {
        id: "huggingface/text-embeddings-inference",
        version: "1.8.3",
        imageDigest: `sha256:${"7".repeat(64)}`,
      },
      model: {
        id: "integration/reranker",
        revision: "commit-reranker-r1",
        artifactSha256: "8".repeat(64),
      },
      tokenizer: {
        id: "integration/reranker-tokenizer",
        revision: "commit-reranker-r1",
        artifactSha256: "9".repeat(64),
        maximumInputTokens: 512,
        overflow: "reject",
      },
      candidateLimit: 24,
      finalResultLimit: 10,
      failurePolicy: "degrade_to_rrf",
      conformanceProbeSha256: "a".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  };
}
