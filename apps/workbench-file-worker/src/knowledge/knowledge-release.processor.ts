import {
  buildKnowledgeRelease,
  type KnowledgeReleaseProfile,
  type TokenizerPort,
  type CanonicalEmbeddingProfileV1,
  type ChineseSegmenterPort,
} from "@workbench/workbench-knowledge";
import {
  asKnowledgeBuildError,
  RetryableKnowledgeBuildError,
  TerminalKnowledgeBuildError,
} from "./knowledge.errors.js";
import type { KnowledgeBuildCommand, KnowledgeBuildOutcome, KnowledgeBuildStore } from "./knowledge-build.store.js";
import type { KnowledgeEmbeddingPort } from "./embedding.port.js";
import type { KnowledgeVaultReaderPort } from "./vault-reader.port.js";

export class KnowledgeReleaseProcessor {
  constructor(
    private readonly store: KnowledgeBuildStore,
    private readonly reader: KnowledgeVaultReaderPort,
    private readonly tokenizer: TokenizerPort & {
      assertProfile(profile: CanonicalEmbeddingProfileV1): void;
    },
    private readonly segmenter: ChineseSegmenterPort,
    private readonly profile: Omit<KnowledgeReleaseProfile, "embedding" | "retrieval" | "tokenizer">,
    private readonly embedding: KnowledgeEmbeddingPort,
  ) {}

  async build(
    command: KnowledgeBuildCommand,
    signal?: AbortSignal,
  ): Promise<KnowledgeBuildOutcome> {
    try {
      this.assertRetrievalProfile(command);
      this.tokenizer.assertProfile(command.embeddingProfile);
      if (!command.chunksReady) {
        const snapshot = command.ingestion
          ? { sources: [{ path: command.ingestion.sourcePath, content: command.ingestion.markdown }], assets: [] }
          : await this.reader.readSnapshot(signal);
        throwIfAborted(signal);
        const bundle = buildKnowledgeRelease({
          releaseKey: command.releaseKey,
          releaseVersion: command.releaseVersion,
          vaultRoot: "knowledge-vault",
          sources: snapshot.sources,
          assets: snapshot.assets,
          tokenizer: this.tokenizer,
          segmenter: this.segmenter,
          profile: {
            ...this.profile,
            tokenizer: {
              id: command.embeddingProfile.spec.tokenizer.id,
              version: command.embeddingProfile.spec.tokenizer.revision,
              maximumTokens: command.embeddingProfile.spec.tokenizer.chunkMaximumTokens,
            },
            retrieval: {
              id: command.retrievalProfile.spec.id,
              specSha256: command.retrievalProfile.specSha256,
            },
            embedding: {
              id: command.embeddingProfile.spec.id,
              specSha256: command.embeddingProfile.specSha256,
            },
          },
        });
        throwIfAborted(signal);
        const staged = await this.store.stageChunks(command, bundle);
        if (staged !== "staged") return staged;
      }

      await this.embedding.assertProfile(command.embeddingProfile, signal);
      throwIfAborted(signal);
      while (true) {
        const batch = await this.store.claimNextEmbeddingBatch(command);
        if (batch === null) return this.store.finalize(command);
        if (typeof batch === "string") return batch;
        const reused = await this.store.reusableEmbeddingVectors?.(command, batch) ?? new Map<string, readonly number[]>();
        const pending = batch.inputs.filter((input) => !reused.has(input.chunkId));
        const fresh = pending.length
          ? await this.embedding.embedDocuments(command.embeddingProfile, pending, signal)
          : { vectors: [], tokenCounts: [] };
        if (fresh.vectors.length !== pending.length || fresh.tokenCounts.length !== pending.length) {
          throw new TerminalKnowledgeBuildError("TEI_BATCH_OUTPUT_COUNT_INVALID", "Embedding output count is invalid");
        }
        let next = 0;
        const result = {
          vectors: batch.inputs.map((input) => reused.get(input.chunkId) ?? fresh.vectors[next++]!),
          // Reuse consumes no provider tokens; retain batch identities and output seals.
          tokenCounts: batch.inputs.map((input) => reused.has(input.chunkId) ? 0 : fresh.tokenCounts[pending.findIndex((item) => item.chunkId === input.chunkId)]!),
        };
        throwIfAborted(signal);
        const published = await this.store.publishEmbeddingBatch(command, batch, result);
        if (published !== "published") return published;
      }
    } catch (cause) {
      if (signal?.aborted) {
        throw new RetryableKnowledgeBuildError(
          "KNOWLEDGE_RELEASE_BUILD_ABORTED",
          "Knowledge release construction was interrupted",
          { cause },
        );
      }
      throw asKnowledgeBuildError(cause);
    }
  }

  private assertRetrievalProfile(command: KnowledgeBuildCommand): void {
    const actual = this.profile.segmenter;
    const pinned = command.retrievalProfile.spec.segmenter;
    if (
      !actual
      || actual.id !== pinned.implementationId
      || actual.version !== pinned.version
      || actual.dictionaryChecksum !== pinned.artifactSha256
      || actual.dictionaryChecksum !== pinned.dictionarySha256
      || actual.stopwordsChecksum !== pinned.stopwordsSha256
      || pinned.algorithm !== "cut_for_search"
      || pinned.hmm !== false
    ) {
      throw new TerminalKnowledgeBuildError(
        "KNOWLEDGE_RETRIEVAL_PROFILE_SEGMENTER_MISMATCH",
        "Knowledge release retrieval profile does not match the build segmenter",
      );
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("KNOWLEDGE_RELEASE_BUILD_ABORTED");
}
