import { describe, expect, it, vi } from "vitest";
import { parseEmbeddingProfileV1, type CanonicalEmbeddingProfileV1 } from "@workbench/workbench-knowledge";
import { TeiEmbeddingAdapter } from "../src/knowledge/tei-embedding.adapter.js";

describe("TeiEmbeddingAdapter", () => {
  it("pins TEI model identity and embeds without provider retries", async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(json({
        model_id: "test/model",
        model_sha: "revision-1",
        version: "1.0.0",
        max_input_length: 64,
        max_batch_tokens: 64,
        max_client_batch_size: 2,
        auto_truncate: false,
      }))
      .mockResolvedValueOnce(json([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]))
      .mockResolvedValueOnce(json([[1, 0, 0], [0, 1, 0]]));
    const adapter = new TeiEmbeddingAdapter(config(), fetchImplementation as never);

    await expect(adapter.assertProfile(profile)).resolves.toBeUndefined();
    await expect(adapter.embedDocuments(profile, [
      { chunkId: "chunk-a", text: "A" },
      { chunkId: "chunk-b", text: "B" },
    ])).resolves.toEqual({
      vectors: [[1, 0, 0], [0, 1, 0]],
      tokenCounts: [2, 1],
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchImplementation.mock.calls[2]?.[1]?.body))).toMatchObject({
      dimensions: 3,
      normalize: true,
      truncate: false,
    });
  });

  it("splits provider embedding requests at the runtime-safe batch limit", async () => {
    const largeProfile = parseEmbeddingProfileV1({
      ...profile.spec,
      batch: { maximumInputs: 32, maximumTokens: 64 },
    });
    const inputs = Array.from({ length: 6 }, (_, index) => ({ chunkId: `chunk-${index}`, text: `Text ${index}` }));
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(json([[{ id: 1 }], [{ id: 1 }]]))
      .mockResolvedValueOnce(json([[{ id: 1 }], [{ id: 1 }]]))
      .mockResolvedValueOnce(json([[{ id: 1 }], [{ id: 1 }]]))
      .mockResolvedValueOnce(json(Array.from({ length: 2 }, () => [1, 0, 0])))
      .mockResolvedValueOnce(json(Array.from({ length: 2 }, () => [0, 1, 0])))
      .mockResolvedValueOnce(json(Array.from({ length: 2 }, () => [1, 0, 0])));
    const adapter = new TeiEmbeddingAdapter(config(largeProfile), fetchImplementation as never);

    await expect(adapter.embedDocuments(largeProfile, inputs)).resolves.toEqual({
      vectors: [
        ...Array.from({ length: 2 }, () => [1, 0, 0]),
        ...Array.from({ length: 2 }, () => [0, 1, 0]),
        ...Array.from({ length: 2 }, () => [1, 0, 0]),
      ],
      tokenCounts: Array.from({ length: 6 }, () => 1),
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(6);
    for (const call of fetchImplementation.mock.calls.slice(0, 6)) {
      expect(JSON.parse(String(call[1]?.body)).inputs).toHaveLength(2);
    }
  });

  it("rejects runtime identity drift before any embedding request", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(json({
      model_id: "different/model",
      model_sha: "revision-1",
      version: "1.0.0",
      max_input_length: 64,
      max_batch_tokens: 64,
      max_client_batch_size: 2,
      auto_truncate: false,
    }));
    const adapter = new TeiEmbeddingAdapter(config(), fetchImplementation as never);

    await expect(adapter.assertProfile(profile)).rejects.toMatchObject({
      name: "TerminalKnowledgeBuildError",
      code: "TEI_PROFILE_IDENTITY_MISMATCH",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("does not call the provider when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetchImplementation = vi.fn();
    const adapter = new TeiEmbeddingAdapter(config(), fetchImplementation as never);

    await expect(adapter.assertProfile(profile, controller.signal)).rejects.toMatchObject({
      name: "RetryableKnowledgeBuildError",
      code: "TEI_REQUEST_ABORTED",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong dimension", [[1, 0]], "TEI_VECTOR_DIMENSION_INVALID"],
    ["non-finite value", [[Number.NaN, 0, 0]], "TEI_VECTOR_VALUE_INVALID"],
    ["not normalized", [[2, 0, 0]], "TEI_VECTOR_NORM_INVALID"],
  ] as const)("rejects %s vector responses", async (_name, vectors, code) => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(json([[{ id: 1 }]]))
      .mockResolvedValueOnce(json(vectors));
    const adapter = new TeiEmbeddingAdapter(config(), fetchImplementation as never);

    await expect(adapter.embedDocuments(profile, [{ chunkId: "chunk-a", text: "A" }]))
      .rejects.toMatchObject({ name: "TerminalKnowledgeBuildError", code });
  });

  it("does not retry a transient provider response", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response("busy", {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    const adapter = new TeiEmbeddingAdapter(config(), fetchImplementation as never);

    await expect(adapter.embedDocuments(profile, [{ chunkId: "chunk-a", text: "A" }]))
      .rejects.toMatchObject({ name: "RetryableKnowledgeBuildError", code: "TEI_HTTP_503" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized bounded responses before parsing", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "999999",
      },
    }));
    const adapter = new TeiEmbeddingAdapter({ ...config(), maximumResponseBytes: 1_024 }, fetchImplementation as never);

    await expect(adapter.embedDocuments(profile, [{ chunkId: "chunk-a", text: "A" }]))
      .rejects.toMatchObject({ name: "TerminalKnowledgeBuildError", code: "TEI_RESPONSE_TOO_LARGE" });
  });

  it("classifies malformed UTF-8 as a terminal provider contract failure", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([0xc3, 0x28]),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const adapter = new TeiEmbeddingAdapter(config(), fetchImplementation as never);

    await expect(adapter.embedDocuments(profile, [{ chunkId: "chunk-a", text: "A" }]))
      .rejects.toMatchObject({
        name: "TerminalKnowledgeBuildError",
        code: "TEI_RESPONSE_ENCODING_INVALID",
      });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects tokenizer output over the pinned chunk budget", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(json([
      Array.from({ length: 33 }, (_, id) => ({ id })),
    ]));
    const adapter = new TeiEmbeddingAdapter(config(), fetchImplementation as never);

    await expect(adapter.embedDocuments(profile, [{ chunkId: "chunk-a", text: "A" }]))
      .rejects.toMatchObject({ name: "TerminalKnowledgeBuildError", code: "TEI_INPUT_TOKEN_LIMIT_EXCEEDED" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

const profile: CanonicalEmbeddingProfileV1 = parseEmbeddingProfileV1({
  schema: "workbench.embedding-profile.v1",
  id: "test-embedding-3-r1",
  protocol: "tei.embed.v1",
  engine: { id: "test-tei", version: "1.0.0", imageDigest: `sha256:${"1".repeat(64)}` },
  model: { id: "test/model", revision: "revision-1", artifactSha256: "2".repeat(64) },
  tokenizer: {
    id: "test/tokenizer",
    revision: "revision-1",
    artifactSha256: "3".repeat(64),
    modelMaximumTokens: 64,
    chunkMaximumTokens: 32,
    overflow: "reject",
  },
  input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" },
  output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
  batch: { maximumInputs: 2, maximumTokens: 64 },
  conformanceProbeSha256: "4".repeat(64),
});

function config(target: CanonicalEmbeddingProfileV1 = profile) {
  return {
    origin: "http://tei:8080",
    requestTimeoutMs: 1_000,
    maximumRequestBytes: 1_024 * 1_024,
    maximumResponseBytes: 1_024 * 1_024,
    imageDigest: target.spec.engine.imageDigest!,
    profileId: target.spec.id,
    profileSpecSha256: target.specSha256,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
