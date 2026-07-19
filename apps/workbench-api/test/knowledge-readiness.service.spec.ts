import { ConfigService } from "@nestjs/config";
import {
  canonicalSha256,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
  type EmbeddingProfileV1,
  type JsonValue,
  type RetrievalProfileV1,
} from "@workbench/workbench-knowledge";
import { JiebaQuerySegmenterAdapter } from "../src/modules/knowledge/jieba-query-segmenter.adapter.js";
import { KnowledgeReadinessService } from "../src/modules/knowledge/knowledge-readiness.service.js";
import { KnowledgeRetrievalConfig } from "../src/modules/knowledge/knowledge-retrieval.config.js";

const profile = parseEmbeddingProfileV1(embeddingSpec());
const segmenterIdentity = new JiebaQuerySegmenterAdapter().identity;
const secret = Buffer.alloc(32, 17).toString("base64url");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KnowledgeReadinessService", () => {
  it("does not require capability or providers before a ready release exists", async () => {
    const { db, service } = createService([], {});
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    await expect(service.assertReady()).resolves.toBeUndefined();
    expect(db.knowledgeRelease.findMany).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("requires capability and providers once a ready release exists", async () => {
    await expect(createService([readyPin()], {}).service.assertReady())
      .rejects.toThrow("KNOWLEDGE_CAPABILITY_NOT_CONFIGURED");
    await expect(createService([readyPin()], {
      WORKBENCH_KNOWLEDGE_TOOL_SECRET: secret,
    }).service.assertReady()).rejects.toThrow("KNOWLEDGE_PROVIDERS_NOT_CONFIGURED");
  });

  it("accepts a ready release only when both pinned TEI identities match", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://embedding.test/info") return Response.json(embeddingInfo());
      if (url === "https://reranker.test/info") return Response.json(rerankerInfo());
      throw new Error(`Unexpected readiness request: ${url}`);
    });
    vi.stubGlobal("fetch", request);

    await expect(createService([readyPin()], fullConfig()).service.assertReady()).resolves.toBeUndefined();
    expect(request.mock.calls.map(([input]) => String(input))).toEqual([
      "https://embedding.test/info",
      "https://reranker.test/info",
    ]);
  });

  it("includes a retired release pinned by a non-terminal Run in the serviceable set", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => (
      String(input).includes("reranker") ? Response.json(rerankerInfo()) : Response.json(embeddingInfo())
    )));
    const { db, service } = createService([readyPin(embeddingSpec(), "retired")], fullConfig());

    await expect(service.assertReady()).resolves.toBeUndefined();
    expect(db.knowledgeRelease.findMany).toHaveBeenCalledWith(expect.objectContaining({
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
    }));
  });

  it.each([
    ["embedding", "https://embedding.test/info"],
    ["reranker", "https://reranker.test/info"],
  ])("reports not ready when the %s TEI identity drifts", async (provider, driftUrl) => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://embedding.test/info") {
        return Response.json({ ...embeddingInfo(), model_sha: url === driftUrl ? "drifted" : profile.spec.model.revision });
      }
      if (url === "https://reranker.test/info") {
        return Response.json({ ...rerankerInfo(), model_sha: url === driftUrl ? "drifted" : "commit-reranker-r1" });
      }
      throw new Error(`Unexpected readiness request: ${url}`);
    }));

    await expect(createService([readyPin()], fullConfig()).service.assertReady())
      .rejects.toThrow(provider === "embedding"
        ? "KNOWLEDGE_EMBEDDING_PROVIDER_NOT_READY"
        : "KNOWLEDGE_RERANKER_PROVIDER_NOT_READY");
  });

  it("rejects multiple active embedding profile pins because one provider config cannot serve both", async () => {
    await expect(createService([
      readyPin(),
      readyPin(embeddingSpec("other-profile")),
    ], fullConfig()).service.assertReady())
      .rejects.toThrow("KNOWLEDGE_READY_RELEASE_PROFILE_SET_UNSUPPORTED");
  });

  it.each([
    ["missing chunks checkpoint", (release: ReturnType<typeof readyPin>) => ({ ...release, chunksReadyAt: null })],
    ["missing ready checkpoint", (release: ReturnType<typeof readyPin>) => ({ ...release, readyAt: null })],
    ["manifest checksum drift", (release: ReturnType<typeof readyPin>) => ({ ...release, manifestSha256: "f".repeat(64) })],
    ["manifest embedding pin drift", (release: ReturnType<typeof readyPin>) => withManifest(release, {
      ...release.manifest,
      profile: {
        ...release.manifest.profile,
        embedding: { ...release.manifest.profile.embedding, id: "drifted-profile" },
      },
    })],
    ["Jieba identity drift", (release: ReturnType<typeof readyPin>) => withManifest(release, {
      ...release.manifest,
      profile: {
        ...release.manifest.profile,
        segmenter: { ...release.manifest.profile.segmenter, dictionaryChecksum: "f".repeat(64) },
      },
    })],
  ])("rejects every malformed ready release before provider probes: %s", async (_name, mutate) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const valid = readyPin();
    const malformed = mutate({ ...readyPin(), id: "release_2", version: 2 });

    await expect(createService([valid, malformed], fullConfig()).service.assertReady())
      .rejects.toThrow("KNOWLEDGE_RELEASE_NOT_SERVABLE");
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the independent bounded readiness timeout for both provider probes", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => (
      String(input).includes("reranker") ? Response.json(rerankerInfo()) : Response.json(embeddingInfo())
    )));

    await expect(createService([readyPin()], {
      ...fullConfig(),
      WORKBENCH_KNOWLEDGE_READINESS_TIMEOUT_MS: "750",
    }).service.assertReady()).resolves.toBeUndefined();
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(750);
    timeout.mockRestore();
  });
});

