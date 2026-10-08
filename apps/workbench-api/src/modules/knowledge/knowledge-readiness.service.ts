import { Injectable } from "@nestjs/common";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { JiebaQuerySegmenterAdapter } from "./jieba-query-segmenter.adapter.js";
import { assertKnowledgeReleasePins } from "./knowledge-release-pin.js";
import { KnowledgeRetrievalConfig } from "./knowledge-retrieval.config.js";
import { TeiQueryEmbeddingAdapter } from "./tei-query-embedding.adapter.js";
import { TeiRerankerAdapter } from "./tei-reranker.adapter.js";

@Injectable()
export class KnowledgeReadinessService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly config: KnowledgeRetrievalConfig,
  ) {}

  async assertReady(): Promise<void> {
    const releases = await this.db.knowledgeRelease.findMany({
      where: {
        OR: [
          { status: "ready" },
          {
            runs: {
              some: { status: { in: ["queued", "running", "waiting_input", "cancelling"] } },
            },
          },
        ],
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
      orderBy: { id: "asc" },
    });
    if (!releases.some((release) => release.status === "ready")) throw new Error("KNOWLEDGE_RELEASE_REQUIRED");
    if (!this.config.grantSecret) throw new Error("KNOWLEDGE_CAPABILITY_NOT_CONFIGURED");
    if (!this.config.providers) throw new Error("KNOWLEDGE_PROVIDERS_NOT_CONFIGURED");

    const segmenterIdentity = new JiebaQuerySegmenterAdapter().identity;
    const profiles = releases.map((release) => {
      try {
        return assertKnowledgeReleasePins(release, segmenterIdentity);
      } catch (cause) {
        throw new Error("KNOWLEDGE_RELEASE_NOT_SERVABLE", { cause });
      }
    });
    const profileKeys = new Set(profiles.map((profile) => (
      `${profile.embeddingProfile.spec.id}\0${profile.embeddingProfile.specSha256}\0${profile.embeddingProfile.dimension}`
        + `\0${profile.retrievalProfile.spec.id}\0${profile.retrievalProfile.specSha256}`
    )));
    if (profileKeys.size !== 1) throw new Error("KNOWLEDGE_READY_RELEASE_PROFILE_SET_UNSUPPORTED");

    const profile = profiles[0]!;
    const embeddingProfile = profile.embeddingProfile;
    const retrievalProfile = profile.retrievalProfile;
    if (
      embeddingProfile.spec.id !== this.config.providers.embedding.profileId
      || embeddingProfile.specSha256 !== this.config.providers.embedding.profileSpecSha256
    ) {
      throw new Error("KNOWLEDGE_EMBEDDING_PROFILE_NOT_CONFIGURED");
    }
    if (
      retrievalProfile.spec.reranker.engine.imageDigest !== this.config.providers.reranker.imageDigest
      || retrievalProfile.spec.reranker.engine.version !== this.config.providers.reranker.teiVersion
      || retrievalProfile.spec.reranker.model.id !== this.config.providers.reranker.modelId
      || retrievalProfile.spec.reranker.model.revision !== this.config.providers.reranker.modelRevision
      || retrievalProfile.spec.reranker.tokenizer.maximumInputTokens !== this.config.providers.reranker.maximumInputTokens
    ) {
      throw new Error("KNOWLEDGE_RERANKER_PROFILE_NOT_CONFIGURED");
    }

    const embedding = new TeiQueryEmbeddingAdapter(this.config.providers.embedding);
    const reranker = new TeiRerankerAdapter(this.config.providers.reranker);
    const signal = AbortSignal.timeout(this.config.readinessTimeoutMs);
    await Promise.all([
      embedding.assertReady(embeddingProfile, signal).catch((cause: unknown) => {
        throw new Error("KNOWLEDGE_EMBEDDING_PROVIDER_NOT_READY", { cause });
      }),
      reranker.assertReady(profile.policy.rerankCandidateLimit, signal).catch((cause: unknown) => {
        throw new Error("KNOWLEDGE_RERANKER_PROVIDER_NOT_READY", { cause });
      }),
    ]);
  }
}
