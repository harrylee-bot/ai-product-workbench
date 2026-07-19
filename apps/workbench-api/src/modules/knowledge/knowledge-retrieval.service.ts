import {
  createKnowledgeCitation,
  reciprocalRankFusion,
  routesForKnowledgeScope,
  type CanonicalEmbeddingProfileV1,
  type CanonicalRetrievalProfileV1,
  type KnowledgeRetrievalPolicy,
  type KnowledgeRrfResult,
} from "@workbench/workbench-knowledge";
import type { AccessService } from "../access/access.service.js";
import { notFoundProblem } from "../../common/problem-details.js";
import type {
  KnowledgeRetrievalCandidate,
  KnowledgeRetrievalCommand,
  KnowledgeRetrievalDependencies,
  KnowledgeRetrievalEvidence,
  KnowledgeRetrievalItem,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalStore,
  KnowledgeRerankScore,
} from "./knowledge-retrieval.types.js";
import { KnowledgeRetrievalError } from "./knowledge-retrieval.types.js";
import { assertKnowledgeReleasePins } from "./knowledge-release-pin.js";

type ProjectAccess = Pick<AccessService, "findProject">;

export class KnowledgeRetrievalService {
  constructor(
    private readonly access: ProjectAccess,
    private readonly store: KnowledgeRetrievalStore,
    private readonly dependencies: KnowledgeRetrievalDependencies,
  ) {
  }

  async retrieve(command: KnowledgeRetrievalCommand, signal?: AbortSignal): Promise<KnowledgeRetrievalResult> {
    assertQueryMode(command.mode, command.routeScope);
    const query = normalizeQuery(command.query);
    const project = await this.access.findProject(command.principalId, command.projectId, "read");
    const release = await this.store.findScopedRelease(command.releaseId, project.workspaceId);
    if (!release) throw notFoundProblem("Knowledge release");
    const resolved = assertKnowledgeReleasePins(release, this.dependencies.segmenter.identity);
    const { embeddingProfile, retrievalProfile, policy } = resolved;
    const routes = routesForKnowledgeScope(command.routeScope);
    const queryLexemes = this.dependencies.segmenter.segment(query)
      .map((lexeme) => lexeme.trim().normalize("NFC"))
      .filter(Boolean);
    const lexical = await this.store.lexicalCandidates({
      releaseId: release.id,
      routes,
      queryText: queryLexemes.join(" "),
      limit: policy.lexicalCandidateLimit,
    });

    let dense: readonly KnowledgeRetrievalCandidate[] = [];
    if (command.mode === "hybrid") {
      const queryEmbedding = this.dependencies.queryEmbedding;
      if (!queryEmbedding) {
        throw new KnowledgeRetrievalError(
          "KNOWLEDGE_QUERY_EMBEDDING_NOT_CONFIGURED",
          "Hybrid Knowledge retrieval is not configured",
        );
      }
      let vector: readonly number[];
      try {
        vector = await queryEmbedding.embedQuery(
          embeddingProfile,
          queryEmbeddingInput(embeddingProfile, query),
          signal,
        );
      } catch (cause) {
        throw new KnowledgeRetrievalError(
          "KNOWLEDGE_QUERY_EMBEDDING_FAILED",
          "Hybrid Knowledge retrieval is temporarily unavailable",
          { cause },
        );
      }
      assertQueryVector(vector, embeddingProfile.dimension);
      dense = await this.store.denseCandidates({
        releaseId: release.id,
        profileId: embeddingProfile.spec.id,
        profileSpecSha256: embeddingProfile.specSha256,
        dimension: embeddingProfile.dimension,
        routes,
        vector,
      limit: policy.denseCandidateLimit,
      });
    }

    const fused = reciprocalRankFusion(
      lexical.map((candidate) => ({ id: candidate.chunkId })),
      dense.map((candidate) => ({ id: candidate.chunkId })),
      policy.reciprocalRankK,
    );
    const candidates = mergeCandidates(lexical, dense);
    const reranked = await this.rerank(
      command.mode,
      query,
      fused,
      candidates,
      retrievalProfile,
      policy,
      signal,
    );
    const releaseEvidence = { id: release.id, key: release.key, version: release.version };
    const profileEvidence = {
      id: embeddingProfile.spec.id,
      specSha256: embeddingProfile.specSha256,
      dimension: embeddingProfile.dimension,
    };
    const retrievalProfileEvidence = {
      id: retrievalProfile.spec.id,
      specSha256: retrievalProfile.specSha256,
    };
    const selected = reranked.ranking.slice(0, policy.finalResultLimit);
    const items: KnowledgeRetrievalItem[] = selected.map((ranked, index) => {
      const candidate = candidates.get(ranked.id);
      if (!candidate) throw integrityError("Fused candidate metadata is missing");
      return {
        rank: index + 1,
        rrfScore: ranked.rrf.score,
        rerankerScore: ranked.rerankerScore,
        citation: createKnowledgeCitation({
          release: releaseEvidence,
          embeddingProfile: profileEvidence,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          sourcePath: candidate.sourcePath,
          ...(candidate.sourceLocator ? { sourceLocator: candidate.sourceLocator } : {}),
          title: candidate.title,
          route: candidate.route,
          headingPath: candidate.headingPath,
          chunkSequence: candidate.chunkSequence,
          content: candidate.content,
        }),
      };
    });
    const evidence: KnowledgeRetrievalEvidence = {
      schema: "workbench.knowledge-retrieval-evidence.v1",
      mode: command.mode,
      routeScope: command.routeScope,
      release: releaseEvidence,
      embeddingProfile: profileEvidence,
      retrievalProfile: retrievalProfileEvidence,
      candidateCounts: { lexical: lexical.length, dense: dense.length, fused: fused.length },
      fusion: { algorithm: "rrf", k: policy.reciprocalRankK },
      reranker: reranked.evidence,
      degraded: reranked.evidence.status === "degraded",
    };
    return { evidence, items };
  }

