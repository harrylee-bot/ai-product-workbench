import type {
  CanonicalEmbeddingProfileV1,
  JsonValue,
  KnowledgeCitation,
  KnowledgeRetrievalMode,
  KnowledgeRetrievalRouteScope,
  QueryableKnowledgeRoute,
} from "@workbench/workbench-knowledge";

export type KnowledgeReleasePin = {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly workspaceId: string | null;
  readonly status: "ready" | "retired";
  readonly embeddingProfileId: string;
  readonly embeddingProfileSpecSha256: string;
  readonly embeddingDimension: number;
  readonly retrievalProfileId: string;
  readonly retrievalProfileSpecSha256: string;
  readonly chunksReadyAt: Date | null;
  readonly readyAt: Date | null;
  readonly manifest: JsonValue;
  readonly manifestSha256: string;
  readonly embeddingProfile: {
    readonly id: string;
    readonly spec: unknown;
    readonly specSha256: string;
    readonly dimension: number;
    readonly status: "adopted" | "retired";
  };
  readonly retrievalProfile: {
    readonly id: string;
    readonly spec: unknown;
    readonly specSha256: string;
    readonly embeddingProfileId: string;
    readonly embeddingProfileSpecSha256: string;
    readonly embeddingDimension: number;
    readonly status: "candidate" | "poc" | "adopted" | "retired";
  };
};

export type KnowledgeRetrievalCandidate = {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourcePath: string;
  readonly sourceLocator: string | null;
  readonly title: string;
  readonly route: QueryableKnowledgeRoute;
  readonly headingPath: readonly string[];
  readonly chunkSequence: number;
  readonly content: string;
  readonly lexicalScore: number | null;
  readonly denseScore: number | null;
};

export interface KnowledgeRetrievalStore {
  findScopedRelease(releaseId: string, workspaceId: string): Promise<KnowledgeReleasePin | null>;
  lexicalCandidates(input: {
    readonly releaseId: string;
    readonly routes: readonly QueryableKnowledgeRoute[];
    readonly queryText: string;
    readonly limit: number;
  }): Promise<readonly KnowledgeRetrievalCandidate[]>;
  denseCandidates(input: {
    readonly releaseId: string;
    readonly profileId: string;
    readonly profileSpecSha256: string;
    readonly dimension: number;
    readonly routes: readonly QueryableKnowledgeRoute[];
    readonly vector: readonly number[];
    readonly limit: number;
  }): Promise<readonly KnowledgeRetrievalCandidate[]>;
}

export interface KnowledgeQueryEmbeddingPort {
  embedQuery(
    profile: CanonicalEmbeddingProfileV1,
    text: string,
    signal?: AbortSignal,
  ): Promise<readonly number[]>;
}

export interface KnowledgeQuerySegmenterPort {
  readonly identity: {
    readonly implementationId: string;
    readonly version: string;
    readonly artifactSha256: string;
    readonly algorithm: "cut_for_search";
    readonly hmm: false;
    readonly dictionarySha256: string;
    readonly stopwordsSha256: string;
  };
  segment(text: string): readonly string[];
}

export type KnowledgeRerankInput = {
  readonly query: string;
  readonly candidates: readonly {
    readonly chunkId: string;
    readonly content: string;
  }[];
};

export type KnowledgeRerankScore = {
  readonly chunkId: string;
  readonly score: number;
};

export interface KnowledgeRerankerPort {
  readonly identity: {
    readonly id: string;
    readonly revision: string;
  };
  rerank(input: KnowledgeRerankInput, signal?: AbortSignal): Promise<readonly KnowledgeRerankScore[]>;
}

export type KnowledgeRetrievalCommand = {
  readonly principalId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly query: string;
  readonly mode: KnowledgeRetrievalMode;
  readonly routeScope: KnowledgeRetrievalRouteScope;
};

export type KnowledgeRetrievalEvidence = {
  readonly schema: "workbench.knowledge-retrieval-evidence.v1";
  readonly mode: KnowledgeRetrievalMode;
  readonly routeScope: KnowledgeRetrievalRouteScope;
  readonly release: {
    readonly id: string;
    readonly key: string;
    readonly version: number;
  };
  readonly embeddingProfile: {
    readonly id: string;
    readonly specSha256: string;
    readonly dimension: number;
  };
  readonly retrievalProfile: {
    readonly id: string;
    readonly specSha256: string;
  };
  readonly candidateCounts: {
    readonly lexical: number;
    readonly dense: number;
    readonly fused: number;
  };
  readonly fusion: {
    readonly algorithm: "rrf";
    readonly k: number;
  };
  readonly reranker:
    | { readonly status: "not_requested" }
    | { readonly status: "not_needed" }
    | { readonly status: "applied"; readonly id: string; readonly revision: string }
    | {
      readonly status: "degraded";
      readonly id: string;
      readonly revision: string;
      readonly reason: "RERANKER_REQUEST_FAILED" | "RERANKER_OUTPUT_INVALID";
    };
  readonly degraded: boolean;
};

export type KnowledgeRetrievalItem = {
  readonly rank: number;
  readonly rrfScore: number;
  readonly rerankerScore: number | null;
  readonly citation: KnowledgeCitation;
};

export type KnowledgeRetrievalResult = {
  readonly evidence: KnowledgeRetrievalEvidence;
  readonly items: readonly KnowledgeRetrievalItem[];
};

export type KnowledgeRetrievalDependencies = {
  readonly segmenter: KnowledgeQuerySegmenterPort;
  readonly queryEmbedding?: KnowledgeQueryEmbeddingPort;
  readonly reranker?: KnowledgeRerankerPort;
};

export class KnowledgeRetrievalError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: ErrorOptions,
  ) {
    super(safeDetail, options);
    this.name = "KnowledgeRetrievalError";
  }
}
