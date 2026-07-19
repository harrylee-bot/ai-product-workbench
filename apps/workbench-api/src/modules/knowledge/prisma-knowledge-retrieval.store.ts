import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import type { QueryableKnowledgeRoute } from "@workbench/workbench-knowledge";
import type {
  KnowledgeReleasePin,
  KnowledgeRetrievalCandidate,
  KnowledgeRetrievalStore,
} from "./knowledge-retrieval.types.js";

type CandidateRow = {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  sourceLocator: string | null;
  title: string;
  route: string;
  headingPath: unknown;
  chunkSequence: number;
  content: string;
  lexicalScore: number | null;
  denseScore: number | null;
};

export class PrismaKnowledgeRetrievalStore implements KnowledgeRetrievalStore {
  constructor(private readonly db: PrismaClient) {}

  async findScopedRelease(releaseId: string, workspaceId: string): Promise<KnowledgeReleasePin | null> {
    const release = await this.db.knowledgeRelease.findFirst({
      where: {
        id: releaseId,
        status: { in: ["ready", "retired"] },
        OR: [{ workspaceId }, { workspaceId: null }],
      },
      select: {
        id: true,
        key: true,
        version: true,
        workspaceId: true,
        status: true,
        embeddingProfileId: true,
        embeddingProfileSpecSha256: true,
        embeddingDimension: true,
        retrievalProfileId: true,
        retrievalProfileSpecSha256: true,
        chunksReadyAt: true,
        readyAt: true,
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
      },
    });
    if (!release) return null;
    if (!isPublishedStatus(release.status) || !isHistoricalProfileStatus(release.embeddingProfile.status)) return null;
    return release as KnowledgeReleasePin;
  }

  async lexicalCandidates(input: {
    readonly releaseId: string;
    readonly routes: readonly QueryableKnowledgeRoute[];
    readonly queryText: string;
    readonly limit: number;
  }): Promise<readonly KnowledgeRetrievalCandidate[]> {
    if (!input.queryText || input.routes.length === 0) return [];
    const rows = await this.db.$queryRaw<CandidateRow[]>(Prisma.sql`
      WITH lexical_query AS (
        SELECT plainto_tsquery('simple', ${input.queryText}) AS value
      )
      SELECT
        chunk."id" AS "chunkId",
        document."id" AS "documentId",
        document."source_path" AS "sourcePath",
        document."metadata" ->> 'sourceLocator' AS "sourceLocator",
        document."title" AS "title",
        document."route"::text AS "route",
        chunk."heading_path" AS "headingPath",
        chunk."sequence" AS "chunkSequence",
        chunk."content" AS "content",
        ts_rank_cd(chunk."search_vector", lexical_query.value, 32)::double precision AS "lexicalScore",
        NULL::double precision AS "denseScore"
      FROM public."knowledge_chunks" AS chunk
      JOIN public."knowledge_documents" AS document
        ON document."id" = chunk."document_id"
       AND document."release_id" = chunk."release_id"
      CROSS JOIN lexical_query
      WHERE chunk."release_id" = ${input.releaseId}
        AND document."route"::text IN (${Prisma.join(input.routes)})
        AND chunk."search_vector" @@ lexical_query.value
      ORDER BY
        ts_rank_cd(chunk."search_vector", lexical_query.value, 32) DESC,
        document."source_path" COLLATE "C" ASC,
        chunk."sequence" ASC,
        chunk."id" COLLATE "C" ASC
      LIMIT ${input.limit}
    `);
    return rows.map(candidateRow);
  }

  async denseCandidates(input: {
    readonly releaseId: string;
    readonly profileId: string;
    readonly profileSpecSha256: string;
    readonly dimension: number;
    readonly routes: readonly QueryableKnowledgeRoute[];
    readonly vector: readonly number[];
    readonly limit: number;
  }): Promise<readonly KnowledgeRetrievalCandidate[]> {
    if (input.routes.length === 0) return [];
    const vector = vectorLiteral(input.vector);
    const rows = await this.db.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT
        chunk."id" AS "chunkId",
        document."id" AS "documentId",
        document."source_path" AS "sourcePath",
        document."metadata" ->> 'sourceLocator' AS "sourceLocator",
        document."title" AS "title",
        document."route"::text AS "route",
        chunk."heading_path" AS "headingPath",
        chunk."sequence" AS "chunkSequence",
        chunk."content" AS "content",
        NULL::double precision AS "lexicalScore",
        (1 - (embedding."embedding" OPERATOR(public.<=>) ${vector}::public.vector))::double precision AS "denseScore"
      FROM public."knowledge_chunk_embeddings" AS embedding
      JOIN public."knowledge_chunks" AS chunk
        ON chunk."id" = embedding."chunk_id"
       AND chunk."release_id" = embedding."release_id"
      JOIN public."knowledge_documents" AS document
        ON document."id" = chunk."document_id"
       AND document."release_id" = chunk."release_id"
      WHERE embedding."release_id" = ${input.releaseId}
        AND embedding."profile_id" = ${input.profileId}
        AND embedding."profile_spec_sha256" = ${input.profileSpecSha256}
        AND embedding."dimension" = ${input.dimension}
        AND document."route"::text IN (${Prisma.join(input.routes)})
      ORDER BY
        embedding."embedding" OPERATOR(public.<=>) ${vector}::public.vector ASC,
        document."source_path" COLLATE "C" ASC,
        chunk."sequence" ASC,
        chunk."id" COLLATE "C" ASC
      LIMIT ${input.limit}
    `);
    return rows.map(candidateRow);
  }
}

function candidateRow(row: CandidateRow): KnowledgeRetrievalCandidate {
  if (!isQueryableRoute(row.route)) throw new TypeError("Knowledge query returned a non-queryable route");
  if (!Array.isArray(row.headingPath) || row.headingPath.some((heading) => typeof heading !== "string")) {
    throw new TypeError("Knowledge query returned an invalid heading path");
  }
  if (!Number.isSafeInteger(row.chunkSequence) || row.chunkSequence < 0) {
    throw new TypeError("Knowledge query returned an invalid chunk sequence");
  }
  for (const score of [row.lexicalScore, row.denseScore]) {
    if (score !== null && !Number.isFinite(score)) throw new TypeError("Knowledge query returned an invalid score");
  }
  return { ...row, route: row.route, headingPath: row.headingPath as string[] };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => String(Math.fround(value))).join(",")}]`;
}

function isPublishedStatus(value: string): value is "ready" | "retired" {
  return value === "ready" || value === "retired";
}

function isHistoricalProfileStatus(value: string): value is "adopted" | "retired" {
  return value === "adopted" || value === "retired";
}

function isQueryableRoute(value: string): value is QueryableKnowledgeRoute {
  return value === "production" || value === "source_lookup";
}