  private async rerank(
    mode: KnowledgeRetrievalCommand["mode"],
    query: string,
    fused: readonly KnowledgeRrfResult[],
    candidates: ReadonlyMap<string, KnowledgeRetrievalCandidate>,
    retrievalProfile: CanonicalRetrievalProfileV1,
    policy: KnowledgeRetrievalPolicy,
    signal?: AbortSignal,
  ): Promise<{
    ranking: readonly RankedCandidate[];
    evidence: KnowledgeRetrievalEvidence["reranker"];
  }> {
    const baseline = fused.slice(0, policy.rerankCandidateLimit).map((rrf) => ({
      id: rrf.id,
      rrf,
      rerankerScore: null,
    }));
    if (mode === "lexical") return { ranking: baseline, evidence: { status: "not_requested" } };
    if (baseline.length === 0) return { ranking: baseline, evidence: { status: "not_needed" } };
    const reranker = this.dependencies.reranker;
    if (!reranker) {
      throw new KnowledgeRetrievalError(
        "KNOWLEDGE_RERANKER_NOT_CONFIGURED",
        "Hybrid Knowledge retrieval reranker is not configured",
      );
    }
    if (
      reranker.identity.id !== retrievalProfile.spec.reranker.model.id
      || reranker.identity.revision !== retrievalProfile.spec.reranker.model.revision
    ) {
      throw integrityError("Pinned retrieval profile does not match the configured reranker");
    }

    const rerankInput = baseline.map((candidate) => {
      const metadata = candidates.get(candidate.id);
      if (!metadata) throw integrityError("Rerank candidate metadata is missing");
      return { chunkId: candidate.id, content: metadata.content };
    });
    let scores: readonly KnowledgeRerankScore[];
    try {
      scores = await reranker.rerank({
        query,
        candidates: rerankInput,
      }, signal);
    } catch {
      return {
        ranking: baseline,
        evidence: {
          status: "degraded",
          ...reranker.identity,
          reason: "RERANKER_REQUEST_FAILED",
        },
      };
    }
    const scoreMap = validRerankerScores(scores, baseline.map((candidate) => candidate.id));
    if (!scoreMap) {
      return {
        ranking: baseline,
        evidence: {
          status: "degraded",
          ...reranker.identity,
          reason: "RERANKER_OUTPUT_INVALID",
        },
      };
    }
    const ranking = baseline.map((candidate) => ({
      ...candidate,
      rerankerScore: scoreMap.get(candidate.id)!,
    })).sort((left, right) => (
      right.rerankerScore - left.rerankerScore
      || fusedRank(left.rrf, right.rrf)
    ));
    return { ranking, evidence: { status: "applied", ...reranker.identity } };
  }
}