function createService(pins: ReturnType<typeof readyPin>[], values: Record<string, string>) {
  const db = {
    knowledgeRelease: {
      findMany: vi.fn().mockResolvedValue(pins),
    },
  };
  const config = new KnowledgeRetrievalConfig(new ConfigService(values));
  return { db, service: new KnowledgeReadinessService(db as never, config) };
}

function readyPin(
  spec: EmbeddingProfileV1 = embeddingSpec(),
  status: "ready" | "retired" = "ready",
) {
  const parsed = parseEmbeddingProfileV1(spec);
  const retrieval = parseRetrievalProfileV1(retrievalSpec(parsed));
  const manifest = {
    schema: "workbench.knowledge-release.v1" as const,
    releaseKey: "vault",
    profile: {
      embedding: { id: parsed.spec.id, specSha256: parsed.specSha256 },
      retrieval: { id: retrieval.spec.id, specSha256: retrieval.specSha256 },
      segmenter: {
        id: segmenterIdentity.implementationId,
        version: segmenterIdentity.version,
        dictionaryChecksum: segmenterIdentity.dictionarySha256,
        stopwordsChecksum: segmenterIdentity.stopwordsSha256,
      },
    },
  };
  return {
    id: "release_1",
    key: "vault",
    version: 1,
    workspaceId: "workspace_1",
    status,
    embeddingProfileId: parsed.spec.id,
    embeddingProfileSpecSha256: parsed.specSha256,
    embeddingDimension: parsed.dimension,
    retrievalProfileId: retrieval.spec.id,
    retrievalProfileSpecSha256: retrieval.specSha256,
    chunksReadyAt: new Date("2026-07-14T00:00:00Z"),
    readyAt: new Date("2026-07-14T00:01:00Z"),
    manifest,
    manifestSha256: canonicalSha256(manifest as unknown as JsonValue),
    embeddingProfile: {
      id: parsed.spec.id,
      spec,
      specSha256: parsed.specSha256,
      dimension: parsed.dimension,
      status: "adopted",
    },
    retrievalProfile: {
      id: retrieval.spec.id,
      spec: retrieval.spec,
      specSha256: retrieval.specSha256,
      embeddingProfileId: retrieval.embeddingProfileId,
      embeddingProfileSpecSha256: retrieval.embeddingProfileSpecSha256,
      embeddingDimension: retrieval.embeddingDimension,
      status: "adopted",
    },
  };
}

