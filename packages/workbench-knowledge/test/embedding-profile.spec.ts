import { describe, expect, it } from "vitest";

import {
  EmbeddingProfileContractError,
  parseEmbeddingProfileV1,
  type EmbeddingProfileV1,
} from "../src/index.js";

describe("EmbeddingProfile v1", () => {
  it("canonicalizes and hashes a fully pinned profile", () => {
    const parsed = parseEmbeddingProfileV1(profile());

    expect(parsed.spec.id).toBe("qwen3-embedding-0.6b-1024-r1");
    expect(parsed.dimension).toBe(1024);
    expect(parsed.specSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.parse(parsed.canonicalJson)).toEqual(parsed.spec);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.spec.model)).toBe(true);
  });

  it("produces the same identity regardless of input property order", () => {
    const original = profile();
    const reordered = {
      conformanceProbeSha256: original.conformanceProbeSha256,
      batch: original.batch,
      output: original.output,
      input: original.input,
      tokenizer: original.tokenizer,
      model: original.model,
      engine: original.engine,
      protocol: original.protocol,
      id: original.id,
      schema: original.schema,
    };

    expect(parseEmbeddingProfileV1(reordered).specSha256).toBe(
      parseEmbeddingProfileV1(original).specSha256,
    );
  });

  it.each([
    ["mutable model revision", { model: { revision: "latest" } }, "$.model.revision"],
    ["dimension outside pgvector v1 bound", { output: { dimension: 16_001 } }, "$.output.dimension"],
    ["chunk budget beyond model", { tokenizer: { chunkMaximumTokens: 32_769 } }, "$.tokenizer.chunkMaximumTokens"],
    ["batch smaller than one chunk", { batch: { maximumTokens: 1 } }, "$.batch.maximumTokens"],
    ["missing TEI image digest", { engine: { imageDigest: undefined } }, "$.engine.imageDigest"],
    ["unverified image tag", { engine: { imageDigest: "latest" } }, "$.engine.imageDigest"],
    ["unknown semantic field", { extra: true }, "$.extra"],
  ] as const)("rejects %s", (_name, change, expectedPath) => {
    const candidate = merge(profile(), change);
    expect(() => parseEmbeddingProfileV1(candidate)).toThrow(EmbeddingProfileContractError);
    expect(() => parseEmbeddingProfileV1(candidate)).toThrow(expectedPath);
  });

  it("allows a managed OpenAI embedding engine without a container image digest", () => {
    const candidate = {
      ...profile(),
      protocol: "openai.embeddings.v1" as const,
      engine: { id: "openai", version: "2026-07-01" },
    };

    expect(parseEmbeddingProfileV1(candidate).spec.engine).toEqual({
      id: "openai",
      version: "2026-07-01",
    });
  });
});

function profile(): EmbeddingProfileV1 {
  return {
    schema: "workbench.embedding-profile.v1",
    id: "qwen3-embedding-0.6b-1024-r1",
    protocol: "tei.embed.v1",
    engine: {
      id: "huggingface/text-embeddings-inference",
      version: "1.8.3",
      imageDigest: `sha256:${"1".repeat(64)}`,
    },
    model: {
      id: "Qwen/Qwen3-Embedding-0.6B",
      revision: "2f3f769",
      artifactSha256: "2".repeat(64),
    },
    tokenizer: {
      id: "Qwen/Qwen3-Embedding-0.6B",
      revision: "2f3f769",
      artifactSha256: "3".repeat(64),
      modelMaximumTokens: 32_768,
      chunkMaximumTokens: 800,
      overflow: "reject",
    },
    input: {
      queryPrefix: "Instruct: retrieve relevant product knowledge\nQuery: ",
      documentPrefix: "",
      normalization: "utf8-nfc-lf-v1",
    },
    output: {
      dimension: 1024,
      dtype: "float32",
      pooling: "last_token",
      normalization: "l2",
      distance: "cosine",
    },
    batch: {
      maximumInputs: 32,
      maximumTokens: 16_384,
    },
    conformanceProbeSha256: "4".repeat(64),
  };
}

function merge(base: EmbeddingProfileV1, change: Readonly<Record<string, unknown>>): unknown {
  const result = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(change)) {
    if (
      key in result
      && typeof result[key] === "object"
      && result[key] !== null
      && typeof value === "object"
      && value !== null
      && !Array.isArray(value)
    ) {
      result[key] = { ...(result[key] as Record<string, unknown>), ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}
