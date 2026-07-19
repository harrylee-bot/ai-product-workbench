import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parseEmbeddingProfileV1 } from "@workbench/workbench-knowledge";

import {
  HuggingFaceTokenizerAdapter,
  TokenizerArtifactError,
  huggingFaceTokenizerArtifactIdentity,
} from "../src/knowledge/huggingface-tokenizer.adapter.js";
import { TerminalKnowledgeBuildError } from "../src/knowledge/knowledge.errors.js";

const tokenizerJson = jsonBytes({
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: [
    addedToken(0, "[PAD]"),
    addedToken(1, "[UNK]"),
    addedToken(2, "[CLS]"),
    addedToken(3, "[SEP]"),
  ],
  normalizer: {
    type: "BertNormalizer",
    clean_text: true,
    handle_chinese_chars: true,
    strip_accents: null,
    lowercase: true,
  },
  pre_tokenizer: { type: "BertPreTokenizer" },
  post_processor: {
    type: "TemplateProcessing",
    single: [
      { SpecialToken: { id: "[CLS]", type_id: 0 } },
      { Sequence: { id: "A", type_id: 0 } },
      { SpecialToken: { id: "[SEP]", type_id: 0 } },
    ],
    pair: [
      { SpecialToken: { id: "[CLS]", type_id: 0 } },
      { Sequence: { id: "A", type_id: 0 } },
      { SpecialToken: { id: "[SEP]", type_id: 0 } },
      { Sequence: { id: "B", type_id: 1 } },
      { SpecialToken: { id: "[SEP]", type_id: 1 } },
    ],
    special_tokens: {
      "[CLS]": { id: "[CLS]", ids: [2], tokens: ["[CLS]"] },
      "[SEP]": { id: "[SEP]", ids: [3], tokens: ["[SEP]"] },
    },
  },
  decoder: { type: "WordPiece", prefix: "##", cleanup: true },
  model: {
    type: "WordPiece",
    unk_token: "[UNK]",
    continuing_subword_prefix: "##",
    max_input_chars_per_word: 100,
    vocab: {
      "[PAD]": 0,
      "[UNK]": 1,
      "[CLS]": 2,
      "[SEP]": 3,
      hello: 4,
      world: 5,
      "产": 6,
      "品": 7,
      "工": 8,
      "作": 9,
      "台": 10,
    },
  },
});
const tokenizerConfigJson = jsonBytes({
  do_lower_case: true,
  model_max_length: 512,
  tokenizer_class: "BertTokenizer",
});
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("Hugging Face Knowledge tokenizer adapter", () => {
  it("pins both local tokenizer files into one deterministic artifact identity", () => {
    const first = huggingFaceTokenizerArtifactIdentity({ tokenizerJson, tokenizerConfigJson });
    const second = huggingFaceTokenizerArtifactIdentity({ tokenizerJson, tokenizerConfigJson });
    const changed = huggingFaceTokenizerArtifactIdentity({
      tokenizerJson,
      tokenizerConfigJson: jsonBytes({ tokenizer_class: "ChangedTokenizer" }),
    });

    expect(first).toEqual(second);
    expect(first.artifactSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(changed.artifactSha256).not.toBe(first.artifactSha256);
  });

  it("uses the model tokenizer for exact count and reconstructing bounded slices", () => {
    const adapter = createAdapter();

    expect(adapter.count("Hello world")).toBe(4);
    expect(adapter.count("产品工作台")).toBe(7);
    const slices = adapter.split({ text: "产品工作台", maximumTokens: 4 });
    expect(slices.map((slice) => slice.text).join("")).toBe("产品工作台");
    expect(slices.every((slice) => adapter.count(slice.text) <= 4)).toBe(true);
    expect(slices.map((slice) => slice.tokenCount)).toEqual(
      slices.map((slice) => adapter.count(slice.text)),
    );
  });

  it("requires the loaded artifact to match the immutable EmbeddingProfile pin", () => {
    const adapter = createAdapter();
    const matching = embeddingProfile(adapter.artifactIdentity.artifactSha256);
    const mismatched = embeddingProfile("f".repeat(64));

    expect(() => adapter.assertProfile(matching)).not.toThrow();
    expect(() => adapter.assertProfile(mismatched)).toThrowError(TerminalKnowledgeBuildError);
  });

  it("fails closed for malformed tokenizer artifacts", () => {
    expect(() => HuggingFaceTokenizerAdapter.fromArtifacts({
      tokenizerJson: new TextEncoder().encode("not-json"),
      tokenizerConfigJson,
    })).toThrowError(TokenizerArtifactError);
  });

  it("checks regular-file size before reading and rejects symbolic links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbench-tokenizer-"));
    temporaryDirectories.push(directory);
    const tokenizerPath = join(directory, "tokenizer.json");
    const configPath = join(directory, "tokenizer_config.json");
    const linkedConfigPath = join(directory, "linked-tokenizer_config.json");
    await writeFile(tokenizerPath, tokenizerJson);
    await writeFile(configPath, tokenizerConfigJson);
    await symlink(configPath, linkedConfigPath);

    await expect(HuggingFaceTokenizerAdapter.load({
      tokenizerJsonPath: tokenizerPath,
      tokenizerConfigJsonPath: configPath,
      maximumArtifactBytes: tokenizerConfigJson.byteLength,
    })).rejects.toMatchObject({ code: "KNOWLEDGE_TOKENIZER_ARTIFACT_SIZE_INVALID" });
    await expect(HuggingFaceTokenizerAdapter.load({
      tokenizerJsonPath: tokenizerPath,
      tokenizerConfigJsonPath: linkedConfigPath,
    })).rejects.toMatchObject({ code: "KNOWLEDGE_TOKENIZER_ARTIFACT_UNAVAILABLE" });
  });
});

function createAdapter(): HuggingFaceTokenizerAdapter {
  return HuggingFaceTokenizerAdapter.fromArtifacts({ tokenizerJson, tokenizerConfigJson });
}

function embeddingProfile(tokenizerArtifactSha256: string) {
  return parseEmbeddingProfileV1({
    schema: "workbench.embedding-profile.v1",
    id: "embedding-native-tokenizer-v1",
    protocol: "tei.embed.v1",
    engine: {
      id: "text-embeddings-inference",
      version: "1.8.3",
      imageDigest: `sha256:${"1".repeat(64)}`,
    },
    model: {
      id: "example/embedding-model",
      revision: "model-revision-1",
      artifactSha256: "2".repeat(64),
    },
    tokenizer: {
      id: "example/embedding-tokenizer",
      revision: "tokenizer-revision-1",
      artifactSha256: tokenizerArtifactSha256,
      modelMaximumTokens: 512,
      chunkMaximumTokens: 128,
      overflow: "reject",
    },
    input: {
      queryPrefix: "query: ",
      documentPrefix: "passage: ",
      normalization: "utf8-nfc-lf-v1",
    },
    output: {
      dimension: 3,
      dtype: "float32",
      pooling: "cls",
      normalization: "l2",
      distance: "cosine",
    },
    batch: { maximumInputs: 4, maximumTokens: 512 },
    conformanceProbeSha256: "3".repeat(64),
  });
}

function addedToken(id: number, content: string) {
  return {
    id,
    content,
    single_word: false,
    lstrip: false,
    rstrip: false,
    normalized: false,
    special: true,
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
