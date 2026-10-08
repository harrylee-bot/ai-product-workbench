import type { KnowledgeReleaseBundle } from "@workbench/workbench-knowledge";
import type {
  CanonicalEmbeddingProfileV1,
  CanonicalRetrievalProfileV1,
} from "@workbench/workbench-knowledge";
import type { RetryableKnowledgeBuildError, TerminalKnowledgeBuildError } from "./knowledge.errors.js";
import type { KnowledgeEmbeddingInput, KnowledgeEmbeddingResult } from "./embedding.port.js";

export type KnowledgeBuildOutcome = "ready" | "failed" | "missing" | "busy";

export type KnowledgeBuildDelivery = {
  queueJobId: string;
  retryCount: number;
  retryLimit: number;
};

export type KnowledgeBuildCommand = {
  releaseId: string;
  releaseKey: string;
  releaseVersion: number;
  leaseToken: string;
  chunksReady: boolean;
  ingestion?: { parentReleaseId: string; sourcePath: string; markdown: string; checksum: string; artifactVersionId: string; artifactChecksum: string };
  embeddingProfile: CanonicalEmbeddingProfileV1;
  retrievalProfile: CanonicalRetrievalProfileV1;
  delivery: KnowledgeBuildDelivery;
};

export type KnowledgeEmbeddingBatchWork = {
  readonly batchId: string;
  readonly sequence: number;
  readonly inputSha256: string;
  readonly inputs: readonly KnowledgeEmbeddingInput[];
};

export type KnowledgeBuildStart =
  | { kind: "run"; command: KnowledgeBuildCommand }
  | { kind: "terminal"; outcome: Exclude<KnowledgeBuildOutcome, "busy"> }
  | { kind: "busy" };

export type KnowledgeBuildReconciliationCandidate = {
  releaseId: string;
  attemptCount: number;
};

export interface KnowledgeBuildStore {
  beginDelivery(
    releaseId: string,
    delivery: KnowledgeBuildDelivery,
    maximumAttempts: number,
    leaseMs: number,
  ): Promise<KnowledgeBuildStart>;
  touchLease(command: KnowledgeBuildCommand, leaseMs: number): Promise<void>;
  stageChunks(
    command: KnowledgeBuildCommand,
    bundle: KnowledgeReleaseBundle,
  ): Promise<KnowledgeBuildOutcome | "staged">;
  claimNextEmbeddingBatch(
    command: KnowledgeBuildCommand,
  ): Promise<KnowledgeEmbeddingBatchWork | KnowledgeBuildOutcome | null>;
  publishEmbeddingBatch(
    command: KnowledgeBuildCommand,
    batch: KnowledgeEmbeddingBatchWork,
    result: KnowledgeEmbeddingResult,
  ): Promise<KnowledgeBuildOutcome | "published">;
  finalize(command: KnowledgeBuildCommand): Promise<KnowledgeBuildOutcome>;
  fail(
    command: KnowledgeBuildCommand,
    error: TerminalKnowledgeBuildError,
  ): Promise<KnowledgeBuildOutcome>;
  recordRetryableFailure(
    command: KnowledgeBuildCommand,
    error: RetryableKnowledgeBuildError,
    exhausted: boolean,
  ): Promise<KnowledgeBuildOutcome | null>;
  exhaust(releaseId: string, code: string): Promise<KnowledgeBuildOutcome>;
  findReconciliationCandidates(
    before: Date,
    limit: number,
  ): Promise<readonly KnowledgeBuildReconciliationCandidate[]>;
}
