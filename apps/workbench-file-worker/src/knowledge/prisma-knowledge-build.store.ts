import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  canonicalSha256,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
  type CanonicalEmbeddingProfileV1,
  type CanonicalRetrievalProfileV1,
  type JsonValue,
  type KnowledgeReleaseBundle,
} from "@workbench/workbench-knowledge";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import {
  documentEmbeddingInput,
  embeddingBatchInputSha256,
  embeddingBatchOutputSha256,
  embeddingVectorSha256,
  vectorLiteral,
} from "./embedding-input.js";
import { RetryableKnowledgeBuildError, TerminalKnowledgeBuildError } from "./knowledge.errors.js";
import type {
  KnowledgeBuildCommand,
  KnowledgeBuildDelivery,
  KnowledgeBuildOutcome,
  KnowledgeBuildReconciliationCandidate,
  KnowledgeBuildStart,
  KnowledgeBuildStore,
  KnowledgeEmbeddingBatchWork,
} from "./knowledge-build.store.js";
import type { KnowledgeEmbeddingResult } from "./embedding.port.js";

const releaseSelect = {
  id: true,
  key: true,
  version: true,
  status: true,
  parentReleaseId: true,
  ingestionJobId: true,
  ingestionJob: { include: { finalization: true } },
  embeddingProfileId: true,
  embeddingProfileSpecSha256: true,
  embeddingDimension: true,
  retrievalProfileId: true,
  retrievalProfileSpecSha256: true,
  buildAttempt: true,
  leaseToken: true,
  leaseExpiresAt: true,
  startedAt: true,
  chunksReadyAt: true,
  manifest: true,
  manifestSha256: true,
  embeddingProfile: {
    select: {
      id: true,
      spec: true,
      specSha256: true,
      dimension: true,
      status: true,
    },
  },
  retrievalProfile: {
    select: {
      id: true,
      spec: true,
      specSha256: true,
      embeddingProfileId: true,
      embeddingProfileSpecSha256: true,
      embeddingDimension: true,
      status: true,
    },
  },
} as const satisfies Prisma.KnowledgeReleaseSelect;

const batchSelect = {
  id: true,
  releaseId: true,
  profileId: true,
  profileSpecSha256: true,
  dimension: true,
  sequence: true,
  chunkIds: true,
  inputCount: true,
  inputSha256: true,
  status: true,
  attemptCount: true,
  leaseToken: true,
  outputSha256: true,
} as const satisfies Prisma.KnowledgeEmbeddingBatchSelect;

type ReleaseRow = Prisma.KnowledgeReleaseGetPayload<{ select: typeof releaseSelect }>;
type BatchRow = Prisma.KnowledgeEmbeddingBatchGetPayload<{ select: typeof batchSelect }>;

export class PrismaKnowledgeBuildStore implements KnowledgeBuildStore {
  constructor(private readonly db: PrismaClient) {}

