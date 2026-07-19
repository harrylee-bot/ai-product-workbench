import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
  type KnowledgeReleaseBundle,
  type TokenizerPort,
  type VaultSourceInput,
} from "@workbench/workbench-knowledge";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JiebaSegmenterAdapter, knowledgeDefaultDictionaryChecksum, knowledgeSegmenterId, knowledgeSegmenterVersion } from "../src/knowledge/jieba-segmenter.adapter.js";
import { KnowledgeDeliveryRunner } from "../src/knowledge/knowledge-delivery.runner.js";
import { RetryableKnowledgeBuildError, TerminalKnowledgeBuildError } from "../src/knowledge/knowledge.errors.js";
import { KnowledgeReconciler } from "../src/knowledge/knowledge-reconciler.js";
import { KnowledgeReleaseProcessor } from "../src/knowledge/knowledge-release.processor.js";
import { SafeKnowledgeVaultReader } from "../src/knowledge/safe-vault-reader.js";
import type { KnowledgeBuildStore } from "../src/knowledge/knowledge-build.store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("safe Knowledge Vault reader", () => {
  it("returns a stable, sorted Markdown snapshot and ignores ordinary non-Markdown files", async () => {
    const fixture = await temporaryKnowledgeSource();
    await mkdir(join(fixture.vaultRoot, "00-rules"));
    await writeFile(join(fixture.vaultRoot, "z.md"), "# Z\n", "utf8");
    await writeFile(join(fixture.vaultRoot, "00-rules", "a.md"), "# A\n", "utf8");
    await writeFile(join(fixture.vaultRoot, "ignored.txt"), "ignored", "utf8");

    const snapshot = await reader(fixture).readSnapshot();

    expect(snapshot.sources.map((source) => source.path)).toEqual(["00-rules/a.md", "z.md"]);
    expect(Buffer.from(snapshot.sources[0]!.content).toString("utf8")).toBe("# A\n");
    expect(snapshot.assets).toEqual([]);
  });

  it("fails closed when any Vault entry is a symbolic link", async () => {
    const fixture = await temporaryKnowledgeSource();
    const outside = join(fixture.root, "outside.md");
    await writeFile(outside, "# Outside\n", "utf8");
    await symlink(outside, join(fixture.vaultRoot, "linked.md"));

    await expect(reader(fixture).readSnapshot()).rejects.toMatchObject({
      name: "TerminalKnowledgeBuildError",
      code: "KNOWLEDGE_VAULT_SYMLINK_FORBIDDEN",
    });
  });

  it("reads only explicitly referenced assets and records their verified closure", async () => {
    const fixture = await temporaryKnowledgeSource();
    const payload = Buffer.from("referenced asset\n", "utf8");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(join(fixture.storageRoot, "source-assets", "asset.bin"), payload);
    const outside = join(fixture.root, "outside.bin");
    await writeFile(outside, "must not be read", "utf8");
    await symlink(outside, join(fixture.storageRoot, "imports", "unreferenced.bin"));
    await writeFile(join(fixture.vaultRoot, "asset.md"), storageDocument(
      "storage/source-assets/asset.bin",
      sha256,
      payload.byteLength,
    ));

    const snapshot = await reader(fixture).readSnapshot();

    expect(snapshot.assets).toEqual([expect.objectContaining({
      path: "storage/source-assets/asset.bin",
      byteSize: payload.byteLength,
      sha256,
      symbolicLink: false,
    })]);
    expect(snapshot.assets.map((asset) => asset.path)).not.toContain("storage/imports/unreferenced.bin");
  });

  it("rejects traversal and non-allowlisted storage references before filesystem access", async () => {
    const fixture = await temporaryKnowledgeSource();
    await writeFile(join(fixture.vaultRoot, "invalid.md"), knowledgeDocument([
      "`storage/source-assets/../../outside.bin`",
      "`storage/uploads/chat.bin`",
    ].join("\n")));

    await expect(reader(fixture).readSnapshot()).rejects.toMatchObject({
      name: "TerminalKnowledgeBuildError",
      code: "KNOWLEDGE_INVALID_STORAGE_REFERENCE",
    });
  });

  it("rejects a referenced storage symlink that escapes its allowlisted category", async () => {
    const fixture = await temporaryKnowledgeSource();
    const outside = join(fixture.root, "outside.bin");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(fixture.storageRoot, "source-assets", "escape.bin"));
    await writeFile(join(fixture.vaultRoot, "escape.md"), knowledgeDocument(
      "`storage/source-assets/escape.bin`",
    ));

    await expect(reader(fixture).readSnapshot()).rejects.toMatchObject({
      name: "TerminalKnowledgeBuildError",
      code: "KNOWLEDGE_STORAGE_SYMLINK_ESCAPE",
    });
  });

  it("fails closed for a missing referenced storage asset", async () => {
    const fixture = await temporaryKnowledgeSource();
    await writeFile(join(fixture.vaultRoot, "missing.md"), knowledgeDocument(
      "`storage/imports/missing.pdf`",
    ));

    await expect(reader(fixture).readSnapshot()).rejects.toMatchObject({
      name: "TerminalKnowledgeBuildError",
      code: "KNOWLEDGE_STORAGE_ASSET_UNAVAILABLE",
    });
  });

  it("fails closed when a declared asset checksum does not match the file", async () => {
    const fixture = await temporaryKnowledgeSource();
    const payload = Buffer.from("actual", "utf8");
    await writeFile(join(fixture.storageRoot, "imports", "mismatch.bin"), payload);
    await writeFile(join(fixture.vaultRoot, "mismatch.md"), storageDocument(
      "storage/imports/mismatch.bin",
      "0".repeat(64),
      payload.byteLength,
    ));

    await expect(reader(fixture).readSnapshot()).rejects.toMatchObject({
      name: "TerminalKnowledgeBuildError",
      code: "KNOWLEDGE_STORAGE_CHECKSUM_MISMATCH",
    });
  });
});

