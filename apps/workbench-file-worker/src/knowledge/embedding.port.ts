import type { CanonicalEmbeddingProfileV1 } from "@workbench/workbench-knowledge";

export type KnowledgeEmbeddingInput = {
  readonly chunkId: string;
  readonly text: string;
};

export type KnowledgeEmbeddingResult = {
  readonly vectors: readonly (readonly number[])[];
  readonly tokenCounts: readonly number[];
};

export interface KnowledgeEmbeddingPort {
  assertProfile(profile: CanonicalEmbeddingProfileV1, signal?: AbortSignal): Promise<void>;
  embedDocuments(
    profile: CanonicalEmbeddingProfileV1,
    inputs: readonly KnowledgeEmbeddingInput[],
    signal?: AbortSignal,
  ): Promise<KnowledgeEmbeddingResult>;
}
