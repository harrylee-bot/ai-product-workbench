import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import {
  canonicalSha256,
  knowledgeDefaultDictionaryChecksum,
  knowledgeSegmenterId,
  knowledgeSegmenterVersion,
  knowledgeStopwordsChecksum,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
  verifyKnowledgeToolGrant,
  type EmbeddingProfileV1,
  type JsonValue,
  type RetrievalProfileV1,
} from "@workbench/workbench-knowledge";
import {
  knowledgeToolBudgetPolicy,
  PrismaKnowledgeToolGrantIssuer,
} from "../src/runtime/knowledge-tool-grant.service.js";

const databaseUrl =
  process.env.WORKBENCH_KNOWLEDGE_GRANT_TEST_DATABASE_URL ??
  process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Knowledge grant issuer PostgreSQL concurrency", () => {
  it("creates a usable UTC budget even when the database session uses Asia/Shanghai", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const fixture = await seedIssuerFixture(db, false);
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Shanghai'`;
        const issuer = new PrismaKnowledgeToolGrantIssuer({
          $transaction: async (callback: (transaction: Prisma.TransactionClient) => Promise<unknown>) => callback(tx),
        } as never, {
          endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
          secret: Buffer.alloc(32, 31),
          maximumTtlSeconds: 900,
        });
        await issuer.issue({
          runId: fixture.runId,
          runtimeAttemptId: fixture.runtimeAttemptId,
          principalId: fixture.principalId,
          projectId: fixture.projectId,
          releaseId: fixture.releaseId,
        });
        const budget = await tx.knowledgeToolBudget.update({
          where: { runtimeAttemptId: fixture.runtimeAttemptId },
          data: { windowStarts: { increment: 1 }, totalStarts: { increment: 1 } },
        });
        const grant = await tx.knowledgeToolGrant.findFirstOrThrow({
          where: { runtimeAttemptId: fixture.runtimeAttemptId },
        });
        expect(budget.createdAt).toEqual(grant.issuedAt);
        expect(budget.windowStartedAt).toEqual(grant.issuedAt);
        expect(budget.updatedAt.getTime()).toBeGreaterThanOrEqual(budget.createdAt.getTime());
      });
    } finally {
      await db.$disconnect();
    }
  });

  it("serializes concurrent issuers on the RuntimeAttempt budget row", async () => {
    const firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
    const secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
    const lockHeld = deferred<void>();
    const releaseLock = deferred<void>();
    const secondLockRequested = deferred<void>();
    const secondLockAcquired = deferred<void>();
    const secret = Buffer.alloc(32, 31);
    const fixture = await seedIssuerFixture(firstClient);
    const config = {
      endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
      secret,
      maximumTtlSeconds: 900,
    };
    const scope = {
      runId: fixture.runId,
      runtimeAttemptId: fixture.runtimeAttemptId,
      principalId: fixture.principalId,
      projectId: fixture.projectId,
      releaseId: fixture.releaseId,
    };
    const firstIssuer = new PrismaKnowledgeToolGrantIssuer(
      transactionFacade(firstClient, {
        afterBudgetLock: async () => {
          lockHeld.resolve();
          await releaseLock.promise;
        },
      }) as never,
      config,
    );
    const secondIssuer = new PrismaKnowledgeToolGrantIssuer(
      transactionFacade(secondClient, {
        beforeBudgetLock: () => secondLockRequested.resolve(),
        afterBudgetLock: () => secondLockAcquired.resolve(),
      }) as never,
      config,
    );

    try {
      await Promise.all([firstClient.$connect(), secondClient.$connect()]);
      const first = firstIssuer.issue(scope);
      await lockHeld.promise;
      const second = secondIssuer.issue(scope);
      await secondLockRequested.promise;

      const acquiredWhileFirstHeld = await Promise.race([
        secondLockAcquired.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(acquiredWhileFirstHeld).toBe(false);

      releaseLock.resolve();
      const [firstDescriptor, secondDescriptor] = await Promise.all([
        first,
        second,
      ]);
      expect(firstDescriptor).not.toBeNull();
      expect(secondDescriptor).toEqual(firstDescriptor);
      expect(
        verifyKnowledgeToolGrant(firstDescriptor!.token, secret),
      ).toMatchObject(scope);
      await expect(
        firstClient.knowledgeToolBudget.count({
          where: { runtimeAttemptId: fixture.runtimeAttemptId },
        }),
      ).resolves.toBe(1);
      await expect(
        firstClient.knowledgeToolGrant.count({
          where: { runtimeAttemptId: fixture.runtimeAttemptId },
        }),
      ).resolves.toBe(1);
    } finally {
      releaseLock.resolve();
      await Promise.all([
        firstClient.$disconnect(),
        secondClient.$disconnect(),
      ]);
    }
  }, 120_000);
});