describe("Knowledge release construction", () => {
  it("uses the open-source tokenizer and segmenter while publishing a deterministic bundle", async () => {
    const store = knowledgeStore();
    const tokenizer = releaseTestTokenizer();
    const segmenter = new JiebaSegmenterAdapter(["的"]);
    const processor = new KnowledgeReleaseProcessor(
      store,
      { readSnapshot: vi.fn(async () => ({ sources: [vaultSource()], assets: [], storageDirectoryReferences: [] })) },
      tokenizer,
      segmenter,
      {
        segmenter: {
          id: knowledgeSegmenterId,
          version: knowledgeSegmenterVersion,
          dictionaryChecksum: knowledgeDefaultDictionaryChecksum,
          stopwordsChecksum: segmenter.stopwordsChecksum,
        },
      },
      embeddingPort(),
    );

    await expect(processor.build(command())).resolves.toBe("ready");
    expect(store.stageChunks).toHaveBeenCalledOnce();
    const bundle = vi.mocked(store.stageChunks).mock.calls[0]![1] as KnowledgeReleaseBundle;
    expect(bundle.manifestChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.manifest.profile.tokenizer).toEqual({
      id: embeddingProfile.spec.tokenizer.id,
      version: embeddingProfile.spec.tokenizer.revision,
      maximumTokens: embeddingProfile.spec.tokenizer.chunkMaximumTokens,
    });
    expect(bundle.manifest.profile.segmenter).toMatchObject({ id: knowledgeSegmenterId });
    expect(bundle.projections[0]?.lexemes.length).toBeGreaterThan(0);
    expect(bundle.projections[0]?.lexemes).not.toContain("的");
  });

  it("splits long Unicode text without violating the configured token ceiling", () => {
    const tokenizer = new TestTokenizer();
    const text = "知识库用于产品决策。".repeat(100);
    const slices = tokenizer.split({ text, maximumTokens: 20 });

    expect(slices.map((slice) => slice.text).join("")).toBe(text);
    expect(slices.every((slice) => tokenizer.count(slice.text) <= 20)).toBe(true);
  });

  it("publishes the reader-verified storage closure in the immutable manifest", async () => {
    const fixture = await temporaryKnowledgeSource();
    const payload = Buffer.from("release asset", "utf8");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(join(fixture.storageRoot, "imports", "release.bin"), payload);
    await writeFile(join(fixture.vaultRoot, "release.md"), storageDocument(
      "storage/imports/release.bin",
      sha256,
      payload.byteLength,
    ));
    const store = knowledgeStore();
    const segmenter = new JiebaSegmenterAdapter(["的"]);
    const processor = new KnowledgeReleaseProcessor(
      store,
      reader(fixture),
      releaseTestTokenizer(),
      segmenter,
      {
        segmenter: {
          id: knowledgeSegmenterId,
          version: knowledgeSegmenterVersion,
          dictionaryChecksum: knowledgeDefaultDictionaryChecksum,
          stopwordsChecksum: segmenter.stopwordsChecksum,
        },
      },
      embeddingPort(),
    );

    await expect(processor.build(command())).resolves.toBe("ready");
    const bundle = vi.mocked(store.stageChunks).mock.calls[0]![1] as KnowledgeReleaseBundle;
    expect(bundle.manifest.assetClosure).toMatchObject({
      referencedAssetCount: 1,
      referencedBytes: payload.byteLength,
      assets: [{ path: "storage/imports/release.bin", sha256, byteSize: payload.byteLength }],
    });
    expect(bundle.documents.map((document) => document.sourcePath)).toEqual(["release.md"]);
    expect(bundle.chunks.every((chunk) => !chunk.sourceLocator.includes("storage/"))).toBe(true);
  });
});