type RankedCandidate = {
  readonly id: string;
  readonly rrf: KnowledgeRrfResult;
  readonly rerankerScore: number | null;
};

function mergeCandidates(
  lexical: readonly KnowledgeRetrievalCandidate[],
  dense: readonly KnowledgeRetrievalCandidate[],
): ReadonlyMap<string, KnowledgeRetrievalCandidate> {
  const merged = new Map<string, KnowledgeRetrievalCandidate>();
  for (const candidate of [...lexical, ...dense]) {
    const current = merged.get(candidate.chunkId);
    if (current && candidateIdentity(current) !== candidateIdentity(candidate)) {
      throw integrityError("Candidate identity changed between retrieval lists");
    }
    if (!current) merged.set(candidate.chunkId, candidate);
  }
  return merged;
}

function candidateIdentity(candidate: KnowledgeRetrievalCandidate): string {
  return JSON.stringify([
    candidate.documentId,
    candidate.sourcePath,
    candidate.sourceLocator,
    candidate.title,
    candidate.route,
    candidate.headingPath,
    candidate.chunkSequence,
    candidate.content,
  ]);
}

function validRerankerScores(
  scores: readonly KnowledgeRerankScore[],
  expectedIds: readonly string[],
): ReadonlyMap<string, number> | null {
  if (scores.length !== expectedIds.length) return null;
  const expected = new Set(expectedIds);
  const result = new Map<string, number>();
  for (const item of scores) {
    if (!expected.has(item.chunkId) || result.has(item.chunkId) || !Number.isFinite(item.score)) return null;
    result.set(item.chunkId, item.score);
  }
  return result.size === expected.size ? result : null;
}

function fusedRank(left: KnowledgeRrfResult, right: KnowledgeRrfResult): number {
  return right.score - left.score
    || left.bestRank - right.bestRank
    || nullableRank(left.lexicalRank) - nullableRank(right.lexicalRank)
    || nullableRank(left.denseRank) - nullableRank(right.denseRank)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function nullableRank(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

function queryEmbeddingInput(profile: CanonicalEmbeddingProfileV1, query: string): string {
  return `${profile.spec.input.queryPrefix}${query.replace(/\r\n?/gu, "\n").normalize("NFC")}`.normalize("NFC");
}

function assertQueryVector(vector: readonly number[], dimension: number): void {
  if (vector.length !== dimension || vector.some((value) => !Number.isFinite(value))) {
    throw new KnowledgeRetrievalError(
      "KNOWLEDGE_QUERY_EMBEDDING_INVALID",
      "Hybrid Knowledge retrieval returned an invalid query vector",
    );
  }
  const normalized = vector.map(Math.fround);
  const norm = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.001) {
    throw new KnowledgeRetrievalError(
      "KNOWLEDGE_QUERY_EMBEDDING_INVALID",
      "Hybrid Knowledge retrieval returned a non-normalized query vector",
    );
  }
}

function normalizeQuery(value: string): string {
  if (typeof value !== "string") throw new KnowledgeRetrievalError("KNOWLEDGE_QUERY_INVALID", "Knowledge query is invalid");
  const normalized = value.replace(/\r\n?/gu, "\n").trim().normalize("NFC");
  if (!normalized || normalized.length > 4_000 || normalized.includes("\0")) {
    throw new KnowledgeRetrievalError("KNOWLEDGE_QUERY_INVALID", "Knowledge query is invalid");
  }
  return normalized;
}

function assertQueryMode(mode: string, routeScope: string): void {
  if ((mode !== "lexical" && mode !== "hybrid")
    || (routeScope !== "production" && routeScope !== "source_lookup")) {
    throw new KnowledgeRetrievalError("KNOWLEDGE_QUERY_INVALID", "Knowledge query mode or route scope is invalid");
  }
}

function integrityError(detail: string): KnowledgeRetrievalError {
  return new KnowledgeRetrievalError("KNOWLEDGE_RETRIEVAL_INTEGRITY_ERROR", detail);
}