function transactionFacade(
  client: PrismaClient,
  hooks: {
    beforeBudgetLock?: () => void | Promise<void>;
    afterBudgetLock?: () => void | Promise<void>;
  },
) {
  return {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => {
        const queryRaw = tx.$queryRaw.bind(tx) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return callback({
          knowledgeToolBudget: tx.knowledgeToolBudget,
          $queryRaw: async (...args: unknown[]) => {
            await hooks.beforeBudgetLock?.();
            const result = await queryRaw(...args);
            await hooks.afterBudgetLock?.();
            return result;
          },
          knowledgeToolGrant: tx.knowledgeToolGrant,
        } as never);
      }),
  };
}

async function seedIssuerFixture(db: PrismaClient, createBudget = true) {
  const suffix = randomUUID().replaceAll("-", "");
  const ids = {
    principalId: `principal_${suffix}`,
    workspaceId: `workspace_${suffix}`,
    projectId: `project_${suffix}`,
    threadId: `thread_${suffix}`,
    bindingId: `binding_${suffix}`,
    runId: `run_${suffix}`,
    runtimeAttemptId: `attempt_${suffix}`,
    releaseId: `release_${suffix}`,
    profileId: `profile_${suffix}`,
    retrievalProfileId: `retrieval_${suffix}`,
  };
  await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: {
        id: ids.principalId,
        issuer: `grant-${suffix}`,
        subject: ids.principalId,
      },
    });
    await tx.knowledgeProfileOperatorEvent.create({
      data: {
        principalId: ids.principalId,
        action: "grant",
        authorizedBy: "knowledge-tool-grant.postgres.fixture",
        changeReference: `knowledge-grant/${suffix}`,
      },
    });
    await tx.workspace.create({
      data: {
        id: ids.workspaceId,
        slug: `grant-${suffix}`,
        name: "Knowledge grant concurrency",
        createdById: ids.principalId,
      },
    });
    await tx.workspaceMember.create({
      data: {
        workspaceId: ids.workspaceId,
        principalId: ids.principalId,
        role: "owner",
      },
    });
    await tx.project.create({
      data: {
        id: ids.projectId,
        workspaceId: ids.workspaceId,
        createdById: ids.principalId,
        title: "Knowledge grant concurrency",
      },
    });
    await tx.projectMember.create({
      data: {
        projectId: ids.projectId,
        workspaceId: ids.workspaceId,
        principalId: ids.principalId,
        role: "owner",
      },
    });

    const profile = parseEmbeddingProfileV1(embeddingSpec(ids.profileId));
    await tx.embeddingProfile.create({
      data: {
        id: profile.spec.id,
        spec: profile.spec as unknown as Prisma.InputJsonValue,
        specSha256: profile.specSha256,
        dimension: profile.dimension,
      },
    });
    await tx.embeddingProfile.update({
      where: { id: ids.profileId },
      data: { status: "poc" },
    });
    await tx.embeddingProfile.update({
      where: { id: ids.profileId },
      data: { status: "adopted" },
    });
    await tx.knowledgeProfileAdoptionReceipt.create({
      data: {
        id: `embedding_adoption_${suffix}`,
        profileKind: "embedding",
        embeddingProfileId: profile.spec.id,
        embeddingProfileSpecSha256: profile.specSha256,
        actorPrincipalId: ids.principalId,
      },
    });
    const retrievalProfile = parseRetrievalProfileV1(
      retrievalSpec(
        ids.retrievalProfileId,
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
        id: `retrieval_adoption_${suffix}`,
        profileKind: "retrieval",
        retrievalProfileId: retrievalProfile.spec.id,
        retrievalProfileSpecSha256: retrievalProfile.specSha256,
        actorPrincipalId: ids.principalId,
      },
    });
    const manifest = {
      schema: "workbench.knowledge-release.v1",
      releaseKey: ids.releaseId,
      profile: {
        embedding: { id: profile.spec.id, specSha256: profile.specSha256 },
        retrieval: {
          id: retrievalProfile.spec.id,
          specSha256: retrievalProfile.specSha256,
        },
        segmenter: segmenterManifestPin,
      },
    };
    await tx.knowledgeRelease.create({
      data: {
        id: ids.releaseId,
        key: ids.releaseId,
        workspaceId: ids.workspaceId,
        version: 1,
        status: "ready",
        embeddingProfileId: ids.profileId,
        embeddingProfileSpecSha256: profile.specSha256,
        embeddingDimension: profile.dimension,
        retrievalProfileId: retrievalProfile.spec.id,
        retrievalProfileSpecSha256: retrievalProfile.specSha256,
        manifest: manifest as Prisma.InputJsonValue,
        manifestSha256: canonicalSha256(manifest as JsonValue),
        chunksReadyAt: new Date(),
        readyAt: new Date(),
      },
    });
    await tx.thread.create({
      data: {
        id: ids.threadId,
        projectId: ids.projectId,
        createdById: ids.principalId,
        title: "Knowledge grant concurrency",
      },
    });
    await tx.runtimeBinding.create({
      data: {
        id: ids.bindingId,
        threadId: ids.threadId,
        adapter: "deerflow",
        externalThreadId: `external_${suffix}`,
        metadata: {
          workbenchProjectId: ids.projectId,
          workbenchThreadId: ids.threadId,
          workbenchPrincipalId: ids.principalId,
        },
      },
    });
    await tx.run.create({
      data: {
        id: ids.runId,
        projectId: ids.projectId,
        threadId: ids.threadId,
        createdById: ids.principalId,
        knowledgeReleaseId: ids.releaseId,
        idempotencyKey: `grant-${suffix}`,
        requestHash: "a".repeat(64),
        requestId: `request_${suffix}`,
        request: {
          prompt: "Knowledge grant concurrency",
          modelId: "test-model",
          workflow: "generate",
          targetSurface: "app",
          designStyle: { kind: "automatic" },
          sourceIds: [],
          requestedArtifactKinds: [],
        },
        modelId: "test-model",
        traceId: `trace_${suffix}`,
        status: "running",
        attempt: 1,
        startedAt: new Date(),
      },
    });
    await tx.runtimeAttempt.create({
      data: {
        id: ids.runtimeAttemptId,
        runId: ids.runId,
        runtimeBindingId: ids.bindingId,
        attempt: 1,
        adapter: "deerflow",
        externalThreadId: `external_${suffix}`,
      },
    });
    if (createBudget) {
      const now = new Date();
      await tx.knowledgeToolBudget.create({
        data: {
          runtimeAttemptId: ids.runtimeAttemptId,
          ...knowledgeToolBudgetPolicy,
          windowStartedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  });
  return ids;
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

const segmenterIdentity = {
  implementationId: knowledgeSegmenterId,
  version: knowledgeSegmenterVersion,
  artifactSha256: knowledgeDefaultDictionaryChecksum,
  algorithm: "cut_for_search" as const,
  hmm: false as const,
  dictionarySha256: knowledgeDefaultDictionaryChecksum,
  stopwordsSha256: knowledgeStopwordsChecksum([]),
};

const segmenterManifestPin = {
  id: segmenterIdentity.implementationId,
  version: segmenterIdentity.version,
  dictionaryChecksum: segmenterIdentity.dictionarySha256,
  stopwordsChecksum: segmenterIdentity.stopwordsSha256,
};

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
    segmenter: { ...segmenterIdentity, normalization: "utf8-nfc-lf-v1" },
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