describe("Knowledge delivery recovery", () => {
  it("commits terminal failures and rethrows retryable failures until the final delivery", async () => {
    const terminalStore = knowledgeStore();
    const terminalProcessor = { build: vi.fn(async () => { throw new TerminalKnowledgeBuildError("INVALID", "invalid"); }) };
    const terminalRunner = new KnowledgeDeliveryRunner(terminalStore, terminalProcessor as never, 3, 1_000);
    await expect(terminalRunner.run("release-1", delivery(0, 2))).resolves.toBe("failed");
    expect(terminalStore.fail).toHaveBeenCalledOnce();

    const retryStore = knowledgeStore();
    const retryProcessor = { build: vi.fn(async () => { throw new RetryableKnowledgeBuildError("TEMP", "temporary"); }) };
    const retryRunner = new KnowledgeDeliveryRunner(retryStore, retryProcessor as never, 3, 1_000);
    await expect(retryRunner.run("release-1", delivery(0, 2))).rejects.toMatchObject({ code: "TEMP" });
    expect(retryStore.recordRetryableFailure).toHaveBeenCalledWith(expect.anything(), expect.anything(), false);

    vi.mocked(retryStore.recordRetryableFailure).mockResolvedValueOnce("failed");
    await expect(retryRunner.run("release-1", delivery(2, 2))).resolves.toBe("failed");
  });
});

describe("Knowledge release job producer", () => {
  it("uses a release singleton for resumable building releases and exhausts the attempt budget", async () => {
    const store = knowledgeStore();
    vi.mocked(store.findReconciliationCandidates).mockResolvedValue([
      { releaseId: "release-staged", attemptCount: 2 },
      { releaseId: "release-exhausted", attemptCount: 6 },
    ]);
    const queue = { send: vi.fn(async () => "job-reconciled") };
    const producer = new KnowledgeReconciler(store, queue, 6, 300_000, 100, 60_000);

    await producer.runOnce();

    expect(queue.send).toHaveBeenCalledWith(
      "knowledge.release.build",
      { releaseId: "release-staged" },
      { singletonKey: "release-staged" },
    );
    expect(store.exhaust).toHaveBeenCalledWith(
      "release-exhausted",
      "KNOWLEDGE_RELEASE_RECONCILER_EXHAUSTED",
    );
  });
});

function knowledgeStore(): KnowledgeBuildStore {
  return {
    beginDelivery: vi.fn(async () => ({ kind: "run", command: command() })),
    touchLease: vi.fn(async () => undefined),
    stageChunks: vi.fn(async () => "staged" as const),
    claimNextEmbeddingBatch: vi.fn(async () => null),
    publishEmbeddingBatch: vi.fn(async () => "published" as const),
    finalize: vi.fn(async () => "ready" as const),
    fail: vi.fn(async () => "failed" as const),
    recordRetryableFailure: vi.fn(async () => null),
    exhaust: vi.fn(async () => "failed" as const),
    findReconciliationCandidates: vi.fn(async () => []),
  };
}

function command() {
  return {
    releaseId: "release-1",
    releaseKey: "global-product-knowledge",
    releaseVersion: 1,
    leaseToken: "job-1:0",
    chunksReady: false,
    embeddingProfile,
    retrievalProfile,
    delivery: { queueJobId: "job-1", retryCount: 0, retryLimit: 2 },
  };
}