function withManifest(release: ReturnType<typeof readyPin>, manifest: ReturnType<typeof readyPin>["manifest"]) {
  return {
    ...release,
    manifest,
    manifestSha256: canonicalSha256(manifest as unknown as JsonValue),
  };
}

function fullConfig() {
  return {
    WORKBENCH_KNOWLEDGE_TOOL_SECRET: secret,
    WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: profile.spec.id,
    WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: profile.specSha256,
    WORKBENCH_TEI_URL: "https://embedding.test",
    WORKBENCH_TEI_IMAGE_DIGEST: profile.spec.engine.imageDigest!,
    WORKBENCH_KNOWLEDGE_RERANKER_URL: "https://reranker.test",
    WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST: `sha256:${"7".repeat(64)}`,
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID: "BAAI/bge-reranker-v2-m3",
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION: "commit-reranker-r1",
    WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION: "1.8.3",
    WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS: "512",
  };
}

function embeddingInfo() {
  return {
    model_id: profile.spec.model.id,
    model_sha: profile.spec.model.revision,
    version: profile.spec.engine.version,
    max_input_length: 512,
    max_batch_tokens: 8_192,
    max_client_batch_size: 32,
    auto_truncate: false,
  };
}

function rerankerInfo() {
  return {
    model_id: "BAAI/bge-reranker-v2-m3",
    model_sha: "commit-reranker-r1",
    version: "1.8.3",
    max_input_length: 512,
    max_batch_tokens: 8_192,
    max_client_batch_size: 24,
    auto_truncate: false,
  };
}

function embeddingSpec(id = "integration-embedding-r1"): EmbeddingProfileV1 {
  return {
    schema: "workbench.embedding-profile.v1",
    id,
    protocol: "tei.embed.v1",
    engine: {
      id: "huggingface/text-embeddings-inference",
      version: "1.8.3",
      imageDigest: `sha256:${"1".repeat(64)}`,
    },
    model: { id: "integration/model", revision: "commit-r1", artifactSha256: "2".repeat(64) },
    tokenizer: {
      id: "integration/tokenizer",
      revision: "commit-r1",
      artifactSha256: "3".repeat(64),
      modelMaximumTokens: 512,
      chunkMaximumTokens: 256,
      overflow: "reject",
    },
    input: { queryPrefix: "query:", documentPrefix: "passage:", normalization: "utf8-nfc-lf-v1" },
    output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    batch: { maximumInputs: 32, maximumTokens: 8_192 },
    conformanceProbeSha256: "4".repeat(64),
  };
}

function retrievalSpec(
  embedding = parseEmbeddingProfileV1(embeddingSpec()),
): RetrievalProfileV1 {
  return {
    schema: "workbench.retrieval-profile.v1",
    id: `${embedding.spec.id}-retrieval-r1`,
    embedding: {
      profileId: embedding.spec.id,
      profileSpecSha256: embedding.specSha256,
      dimension: embedding.dimension,
    },
    segmenter: {
      implementationId: segmenterIdentity.implementationId,
      version: segmenterIdentity.version,
      artifactSha256: segmenterIdentity.artifactSha256,
      algorithm: segmenterIdentity.algorithm,
      hmm: segmenterIdentity.hmm,
      dictionarySha256: segmenterIdentity.dictionarySha256,
      stopwordsSha256: segmenterIdentity.stopwordsSha256,
      normalization: "utf8-nfc-lf-v1",
    },
    recall: {
      lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 40 },
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
        id: "BAAI/bge-reranker-v2-m3",
        revision: "commit-reranker-r1",
        artifactSha256: "8".repeat(64),
      },
      tokenizer: {
        id: "bge-reranker-tokenizer",
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
