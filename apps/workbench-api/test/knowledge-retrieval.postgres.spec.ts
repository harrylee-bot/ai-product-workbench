import { seedFixture,embeddingSpec,retrievalSpec,integrationSegmenter,segmenterIdentity } from "./fixtures/knowledge-retrieval.js";
import { createHash,randomBytes } from "node:crypto";
import { canonicalJson, type KnowledgeToolResponse, type RuntimeResult } from "@workbench/workbench-contracts";
import { assertGenerationKnowledgeEvidence } from "../../workbench-worker/src/runs/generation-knowledge-evidence.js";
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
import { describe, expect, it,vi } from "vitest";
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
          UPDATE "knowledge_releases"
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

  it("keeps retrieval receipt hashes stable through JSONB and passes the actual Worker evidence check", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const fixture = await db.$transaction((tx) => seedFixture(tx), { timeout: 60_000 });
      const harness = await createLedgerHarness(db, fixture, "score-round-trip");
      const key = invocationKey(`score-round-trip-${fixture.releaseId}`);
      const reservation = reserved(await harness.ledger.reserve(harness.grant, key, "fractional score query"));
      const chunk = await db.knowledgeChunk.findUniqueOrThrow({ where: { id: fixture.productionChunkId }, include: { document: true } });
      const scores = [1 / 62, 2 / 61, Math.PI, 0.1 + 0.2, Math.PI * 1e-28, Number.MAX_VALUE, Number.MIN_VALUE, 0];
      const response: KnowledgeToolResponse = {
        ...ledgerResponse(fixture),
        items: scores.map((score, index) => ({
          rank: index + 1, rrfScore: score, rerankerScore: index === 7 ? null : -score,
          citation: {
            id: `score-citation-${index}`, documentId: chunk.documentId, chunkId: chunk.id,
            sourcePath: chunk.document.sourcePath, title: chunk.document.title,
            quote: 'Exact business text: 0.016129032258064516 / false / 额度 0',
            locator: { heading: "Requirements", startLine: null, endLine: null },
          },
        })),
      };
      const committed = await harness.ledger.commit(harness.grant, reservation, response);
      const receipt = await db.knowledgeRetrievalInvocation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(committed.items[0]!.rrfScore).toBe(0.0161290322581);
      expect(committed.items.map((item) => item.citation)).toEqual(response.items.map((item) => item.citation));
      expect(receipt.response).toEqual(committed);
      expect(receipt.responseSha256).toBe(createHash("sha256").update(canonicalJson(receipt.response)).digest("hex"));
      expect(await harness.ledger.reserve(harness.grant, key, "fractional score query")).toEqual({ kind: "replay", response: committed });
      const result: RuntimeResult = {
        protocol: "workbench.runtime.result.v1", message: "Source-grounded result",
        artifacts: [{ kind: "document", schemaVersion: 1, title: "Result", operation: { kind: "create" },
          content: { text: "Business rules" }, citations: committed.items.map((item) => item.citation) }],
      };
      await expect(db.$transaction((tx) => assertGenerationKnowledgeEvidence(tx, {
        runId: harness.grant.runId, runtimeAttemptId: harness.grant.runtimeAttemptId,
        projectId: fixture.projectId, principalId: fixture.ownerId, releaseId: fixture.releaseId,
      }, result))).resolves.toBeUndefined();
    } finally { await db.$disconnect(); }
  }, 30_000);

  it('rejects signed capability requests and successful replay while disabled, then permits restored account access',async()=>{
    const db=new PrismaClient({datasourceUrl:databaseUrl});
    try{
      const fixture=await db.$transaction(tx=>seedFixture(tx),{timeout:60000}),h=await createLedgerHarness(db,fixture,'disabled-account');
      const {tool,authorization,embedding}=signedTool(db,fixture,h),request={protocol:'workbench.knowledge-retrieval-request.v1' as const,query:'产品 工作台 用户 规则'};
      const key=invocationKey('active-before-disable'),result=await tool.retrieve(authorization,key,request);expect(result.items).toHaveLength(2);
      const budget=await db.knowledgeToolBudget.findUniqueOrThrow({where:{runtimeAttemptId:h.grant.runtimeAttemptId}}),calls=embedding.mock.calls.length;
      await db.principal.update({where:{id:fixture.ownerId},data:{status:'disabled'}});
      for(const action of [key,invocationKey('disabled-new')])await expect(tool.retrieve(authorization,action,request)).rejects.toMatchObject({status:404});
      expect(embedding).toHaveBeenCalledTimes(calls);expect(await db.knowledgeToolBudget.findUniqueOrThrow({where:{runtimeAttemptId:h.grant.runtimeAttemptId}})).toEqual(budget);
      expect(await db.knowledgeRetrievalInvocation.count({where:{runtimeAttemptId:h.grant.runtimeAttemptId,status:'succeeded'}})).toBe(1);
      await db.principal.update({where:{id:fixture.ownerId},data:{status:'active'}});
      expect(await tool.retrieve(authorization,key,request)).toEqual(result);expect(embedding).toHaveBeenCalledTimes(calls);
      expect((await tool.retrieve(authorization,invocationKey('restored-new'),request)).items).toHaveLength(2);
    }finally{await db.$disconnect();}
  });

  it('discards an in-flight indexed retrieval when the account is disabled before settlement',async()=>{
    const db=new PrismaClient({datasourceUrl:databaseUrl});const entered=deferred<void>(),resume=deferred<void>();
    try{
      const fixture=await db.$transaction(tx=>seedFixture(tx),{timeout:60000}),h=await createLedgerHarness(db,fixture,'disable-during-provider');
      const {tool,authorization,embedding}=signedTool(db,fixture,h),request={protocol:'workbench.knowledge-retrieval-request.v1' as const,query:'产品 工作台 用户 规则'};
      embedding.mockImplementationOnce(async()=>{entered.resolve();await resume.promise;return [1,0,0];});
      const key=invocationKey('disable-in-flight'),pending=tool.retrieve(authorization,key,request);const result=pending.then(value=>({value}),error=>({error}));await entered.promise;
      await db.principal.update({where:{id:fixture.ownerId},data:{status:'disabled'}});resume.resolve();
      expect(await result).toMatchObject({error:{status:404}});
      const receipt=await db.knowledgeRetrievalInvocation.findUniqueOrThrow({where:{runtimeAttemptId_invocationId:{runtimeAttemptId:h.grant.runtimeAttemptId,invocationId:key}}});
      expect(receipt).toMatchObject({status:'discarded',response:null,responseSha256:null,leaseToken:null,lastErrorCode:'KNOWLEDGE_CAPABILITY_SCOPE_REVOKED'});
      await db.principal.update({where:{id:fixture.ownerId},data:{status:'active'}});await expect(tool.retrieve(authorization,key,request)).rejects.toMatchObject({status:404});
      expect((await tool.retrieve(authorization,invocationKey('after-in-flight-restored'),request)).items).toHaveLength(2);
    }finally{resume.resolve();await db.$disconnect();}
  });

  it.each(['settlement-first','deactivation-first'] as const)('serializes account deactivation with capability settlement: %s',async order=>{
    const db=new PrismaClient({datasourceUrl:databaseUrl}),peer=new PrismaClient({datasourceUrl:databaseUrl});const held=deferred<number>(),release=deferred<void>(),otherEntered=deferred<number>();
    try{
      const fixture=await db.$transaction(tx=>seedFixture(tx),{timeout:60000}),h=await createLedgerHarness(db,fixture,'account-lock-'+order);
      const key=invocationKey('account-lock-'+order),reservation=reserved(await h.ledger.reserve(h.grant,key,'account lock query'));
      const proxied=new Proxy(db,{get(target,method){if(method==='$transaction')return (operation:any)=>db.$transaction(async tx=>{
        const [{pid}]=await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
        if(order==='deactivation-first')otherEntered.resolve(pid!);
        const scoped=new Proxy(tx,{get(t,k){if(k==='knowledgeRetrievalInvocation')return new Proxy(t.knowledgeRetrievalInvocation,{get(delegate,name){if(name==='updateMany')return async(args:any)=>{if(order==='settlement-first'&&args.data.status==='succeeded'){held.resolve(pid!);await release.promise;}return delegate.updateMany(args);};const value=Reflect.get(delegate,name);return typeof value==='function'?value.bind(delegate):value;}});const value=Reflect.get(t,k);return typeof value==='function'?value.bind(t):value;}});
        return operation(scoped);
      },{timeout:15000});const value=Reflect.get(target,method);return typeof value==='function'?value.bind(target):value;}});
      const settle=()=>new KnowledgeToolLedgerService(proxied as never).commit(h.grant,reservation,ledgerResponse(fixture));
      const deactivate=()=>peer.$transaction(async tx=>{const [{pid}]=await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;if(order==='settlement-first')otherEntered.resolve(pid!);await tx.principal.update({where:{id:fixture.ownerId},data:{status:'disabled'}});if(order==='deactivation-first'){held.resolve(pid!);await release.promise;}},{timeout:15000});
      const first=order==='settlement-first'?settle():deactivate();const firstPid=await held.promise;
      const other=order==='settlement-first'?deactivate():settle(),outcome=other.then(value=>({value}),error=>({error}));
      try{const otherPid=await otherEntered.promise;await vi.waitFor(async()=>{const [{pids}]=await db.$queryRaw<{pids:number[]}[]>`SELECT pg_blocking_pids(${otherPid}::int) AS pids`;expect(pids).toContain(firstPid);},{timeout:3000,interval:20});}finally{release.resolve();}
      await first;const result=await outcome;
      if(order==='deactivation-first')expect(result).toMatchObject({error:{status:404}});else expect(result).toHaveProperty('value');
      expect(await db.knowledgeRetrievalInvocation.findUniqueOrThrow({where:{id:reservation.id}})).toMatchObject({status:order==='settlement-first'?'succeeded':'discarded'});
      await expect(h.ledger.reserve(h.grant,key,'account lock query')).rejects.toMatchObject({status:404});
    }finally{release.resolve();await peer.$disconnect();await db.$disconnect();}
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
          SELECT "id" FROM "projects" WHERE "id" = ${fixture.projectId} FOR UPDATE
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
  const [{now}]=await db.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
  const issuedAt = new Date(
    Math.floor((now!.getTime() + issuedAtOffsetMs) / 1_000) * 1_000,
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

/** Actual signed capability, ledger and indexed retrieval; only embedding and
 * reranking transports are fixtures. No external model/provider requests. */
function signedTool(db:PrismaClient,fixture:Awaited<ReturnType<typeof seedFixture>>,h:Awaited<ReturnType<typeof createLedgerHarness>>){
  const secret=randomBytes(32),config={grantSecret:secret,grantMaximumTtlSeconds:900,providers:null as unknown};
  const access=new AccessService(db as never),tool=new KnowledgeToolService(config as never,access,db as never,h.ledger);
  const embedding=vi.fn(async()=>[1,0,0]);
  const retrieval=new KnowledgeRetrievalService(access,new PrismaKnowledgeRetrievalStore(db),{segmenter:new JiebaQuerySegmenterAdapter(),queryEmbedding:{embedQuery:embedding},reranker:{identity:{id:'integration/reranker',revision:'commit-reranker-r1'},rerank:async({candidates})=>candidates.map((x,index)=>({chunkId:x.chunkId,score:1-index/10}))}});
  config.providers={fixture:true};Object.assign(tool,{retrieval});
  return {tool,embedding,authorization:'Bearer '+createKnowledgeToolGrant(h.grant,secret,{maximumTtlSeconds:900})};
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
      FROM "knowledge_tool_budgets"
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
        FROM "knowledge_tool_budgets"
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