const embeddingProfile = parseEmbeddingProfileV1({
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

const retrievalProfile = parseRetrievalProfileV1({
  schema: "workbench.retrieval-profile.v1",
  id: "test-retrieval-r1",
  embedding: {
    profileId: embeddingProfile.spec.id,
    profileSpecSha256: embeddingProfile.specSha256,
    dimension: embeddingProfile.dimension,
  },
  segmenter: {
    implementationId: knowledgeSegmenterId,
    version: knowledgeSegmenterVersion,
    artifactSha256: knowledgeDefaultDictionaryChecksum,
    algorithm: "cut_for_search",
    hmm: false,
    dictionarySha256: knowledgeDefaultDictionaryChecksum,
    stopwordsSha256: new JiebaSegmenterAdapter(["的"]).stopwordsChecksum,
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
      id: "test-reranker-tei",
      version: "1.8.3",
      imageDigest: `sha256:${"5".repeat(64)}`,
    },
    model: { id: "test/reranker", revision: "commit-r1", artifactSha256: "6".repeat(64) },
    tokenizer: {
      id: "test/reranker-tokenizer",
      revision: "commit-r1",
      artifactSha256: "7".repeat(64),
      maximumInputTokens: 512,
      overflow: "reject",
    },
    candidateLimit: 24,
    finalResultLimit: 10,
    failurePolicy: "degrade_to_rrf",
    conformanceProbeSha256: "8".repeat(64),
  },
  routingPolicy: "workbench-knowledge-route-v1",
  citationSchema: "workbench.knowledge-citation.v1",
});

function embeddingPort() {
  return {
    assertProfile: vi.fn(async () => undefined),
    embedDocuments: vi.fn(async (_profile: unknown, inputs: readonly unknown[]) => ({
      vectors: inputs.map(() => [1, 0, 0]),
      tokenCounts: inputs.map(() => 3),
    })),
  };
}

function releaseTestTokenizer() {
  return new TestTokenizer();
}

class TestTokenizer implements TokenizerPort {
  readonly assertProfile = vi.fn(() => undefined);

  count(text: string): number {
    return Array.from(text).length;
  }

  split(input: { readonly text: string; readonly maximumTokens: number }) {
    if (!Number.isSafeInteger(input.maximumTokens) || input.maximumTokens < 1) {
      throw new RangeError("maximumTokens must be a positive safe integer");
    }
    const characters = Array.from(input.text);
    const slices = [];
    for (let start = 0; start < characters.length; start += input.maximumTokens) {
      const text = characters.slice(start, start + input.maximumTokens).join("");
      slices.push({ text, tokenCount: this.count(text) });
    }
    return slices;
  }
}

function delivery(retryCount: number, retryLimit: number) {
  return { queueJobId: "job-1", retryCount, retryLimit };
}

function vaultSource(): VaultSourceInput {
  return {
    path: "00-rules/product.md",
    content: [
      "---",
      "title: 产品规则",
      "status: 已生效",
      "tags: []",
      "aliases: []",
      "---",
      "",
      "# 产品规则",
      "",
      "知识库的规则用于产品决策。",
      "",
    ].join("\n"),
  };
}

async function temporaryKnowledgeSource() {
  const directory = await mkdtemp(join(tmpdir(), "workbench-knowledge-"));
  temporaryDirectories.push(directory);
  const vaultRoot = join(directory, "knowledge-vault");
  const storageRoot = join(directory, "storage");
  await mkdir(vaultRoot);
  await mkdir(join(storageRoot, "source-assets"), { recursive: true });
  await mkdir(join(storageRoot, "imports"), { recursive: true });
  return { root: directory, vaultRoot, storageRoot };
}

function reader(fixture: { vaultRoot: string; storageRoot: string }) {
  return new SafeKnowledgeVaultReader(fixture.vaultRoot, fixture.storageRoot, {
    maximumFileBytes: 1_024 * 1_024,
    maximumTotalBytes: 2 * 1_024 * 1_024,
    maximumMarkdownFiles: 100,
    maximumEntries: 200,
    maximumAssetFileBytes: 2 * 1_024 * 1_024,
    maximumAssetTotalBytes: 4 * 1_024 * 1_024,
    maximumAssets: 100,
  });
}

function storageDocument(path: string, sha256: string, byteSize: number): string {
  return knowledgeDocument([
    "| 项目 | 内容 |",
    "| --- | --- |",
    `| 资产 | \`${path}\` |`,
    `| SHA-256 | \`${sha256}\` |`,
    `| byteSize | ${byteSize} bytes |`,
  ].join("\n"));
}

function knowledgeDocument(body: string): string {
  return [
    "---",
    "title: 测试知识",
    "status: 已生效",
    "tags: []",
    "aliases: []",
    "---",
    "",
    "# 测试知识",
    "",
    body,
    "",
  ].join("\n");
}