  async beginDelivery(
    releaseId: string,
    delivery: KnowledgeBuildDelivery,
    maximumAttempts: number,
    leaseMs: number,
  ): Promise<KnowledgeBuildStart> {
    positiveInteger(maximumAttempts, "maximumAttempts");
    positiveInteger(leaseMs, "leaseMs");
    return this.db.$transaction(async (tx) => {
      await lockRelease(tx, releaseId);
      const release = await tx.knowledgeRelease.findUnique({ where: { id: releaseId }, select: releaseSelect });
      if (!release) return { kind: "terminal", outcome: "missing" };
      const terminal = terminalOutcome(release);
      if (terminal) return { kind: "terminal", outcome: terminal };
      if (release.ingestionJob) {
        const job = release.ingestionJob;
        if (job.status === "withdrawn" || job.finalization.status === "withdrawn") {
          await markFailed(tx, release, terminalFailure("KNOWLEDGE_SOURCE_WITHDRAWN"));
          return { kind: "terminal", outcome: "failed" };
        }
        if (!release.parentReleaseId || createHash("sha256").update(job.markdown).digest("hex") !== job.checksum) {
          await markFailed(tx, release, terminalFailure("KNOWLEDGE_INGESTION_SNAPSHOT_INVALID"));
          return { kind: "terminal", outcome: "failed" };
        }
        await tx.knowledgeIngestionJob.update({ where: { id: job.id }, data: { status: "converting" } });
      }
      let profiles: {
        embeddingProfile: CanonicalEmbeddingProfileV1;
        retrievalProfile: CanonicalRetrievalProfileV1;
      };
      try {
        profiles = pinnedProfiles(release);
      } catch (cause) {
        if (!(cause instanceof TerminalKnowledgeBuildError)) throw cause;
        await markFailed(tx, release, terminalFailure(cause.code, cause.safeDetail));
        return { kind: "terminal", outcome: "failed" };
      }
      if (release.buildAttempt >= maximumAttempts) {
        await markFailed(tx, release, terminalFailure("KNOWLEDGE_RELEASE_ATTEMPTS_EXHAUSTED"));
        return { kind: "terminal", outcome: "failed" };
      }
      const now = new Date();
      if (release.leaseToken && release.leaseExpiresAt && release.leaseExpiresAt > now) return { kind: "busy" };
      const leaseToken = `${delivery.queueJobId}:${delivery.retryCount}:${randomUUID()}`;
      await tx.knowledgeRelease.update({
        where: { id: release.id },
        data: {
          buildAttempt: { increment: 1 },
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          startedAt: release.startedAt ?? now,
          updatedAt: now,
        },
      });
      return {
        kind: "run",
        command: {
          releaseId: release.id,
          releaseKey: release.key,
          releaseVersion: release.version,
          leaseToken,
          chunksReady: release.chunksReadyAt !== null,
          ...(release.ingestionJob && release.parentReleaseId ? { ingestion: {
            parentReleaseId: release.parentReleaseId,
            sourcePath: release.ingestionJob.sourcePath,
            markdown: release.ingestionJob.markdown,
            checksum: release.ingestionJob.checksum,
            artifactVersionId: release.ingestionJob.finalization.artifactVersionId,
            artifactChecksum: release.ingestionJob.finalization.checksum,
          } } : {}),
          ...profiles,
          delivery,
        },
      };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async touchLease(command: KnowledgeBuildCommand, leaseMs: number): Promise<void> {
    positiveInteger(leaseMs, "leaseMs");
    const result = await this.db.knowledgeRelease.updateMany({
      where: { id: command.releaseId, status: "building", leaseToken: command.leaseToken },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs), updatedAt: new Date() },
    });
    if (result.count !== 1) {
      throw new RetryableKnowledgeBuildError("KNOWLEDGE_RELEASE_LEASE_LOST", "Knowledge release lease was lost");
    }
  }

  async stageChunks(
    command: KnowledgeBuildCommand,
    bundle: KnowledgeReleaseBundle,
  ): Promise<KnowledgeBuildOutcome | "staged"> {
    validateBundle(command, bundle);
    return this.db.$transaction(async (tx) => {
      await lockRelease(tx, command.releaseId);
      const release = await tx.knowledgeRelease.findUnique({ where: { id: command.releaseId }, select: releaseSelect });
      const outcome = releaseOutcomeForCommand(release, command);
      if (outcome) {
        if (outcome === "ready") await assertStagedBundle(tx, release!, command, bundle);
        return outcome;
      }
      if (release!.chunksReadyAt) {
        await assertStagedBundle(tx, release!, command, bundle);
        return "staged";
      }

      await tx.knowledgeEmbeddingBatch.deleteMany({ where: { releaseId: command.releaseId } });
      await tx.knowledgeDocument.deleteMany({ where: { releaseId: command.releaseId } });
      const projections = new Map(bundle.projections.map((projection) => [projection.chunkId, projection]));
      const searchRows: Array<{ id: string; searchText: string }> = [];
      const embeddingRows: Array<{ id: string; content: string; tokenCount: number }> = [];

      for (const document of bundle.documents) {
        const documentChunks = bundle.chunks.filter((chunk) => chunk.sourceLocator === document.sourceLocator);
        const documentId = stableRecordId("kdoc", command.releaseId, document.sourceLocator);
        const chunkRows = documentChunks.map((chunk) => {
          const projection = projections.get(chunk.id);
          if (!projection) {
            throw new TerminalKnowledgeBuildError(
              "KNOWLEDGE_RELEASE_PROJECTION_MISSING",
              "Knowledge chunk projection is missing",
            );
          }
          const id = stableRecordId("kchunk", command.releaseId, chunk.id);
          searchRows.push({ id, searchText: projection.searchText });
          embeddingRows.push({ id, content: chunk.content, tokenCount: chunk.tokenCount });
          return {
            id,
            documentId,
            releaseId: command.releaseId,
            sequence: chunk.sequence,
            headingPath: json(chunk.headingPath),
            content: chunk.content,
            tokenCount: chunk.tokenCount,
          };
        });
        await tx.knowledgeDocument.create({
          data: {
            id: documentId,
            releaseId: command.releaseId,
            sourceKind: command.ingestion ? "artifact_version" : "vault_markdown",
            sourcePath: document.sourcePath,
            title: document.title,
            checksum: document.sourceChecksum,
            route: document.route,
            sourceBlobId: null,
            metadata: json({
              sourceLocator: document.sourceLocator,
              frontmatter: document.frontmatter ?? null,
              headings: document.headings,
              references: document.references,
              issues: document.issues,
              chunkIdentities: documentChunks.map((chunk, index) => ({
                sequence: chunk.sequence,
                stableId: chunk.id,
                databaseId: chunkRows[index]?.id ?? null,
              })),
            }),
          },
        });
        if (command.ingestion) {
          if (document.route !== "production" || !documentChunks.length) {
            throw new TerminalKnowledgeBuildError("KNOWLEDGE_INGESTION_NOT_INDEXABLE", "Finalized content produced no production knowledge chunks");
          }
          await tx.knowledgeDocumentSource.create({ data: {
            documentId, artifactVersionId: command.ingestion.artifactVersionId, checksum: command.ingestion.artifactChecksum,
          } });
        }
        if (chunkRows.length > 0) await tx.knowledgeChunk.createMany({ data: chunkRows });
      }

      for (let offset = 0; offset < searchRows.length; offset += 250) {
        const rows = searchRows.slice(offset, offset + 250);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "knowledge_chunks" AS chunk
          SET "search_vector" = to_tsvector('simple', source."search_text")
          FROM (VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(${row.id}, ${row.searchText})`))})
            AS source("id", "search_text")
          WHERE chunk."id" = source."id"
        `);
      }

      let manifest = JSON.parse(bundle.manifestCanonicalJson) as Prisma.InputJsonValue;
      let manifestSha256 = bundle.manifestChecksum;
      if (command.ingestion) {
        const parent = await tx.knowledgeRelease.findUniqueOrThrow({
          where: { id: command.ingestion.parentReleaseId },
          include: { documents: { include: { chunks: { orderBy: { sequence: "asc" } }, source: true }, orderBy: { sourcePath: "asc" } } },
        });
        if (parent.status !== "ready" || canonicalSha256(parent.manifest as JsonValue) !== parent.manifestSha256
          || parent.embeddingProfileSpecSha256 !== command.embeddingProfile.specSha256
          || parent.retrievalProfileSpecSha256 !== command.retrievalProfile.specSha256) {
          throw new TerminalKnowledgeBuildError("KNOWLEDGE_INGESTION_PARENT_INVALID", "The immutable parent knowledge release is not available");
        }
        // Copy the immutable parent, not today's filesystem: ingestion must never silently drop old sources.
        for (const document of parent.documents) {
          const documentId = stableRecordId("kdoc", command.releaseId, document.sourcePath);
          const chunkIds = new Map(document.chunks.map((chunk) => [chunk.id, stableRecordId("kchunk", command.releaseId, chunk.id)]));
          const metadata = JSON.parse(JSON.stringify(document.metadata)) as Record<string, unknown>;
          if (Array.isArray(metadata.chunkIdentities)) {
            metadata.chunkIdentities = metadata.chunkIdentities.map((identity: { databaseId: string }) => ({
              ...identity, databaseId: chunkIds.get(identity.databaseId) ?? identity.databaseId,
            }));
          }
          await tx.knowledgeDocument.create({ data: {
            id: documentId, releaseId: command.releaseId, sourceKind: document.sourceKind, sourcePath: document.sourcePath,
            title: document.title, checksum: document.checksum, route: document.route, sourceBlobId: document.sourceBlobId,
            metadata: metadata as Prisma.InputJsonValue,
          } });
          if (document.source) await tx.knowledgeDocumentSource.create({ data: {
            documentId, artifactVersionId: document.source.artifactVersionId, checksum: document.source.checksum,
          } });
          for (const chunk of document.chunks) {
            const id = chunkIds.get(chunk.id)!;
            await tx.knowledgeChunk.create({ data: {
              id, documentId, releaseId: command.releaseId, sequence: chunk.sequence, headingPath: chunk.headingPath as Prisma.InputJsonValue,
              content: chunk.content, tokenCount: chunk.tokenCount,
            } });
            await tx.$executeRaw(Prisma.sql`
              UPDATE knowledge_chunks SET search_vector = source.search_vector
              FROM knowledge_chunks source WHERE knowledge_chunks.id = ${id} AND source.id = ${chunk.id}
            `);
            embeddingRows.push({ id, content: chunk.content, tokenCount: chunk.tokenCount });
          }
        }
        const merged = mergeIngestionManifest(parent.manifest, bundle.manifest);
        manifest = JSON.parse(canonicalJson(merged as unknown as JsonValue)) as Prisma.InputJsonValue;
        manifestSha256 = canonicalSha256(merged as unknown as JsonValue);
        await tx.knowledgeIngestionJob.update({ where: { id: release!.ingestionJobId! }, data: { status: "indexing" } });
      }
      const batches = createBatches(command, embeddingRows);
      if (batches.length > 0) await tx.knowledgeEmbeddingBatch.createMany({ data: batches });
      await tx.knowledgeRelease.update({
        where: { id: command.releaseId },
        data: {
          manifest,
          manifestSha256,
          chunksReadyAt: new Date(),
          updatedAt: new Date(),
        },
      });
      return "staged";
    }, { maxWait: 10_000, timeout: 120_000 });
  }

  async claimNextEmbeddingBatch(
    command: KnowledgeBuildCommand,
  ): Promise<KnowledgeEmbeddingBatchWork | KnowledgeBuildOutcome | null> {
    return this.db.$transaction(async (tx) => {
      await lockRelease(tx, command.releaseId);
      const release = await tx.knowledgeRelease.findUnique({ where: { id: command.releaseId }, select: releaseSelect });
      const outcome = releaseOutcomeForCommand(release, command);
      if (outcome) return outcome;
      if (!release!.chunksReadyAt) {
        throw new TerminalKnowledgeBuildError("KNOWLEDGE_RELEASE_CHUNKS_NOT_READY", "Knowledge chunks are not staged");
      }
      let batch = await tx.knowledgeEmbeddingBatch.findFirst({
        where: { releaseId: command.releaseId, status: { in: ["pending", "running"] } },
        orderBy: { sequence: "asc" },
        select: batchSelect,
      });
      if (!batch) return null;
      await lockBatch(tx, batch.id);
      batch = await tx.knowledgeEmbeddingBatch.findUniqueOrThrow({ where: { id: batch.id }, select: batchSelect });
      if (batch.status === "running" && batch.leaseToken !== command.leaseToken) {
        await tx.knowledgeEmbeddingBatch.update({
          where: { id: batch.id },
          data: {
            status: "pending",
            leaseToken: null,
            queueJobId: null,
            queueRetryCount: null,
            startedAt: null,
            lastErrorCode: "KNOWLEDGE_EMBEDDING_BATCH_LEASE_RECOVERED",
            lastErrorDetail: "A stale embedding batch claim was recovered",
            lastErrorAt: new Date(),
          },
        });
        batch = { ...batch, status: "pending", leaseToken: null };
      }
      if (batch.status === "pending") {
        batch = await tx.knowledgeEmbeddingBatch.update({
          where: { id: batch.id },
          data: {
            status: "running",
            attemptCount: { increment: 1 },
            leaseToken: command.leaseToken,
            queueJobId: command.delivery.queueJobId,
            queueRetryCount: command.delivery.retryCount,
            startedAt: new Date(),
            finishedAt: null,
          },
          select: batchSelect,
        });
      }
      if (batch.status !== "running" || batch.leaseToken !== command.leaseToken) return "busy";
      return loadBatchWork(tx, command.embeddingProfile, batch);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async publishEmbeddingBatch(
    command: KnowledgeBuildCommand,
    batch: KnowledgeEmbeddingBatchWork,
    result: KnowledgeEmbeddingResult,
  ): Promise<KnowledgeBuildOutcome | "published"> {
    const rows = embeddingOutputRows(command, batch, result);
    const outputSha256 = embeddingBatchOutputSha256(command.embeddingProfile, rows);
    return this.db.$transaction(async (tx) => {
      await lockRelease(tx, command.releaseId);
      const release = await tx.knowledgeRelease.findUnique({ where: { id: command.releaseId }, select: releaseSelect });
      const outcome = releaseOutcomeForCommand(release, command);
      if (outcome) return outcome;
      await lockBatch(tx, batch.batchId);
      const stored = await tx.knowledgeEmbeddingBatch.findUnique({ where: { id: batch.batchId }, select: batchSelect });
      if (!stored) {
        throw new TerminalKnowledgeBuildError("KNOWLEDGE_EMBEDDING_BATCH_MISSING", "Embedding batch disappeared");
      }
      if (stored.status === "ready") {
        if (stored.outputSha256 !== outputSha256) batchReplayConflict();
        return "published";
      }
      if (
        stored.status !== "running"
        || stored.leaseToken !== command.leaseToken
        || stored.inputSha256 !== batch.inputSha256
      ) return "busy";

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "knowledge_chunk_embeddings" (
          "chunk_id", "release_id", "profile_id", "profile_spec_sha256",
          "dimension", "embedding", "embedding_sha256"
        ) VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(
          ${row.chunkId}, ${command.releaseId}, ${command.embeddingProfile.spec.id},
          ${command.embeddingProfile.specSha256}, ${command.embeddingProfile.dimension},
          ${row.vectorLiteral}::public.vector, ${row.embeddingSha256}
        )`))}
        ON CONFLICT ("chunk_id", "profile_id") DO NOTHING
      `);
      const persisted = await tx.$queryRaw<Array<{ chunkId: string; embeddingSha256: string }>>(Prisma.sql`
        SELECT "chunk_id" AS "chunkId", "embedding_sha256" AS "embeddingSha256"
        FROM "knowledge_chunk_embeddings"
        WHERE "release_id" = ${command.releaseId}
          AND "profile_id" = ${command.embeddingProfile.spec.id}
          AND "chunk_id" IN (${Prisma.join(rows.map((row) => row.chunkId))})
      `);
      if (
        persisted.length !== rows.length
        || rows.some((row) => persisted.find((item) => item.chunkId === row.chunkId)?.embeddingSha256 !== row.embeddingSha256)
      ) batchReplayConflict();

      await tx.knowledgeEmbeddingBatch.update({
        where: { id: batch.batchId },
        data: {
          status: "ready",
          leaseToken: null,
          tokenCount: rows.reduce((total, row) => total + row.tokenCount, 0),
          outputSha256,
          lastErrorCode: null,
          lastErrorDetail: null,
          lastErrorAt: null,
          finishedAt: new Date(),
        },
      });
      return "published";
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  async finalize(command: KnowledgeBuildCommand): Promise<KnowledgeBuildOutcome> {
    return this.db.$transaction(async (tx) => {
      await lockRelease(tx, command.releaseId);
      const release = await tx.knowledgeRelease.findUnique({ where: { id: command.releaseId }, select: releaseSelect });
      const outcome = releaseOutcomeForCommand(release, command);
      if (outcome) return outcome;
      if (release!.ingestionJobId) {
        await tx.knowledgeIngestionJob.update({ where: { id: release!.ingestionJobId }, data: { status: "publishing" } });
      }
      await tx.knowledgeRelease.update({
        where: { id: command.releaseId },
        data: {
          status: "ready",
          readyAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      });
      if (release!.ingestionJobId) {
        const job = await tx.knowledgeIngestionJob.update({ where: { id: release!.ingestionJobId }, data: { status: "published", errorCode: null } });
        await tx.artifactFinalization.update({ where: { id: job.finalizationId }, data: { status: "ingested" } });
      }
      return "ready";
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async fail(command: KnowledgeBuildCommand, error: TerminalKnowledgeBuildError): Promise<KnowledgeBuildOutcome> {
    return this.db.$transaction(async (tx) => {
      await lockRelease(tx, command.releaseId);
      const release = await tx.knowledgeRelease.findUnique({ where: { id: command.releaseId }, select: releaseSelect });
      if (!release) return "missing";
      const terminal = terminalOutcome(release);
      if (terminal) return terminal;
      if (!commandOwnsRelease(release, command)) return "busy";
      await markFailed(tx, release, terminalFailure(error.code, error.safeDetail));
      return "failed";
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async recordRetryableFailure(
    command: KnowledgeBuildCommand,
    error: RetryableKnowledgeBuildError,
    exhausted: boolean,
  ): Promise<KnowledgeBuildOutcome | null> {
    return this.db.$transaction(async (tx) => {
      await lockRelease(tx, command.releaseId);
      const release = await tx.knowledgeRelease.findUnique({ where: { id: command.releaseId }, select: releaseSelect });
      if (!release) return "missing";
      const terminal = terminalOutcome(release);
      if (terminal) return terminal;
      if (!commandOwnsRelease(release, command)) return "busy";
      if (exhausted) {
        await markFailed(tx, release, terminalFailure("KNOWLEDGE_RELEASE_RETRIES_EXHAUSTED", error.safeDetail));
        return "failed";
      }
      await resetClaimedBatches(tx, command, error);
      await tx.knowledgeRelease.update({
        where: { id: release.id },
        data: { leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() },
      });
      return null;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async exhaust(releaseId: string, code: string): Promise<KnowledgeBuildOutcome> {
    return this.db.$transaction(async (tx) => {
      await lockRelease(tx, releaseId);
      const release = await tx.knowledgeRelease.findUnique({ where: { id: releaseId }, select: releaseSelect });
      if (!release) return "missing";
      const terminal = terminalOutcome(release);
      if (terminal) return terminal;
      await markFailed(tx, release, terminalFailure(code));
      return "failed";
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async findReconciliationCandidates(
    before: Date,
    limit: number,
  ): Promise<readonly KnowledgeBuildReconciliationCandidate[]> {
    const releases = await this.db.knowledgeRelease.findMany({
      where: {
        status: "building",
        embeddingProfile: { status: "adopted" },
        retrievalProfile: { status: "adopted" },
        OR: [
          { leaseToken: null, updatedAt: { lt: before } },
          { leaseExpiresAt: { lt: new Date() } },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, buildAttempt: true },
    });
    return releases.map((release) => ({ releaseId: release.id, attemptCount: release.buildAttempt }));
  }
}

async function loadBatchWork(
  tx: Prisma.TransactionClient,
  profile: CanonicalEmbeddingProfileV1,
  batch: BatchRow,
): Promise<KnowledgeEmbeddingBatchWork> {
  const chunks = await tx.knowledgeChunk.findMany({
    where: { releaseId: batch.releaseId, id: { in: batch.chunkIds } },
    select: { id: true, content: true },
  });
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const inputs = batch.chunkIds.map((chunkId) => {
    const chunk = byId.get(chunkId);
    if (!chunk) {
      throw new TerminalKnowledgeBuildError("KNOWLEDGE_EMBEDDING_BATCH_CHUNK_MISSING", "Embedding batch chunk is missing");
    }
    return { chunkId, text: documentEmbeddingInput(profile, chunk.content) };
  });
  const inputSha256 = embeddingBatchInputSha256(profile, inputs);
  if (inputSha256 !== batch.inputSha256 || inputs.length !== batch.inputCount) {
    throw new TerminalKnowledgeBuildError("KNOWLEDGE_EMBEDDING_BATCH_INPUT_CHANGED", "Embedding batch input changed");
  }
  return { batchId: batch.id, sequence: batch.sequence, inputSha256, inputs };
}

function createBatches(
  command: KnowledgeBuildCommand,
  chunks: readonly { id: string; content: string; tokenCount: number }[],
): Prisma.KnowledgeEmbeddingBatchCreateManyInput[] {
  const groups: Array<typeof chunks[number][]> = [];
  let current: typeof chunks[number][] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    const startsNext = current.length > 0 && (
      current.length >= command.embeddingProfile.spec.batch.maximumInputs
      || currentTokens + chunk.tokenCount > command.embeddingProfile.spec.batch.maximumTokens
    );
    if (startsNext) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(chunk);
    currentTokens += chunk.tokenCount;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, sequence) => {
    const inputs = group.map((chunk) => ({
      chunkId: chunk.id,
      text: documentEmbeddingInput(command.embeddingProfile, chunk.content),
    }));
    const inputSha256 = embeddingBatchInputSha256(command.embeddingProfile, inputs);
    return {
      id: stableRecordId(
        "kembedbatch",
        command.releaseId,
        `${command.embeddingProfile.specSha256}:${sequence}:${inputSha256}`,
      ),
      releaseId: command.releaseId,
      profileId: command.embeddingProfile.spec.id,
      profileSpecSha256: command.embeddingProfile.specSha256,
      dimension: command.embeddingProfile.dimension,
      sequence,
      chunkIds: group.map((chunk) => chunk.id),
      inputCount: group.length,
      inputSha256,
    };
  });
}

function embeddingOutputRows(
  command: KnowledgeBuildCommand,
  batch: KnowledgeEmbeddingBatchWork,
  result: KnowledgeEmbeddingResult,
) {
  if (result.vectors.length !== batch.inputs.length || result.tokenCounts.length !== batch.inputs.length) {
    throw new TerminalKnowledgeBuildError("TEI_BATCH_OUTPUT_COUNT_INVALID", "Embedding output count is invalid");
  }
  return batch.inputs.map((input, index) => {
    const vector = result.vectors[index];
    const tokenCount = result.tokenCounts[index];
    if (
      !vector
      || vector.length !== command.embeddingProfile.dimension
      || vector.some((value) => !Number.isFinite(value))
      || !Number.isSafeInteger(tokenCount)
      || tokenCount! < 0
    ) {
      throw new TerminalKnowledgeBuildError("TEI_BATCH_OUTPUT_INVALID", "Embedding output is invalid");
    }
    const normalized = vector.map(Math.fround);
    const norm = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
    if (Math.abs(norm - 1) > 0.001) {
      throw new TerminalKnowledgeBuildError("TEI_VECTOR_NORM_INVALID", "Embedding vector is not L2 normalized");
    }
    return {
      chunkId: input.chunkId,
      vectorLiteral: vectorLiteral(normalized),
      embeddingSha256: embeddingVectorSha256(normalized),
      tokenCount: tokenCount!,
    };
  });
}

function pinnedProfiles(release: ReleaseRow): {
  embeddingProfile: CanonicalEmbeddingProfileV1;
  retrievalProfile: CanonicalRetrievalProfileV1;
} {
  if (release.embeddingProfile.status !== "adopted") {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_EMBEDDING_PROFILE_NOT_ADOPTED",
      "Knowledge release embedding profile is not adopted",
    );
  }
  if (release.retrievalProfile.status !== "adopted") {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_RETRIEVAL_PROFILE_NOT_ADOPTED",
      "Knowledge release retrieval profile is not adopted",
    );
  }
  let embeddingProfile: CanonicalEmbeddingProfileV1;
  let retrievalProfile: CanonicalRetrievalProfileV1;
  try {
    embeddingProfile = parseEmbeddingProfileV1(release.embeddingProfile.spec);
  } catch (cause) {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_EMBEDDING_PROFILE_INVALID",
      "Knowledge release embedding profile is invalid",
      { cause },
    );
  }
  try {
    retrievalProfile = parseRetrievalProfileV1(release.retrievalProfile.spec);
  } catch (cause) {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_RETRIEVAL_PROFILE_INVALID",
      "Knowledge release retrieval profile is invalid",
      { cause },
    );
  }
  if (
    embeddingProfile.spec.id !== release.embeddingProfileId
    || embeddingProfile.specSha256 !== release.embeddingProfileSpecSha256
    || embeddingProfile.dimension !== release.embeddingDimension
    || embeddingProfile.specSha256 !== release.embeddingProfile.specSha256
    || embeddingProfile.dimension !== release.embeddingProfile.dimension
  ) {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_EMBEDDING_PROFILE_IDENTITY_MISMATCH",
      "Knowledge release embedding profile identity is inconsistent",
    );
  }
  if (
    retrievalProfile.spec.id !== release.retrievalProfileId
    || retrievalProfile.specSha256 !== release.retrievalProfileSpecSha256
    || release.retrievalProfile.id !== release.retrievalProfileId
    || release.retrievalProfile.specSha256 !== release.retrievalProfileSpecSha256
    || retrievalProfile.embeddingProfileId !== release.embeddingProfileId
    || retrievalProfile.embeddingProfileSpecSha256 !== release.embeddingProfileSpecSha256
    || retrievalProfile.embeddingDimension !== release.embeddingDimension
    || release.retrievalProfile.embeddingProfileId !== release.embeddingProfileId
    || release.retrievalProfile.embeddingProfileSpecSha256 !== release.embeddingProfileSpecSha256
    || release.retrievalProfile.embeddingDimension !== release.embeddingDimension
  ) {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_RETRIEVAL_PROFILE_IDENTITY_MISMATCH",
      "Knowledge release retrieval profile identity is inconsistent",
    );
  }
  return { embeddingProfile, retrievalProfile };
}

function validateBundle(command: KnowledgeBuildCommand, bundle: KnowledgeReleaseBundle): void {
  if (
    bundle.manifest.releaseKey !== command.releaseKey
    || bundle.manifest.releaseVersion !== command.releaseVersion
    || bundle.manifest.profile.retrieval.id !== command.retrievalProfile.spec.id
    || bundle.manifest.profile.retrieval.specSha256 !== command.retrievalProfile.specSha256
    || bundle.manifest.profile.embedding?.id !== command.embeddingProfile.spec.id
    || bundle.manifest.profile.embedding.specSha256 !== command.embeddingProfile.specSha256
    || canonicalSha256(bundle.manifest as unknown as JsonValue) !== bundle.manifestChecksum
    || canonicalJson(bundle.manifest as unknown as JsonValue) !== bundle.manifestCanonicalJson
  ) {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_RELEASE_MANIFEST_INVALID",
      "Knowledge release bundle does not match its requested identity or embedding profile",
    );
  }
}

function mergeIngestionManifest(parentValue: Prisma.JsonValue, manifest: KnowledgeReleaseBundle["manifest"]) {
  const parent = parentValue as unknown as KnowledgeReleaseBundle["manifest"];
  return {
    ...manifest,
    documents: [...parent.documents, ...manifest.documents].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    assetClosure: parent.assetClosure,
    issues: [...parent.issues, ...manifest.issues],
  };
}

async function assertStagedBundle(
  tx: Prisma.TransactionClient,
  release: ReleaseRow,
  command: KnowledgeBuildCommand,
  bundle: KnowledgeReleaseBundle,
) {
  let checksum = bundle.manifestChecksum;
  if (command.ingestion) {
    if (release.parentReleaseId !== command.ingestion.parentReleaseId) replayConflict();
    const parent = await tx.knowledgeRelease.findUnique({
      where: { id: command.ingestion.parentReleaseId },
      select: { manifest: true, manifestSha256: true },
    });
    if (!parent || canonicalSha256(parent.manifest as JsonValue) !== parent.manifestSha256) replayConflict();
    // The published identity includes the immutable parent, not just the added document.
    checksum = canonicalSha256(mergeIngestionManifest(parent.manifest, bundle.manifest) as unknown as JsonValue);
  }
  if (release.manifestSha256 !== checksum) replayConflict();
}

function releaseOutcomeForCommand(
  release: ReleaseRow | null,
  command: KnowledgeBuildCommand,
): KnowledgeBuildOutcome | null {
  if (!release) return "missing";
  const terminal = terminalOutcome(release);
  if (terminal) return terminal;
  if (!commandOwnsRelease(release, command)) return "busy";
  return null;
}

function commandOwnsRelease(release: ReleaseRow, command: KnowledgeBuildCommand): boolean {
  return release.status === "building"
    && release.key === command.releaseKey
    && release.version === command.releaseVersion
    && release.leaseToken === command.leaseToken
    && release.embeddingProfileId === command.embeddingProfile.spec.id
    && release.embeddingProfileSpecSha256 === command.embeddingProfile.specSha256
    && release.embeddingDimension === command.embeddingProfile.dimension
    && release.retrievalProfileId === command.retrievalProfile.spec.id
    && release.retrievalProfileSpecSha256 === command.retrievalProfile.specSha256;
}

function terminalOutcome(release: ReleaseRow): Exclude<KnowledgeBuildOutcome, "missing" | "busy"> | null {
  if (release.status === "ready" || release.status === "retired") {
    assertPublishedIntegrity(release);
    return "ready";
  }
  if (release.status === "failed") return "failed";
  return null;
}

function assertPublishedIntegrity(release: ReleaseRow): void {
  if (canonicalSha256(release.manifest as unknown as JsonValue) !== release.manifestSha256) {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_RELEASE_MANIFEST_CORRUPT",
      "Published Knowledge release manifest checksum is invalid",
    );
  }
}

async function resetClaimedBatches(
  tx: Prisma.TransactionClient,
  command: KnowledgeBuildCommand,
  error: RetryableKnowledgeBuildError,
): Promise<void> {
  await tx.knowledgeEmbeddingBatch.updateMany({
    where: { releaseId: command.releaseId, status: "running", leaseToken: command.leaseToken },
    data: {
      status: "pending",
      leaseToken: null,
      queueJobId: null,
      queueRetryCount: null,
      startedAt: null,
      lastErrorCode: cleanText(error.code, 120),
      lastErrorDetail: cleanText(error.safeDetail, 2_000),
      lastErrorAt: new Date(),
    },
  });
}

async function markFailed(
  tx: Prisma.TransactionClient,
  release: ReleaseRow,
  failure: JsonValue,
): Promise<void> {
  const failureObject = typeof failure === "object" && failure !== null && !Array.isArray(failure)
    ? failure as { readonly [key: string]: JsonValue }
    : null;
  const code = failureObject
    ? String(failureObject.code ?? "KNOWLEDGE_RELEASE_FAILED")
    : "KNOWLEDGE_RELEASE_FAILED";
  const detail = failureObject
    ? String(failureObject.detail ?? "Knowledge release failed")
    : "Knowledge release failed";
  if (release.ingestionJobId && release.ingestionJob?.status !== "withdrawn") {
    await tx.knowledgeIngestionJob.update({ where: { id: release.ingestionJobId }, data: { status: "failed", errorCode: cleanText(code, 120) } });
  }
  await tx.knowledgeEmbeddingBatch.updateMany({
    where: { releaseId: release.id, status: { in: ["pending", "running"] } },
    data: {
      status: "failed",
      leaseToken: null,
      outputSha256: null,
      lastErrorCode: cleanText(code, 120),
      lastErrorDetail: cleanText(detail, 2_000),
      lastErrorAt: new Date(),
      finishedAt: new Date(),
    },
  });
  if (!release.chunksReadyAt) await tx.knowledgeDocument.deleteMany({ where: { releaseId: release.id } });
  await tx.knowledgeRelease.update({
    where: { id: release.id },
    data: {
      status: "failed",
      manifest: json(failure),
      manifestSha256: canonicalSha256(failure),
      readyAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}

async function lockRelease(tx: Prisma.TransactionClient, releaseId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "knowledge_releases" WHERE "id" = ${releaseId} FOR UPDATE`);
}

async function lockBatch(tx: Prisma.TransactionClient, batchId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "knowledge_embedding_batches" WHERE "id" = ${batchId} FOR UPDATE`);
}

function replayConflict(): never {
  throw new TerminalKnowledgeBuildError(
    "KNOWLEDGE_RELEASE_REPLAY_CONFLICT",
    "A staged Knowledge release does not match its deterministic replay",
  );
}

function batchReplayConflict(): never {
  throw new TerminalKnowledgeBuildError(
    "KNOWLEDGE_EMBEDDING_BATCH_REPLAY_CONFLICT",
    "Persisted embeddings do not match their deterministic batch replay",
  );
}

function terminalFailure(code: string, detail?: string): JsonValue {
  return {
    schema: "workbench.knowledge-release-failure.v1",
    code: cleanText(code, 120),
    detail: cleanText(detail ?? "Knowledge release construction failed", 2_000),
  };
}

function cleanText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum);
}

function stableRecordId(prefix: string, releaseId: string, stableId: string): string {
  return `${prefix}_${createHash("sha256").update(releaseId).update("\0").update(stableId).digest("hex")}`;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}
