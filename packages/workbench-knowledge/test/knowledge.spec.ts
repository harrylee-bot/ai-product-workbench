import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildKnowledgeRelease,
  chunkKnowledgeDocument,
  collectKnowledgeStorageDeclarations,
  knowledgeStorageMediaType,
  normalizeMarkdownInput,
  normalizeVaultPath,
  parseKnowledgeSource,
  parseKnowledgeSources,
  type ChineseSegmenterPort,
  type TokenizerPort,
  type VaultSourceInput,
} from "../src/index.js";

const vaultRoot = fileURLToPath(new URL("../../../knowledge-vault", import.meta.url));
const storageRoot = fileURLToPath(new URL("../../../storage", import.meta.url));
const storageAssetClosureFixture = fileURLToPath(new URL("./fixtures/knowledge-storage-asset-closure.v1.json", import.meta.url));

describe("path, frontmatter, and routing", () => {
  it.each([
    ["README.md", "已生效", "production"],
    ["00-规范/a.md", "已整理", "production"],
    ["06-案例/a.md", "仅查来源", "source_lookup"],
    ["07-来源/a.md", "已维护", "source_lookup"],
    ["99-收件箱/a.md", "已处理", "excluded"],
    ["00-规范/a.md", "不参与检索", "excluded"],
    ["_templates/a.md", "草稿", "quarantine"],
  ] as const)("routes %s with status %s to %s", (path, status, route) => {
    const document = parseKnowledgeSource(source(path, status, "# Heading\n\nBody"));
    expect(document.route).toBe(route);
  });

  it("normalizes paths and creates RFC3986 locators", () => {
    expect(normalizeVaultPath("./00-规范\\知识 规则.md")).toEqual({
      valid: true,
      path: "00-规范/知识 规则.md",
      locator: "vault://knowledge-vault/00-%E8%A7%84%E8%8C%83/%E7%9F%A5%E8%AF%86%20%E8%A7%84%E5%88%99.md",
    });
  });

  it("quarantines absolute paths and malformed YAML", () => {
    const absolute = parseKnowledgeSource(source("/tmp/a.md", "已生效", "# A"));
    expect(absolute.route).toBe("quarantine");
    expect(absolute.issues.map((issue) => issue.code)).toContain("INVALID_SOURCE_PATH");

    const malformed = parseKnowledgeSource({
      path: "00-规范/a.md",
      content: "---\ntitle: A\ntitle: B\nstatus: 已生效\ntags: []\naliases: []\n---\n# A",
    });
    expect(malformed.route).toBe("quarantine");
    expect(malformed.issues.map((issue) => issue.code)).toContain("FRONTMATTER_YAML_INVALID");
  });

  it("normalizes UTF-8 source bytes before checksumming", () => {
    const left = parseKnowledgeSource(source("00-规范/a.md", "已生效", "# Café\r\n\r\nBody"));
    const right = parseKnowledgeSource(source("00-规范/a.md", "已生效", "# Cafe\u0301\n\nBody"));
    expect(left.sourceChecksum).toBe(right.sourceChecksum);
    expect(left.normalizedMarkdown).toBe(right.normalizedMarkdown);
  });

  it("quarantines invalid UTF-8 instead of crashing the release", () => {
    const document = parseKnowledgeSource({ path: "00-规范/a.md", content: new Uint8Array([0xc3, 0x28]) });
    expect(document.route).toBe("quarantine");
    expect(document.issues.map((issue) => issue.code)).toContain("INVALID_SOURCE_ENCODING");
  });
});

describe("storage asset closure manifest", () => {
  it("records only verified assets that are explicitly declared by Markdown", () => {
    const sources = [source(
      "00-规范/asset.md",
      "已生效",
      "# Asset\n\n`storage/source-assets/example.bin`",
    )];
    const declaration = collectKnowledgeStorageDeclarations(sources.map((item) => ({
      relativePath: item.path,
      raw: item.content as string,
    }))).assets[0]!;
    const bundle = buildKnowledgeRelease({
      releaseKey: "knowledge-with-assets",
      releaseVersion: 1,
      sources,
      assets: [{
        ...declaration,
        mediaType: "application/octet-stream",
        byteSize: 7,
        sha256: "a".repeat(64),
        symbolicLink: false,
      }],
      tokenizer: characterTokenizer(),
      profile: {
        tokenizer: { id: "test-character", version: "1", maximumTokens: 200 },
        retrieval: { id: "test-retrieval-r1", specSha256: "f".repeat(64) },
      },
    });

    expect(bundle.manifest.assetClosure.assets).toEqual([expect.objectContaining({
      path: "storage/source-assets/example.bin",
      byteSize: 7,
      sha256: "a".repeat(64),
    })]);
    expect(bundle.manifest.assetClosure.referencedAssetCount).toBe(1);
    expect(bundle.manifest.assetClosure.referencedBytes).toBe(7);
    expect(bundle.manifest.algorithms.assetClosure).toBe("storage-explicit-reference-v1");
  });

  it("rejects verified asset metadata that is outside the Markdown reference closure", () => {
    const sources = [source("00-规范/no-assets.md", "已生效", "# No assets\n\nBody")];
    expect(() => buildKnowledgeRelease({
      releaseKey: "knowledge-with-orphan",
      releaseVersion: 1,
      sources,
      assets: [{
        path: "storage/imports/orphan.bin",
        mediaType: "application/octet-stream",
        byteSize: 1,
        sha256: "b".repeat(64),
        symbolicLink: false,
        references: [{ file: "00-规范/no-assets.md", line: 9, kind: "inline-code" }],
        declaredIntegrity: { sha256: [], byteSize: [], sources: [] },
      }],
      tokenizer: characterTokenizer(),
      profile: {
        tokenizer: { id: "test-character", version: "1", maximumTokens: 200 },
        retrieval: { id: "test-retrieval-r1", specSha256: "f".repeat(64) },
      },
    })).toThrow("do not match the Markdown reference closure");
  });
});

describe("Markdown AST and references", () => {
  it("parses GFM tables containing Obsidian aliases without creating extra cells", () => {
    const documents = parseKnowledgeSources([
      source("00-规范/index.md", "已生效", [
        "# Index",
        "",
        "| Name | Reference |",
        "| --- | --- |",
        "| rule | [[00-规范/target|Target label]] |",
        "",
        "`[[ignored|inline]]`",
        "",
        "```text",
        "[[ignored|fence]]",
        "```",
      ].join("\n")),
      source("00-规范/target.md", "已生效", "# Target\n\nBody"),
    ]);
    const index = documents.find((document) => document.sourcePath.endsWith("index.md"))!;
    const table = index.blocks.find((block) => block.kind === "table")!;
    expect(table.retrievalText).toContain("rule | Target label");
    expect(index.references).toHaveLength(1);
    expect(index.references[0]).toMatchObject({
      syntax: "wikilink",
      resolution: "resolved",
      resolvedLocator: "vault://knowledge-vault/00-%E8%A7%84%E8%8C%83/target.md",
    });
  });

  it("resolves relative Markdown links and validates heading anchors", () => {
    const documents = parseKnowledgeSources([
      source("00-规范/nested/index.md", "已生效", "# Index\n\n[Target](../target.md#Target-section)"),
      source("00-规范/target.md", "已生效", "# Target section\n\nBody"),
    ]);
    expect(documents[0]!.references[0]).toMatchObject({
      syntax: "markdown_link",
      resolution: "resolved",
    });
    expect(documents[0]!.issues).toEqual([]);
  });

  it.each([
    ["[missing](missing.md)", "UNRESOLVED_INTERNAL_REFERENCE"],
    ["[absolute](/root.md)", "ABSOLUTE_INTERNAL_REFERENCE"],
    ["[[00-规范/target#Missing heading]]", "UNRESOLVED_HEADING_REFERENCE"],
  ] as const)("quarantines invalid reference %s", (markdown, issueCode) => {
    const documents = parseKnowledgeSources([
      source("00-规范/index.md", "已生效", `# Index\n\n${markdown}`),
      source("00-规范/target.md", "已生效", "# Existing heading\n\nBody"),
    ]);
    const index = documents.find((document) => document.sourcePath.endsWith("index.md"))!;
    expect(index.route).toBe("quarantine");
    expect(index.issues.map((issue) => issue.code)).toContain(issueCode);
  });
});

describe("deterministic heading-aware chunking", () => {
  it("flushes normal atomic blocks without asking the tokenizer to split", () => {
    const tokenizer = characterTokenizer();
    const split = vi.spyOn(tokenizer, "split");
    const document = parseKnowledgeSources([
      source("00-规范/a.md", "已生效", "# H\n\n123456789012345678\n\nabcdefghijklmnopqr"),
    ])[0]!;
    const chunks = chunkKnowledgeDocument(document, tokenizer, { maximumTokens: 60 });
    expect(chunks).toHaveLength(2);
    expect(split).not.toHaveBeenCalled();
  });

  it("calls tokenizer.split only when one atomic block exceeds the budget", () => {
    const tokenizer = characterTokenizer();
    const split = vi.spyOn(tokenizer, "split");
    const document = parseKnowledgeSources([
      source("00-规范/a.md", "已生效", `# H\n\n\`\`\`text\n${"x".repeat(100)}\n\`\`\``),
    ])[0]!;
    const chunks = chunkKnowledgeDocument(document, tokenizer, { maximumTokens: 45 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(split).toHaveBeenCalledTimes(1);
    expect(chunks.every((chunk) => chunk.tokenCount <= 45)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  });

  it("never combines content across heading paths", () => {
    const tokenizer = characterTokenizer();
    const document = parseKnowledgeSources([
      source("00-规范/a.md", "已生效", "# One\n\nFirst\n\n## Two\n\nSecond"),
    ])[0]!;
    const chunks = chunkKnowledgeDocument(document, tokenizer, { maximumTokens: 200 });
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([["One"], ["One", "Two"]]);
  });

  it("represents skipped heading depths without sparse values", () => {
    const document = parseKnowledgeSources([
      source("00-规范/a.md", "已生效", "# One\n\n### Three\n\nBody"),
    ])[0]!;
    expect(document.blocks.find((block) => block.retrievalText === "Body")?.headingPath).toEqual(["One", "Three"]);
  });
});

describe("repository Vault release", () => {
  it("parses the repository Vault and produces an order-independent immutable release", async () => {
    const sources = await readVaultSources();
    expect(sources).toHaveLength(661);
    const assets = await readVaultAssets(sources);
    expect(assets).toHaveLength(10);
    const input = {
      releaseKey: "global-product-knowledge",
      releaseVersion: 1,
      sources,
      assets,
      tokenizer: approximateTokenizer(),
      segmenter: whitespaceSegmenter,
      profile: {
        tokenizer: { id: "test-approximate", version: "1", maximumTokens: 800 },
        retrieval: { id: "test-retrieval-r1", specSha256: "f".repeat(64) },
        segmenter: {
          id: "test-whitespace",
          version: "1",
          dictionaryChecksum: "1".repeat(64),
          stopwordsChecksum: "2".repeat(64),
        },
      },
    } as const;

    const first = buildKnowledgeRelease(input);
    const second = buildKnowledgeRelease({ ...input, sources: [...sources].reverse() });
    expect(first.manifestCanonicalJson).toBe(second.manifestCanonicalJson);
    expect(first.manifestChecksum).toBe(second.manifestChecksum);
    expect(JSON.stringify(first.chunks)).toBe(JSON.stringify(second.chunks));
    expect(JSON.stringify(first.projections)).toBe(JSON.stringify(second.projections));
    expect(first.manifestChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.issues).toMatchObject([{
      code: "UNRESOLVED_HEADING_REFERENCE",
      reference: "07-来源资产索引/旧版整理/01-产品知识/需求文档知识库/业务域索引#运营配置与活动治理",
    }]);
    expect(Object.isFrozen(first)).toBe(true);

    const routeCounts = first.documents.reduce<Record<string, number>>((counts, document) => {
      counts[document.route] = (counts[document.route] ?? 0) + 1;
      return counts;
    }, {});
    expect(routeCounts).toEqual({ production: 34, source_lookup: 594, excluded: 31, quarantine: 2 });
    const unresolved = first.documents.flatMap((document) => document.references.filter((reference) => (
      reference.kind !== "external" && reference.resolution !== "resolved"
    )));
    expect(unresolved).toMatchObject([{
      rawTarget: "07-来源资产索引/旧版整理/01-产品知识/需求文档知识库/业务域索引#运营配置与活动治理",
      resolution: "unresolved",
    }]);
  });
});

function source(path: string, status: string, body: string): VaultSourceInput {
  return {
    path,
    content: [
      "---",
      `title: ${path}`,
      `status: ${status}`,
      "tags: []",
      "aliases: []",
      "---",
      "",
      body,
      "",
    ].join("\n"),
  };
}

function characterTokenizer(): TokenizerPort {
  return {
    count: (text) => Array.from(text).length,
    split: ({ text, maximumTokens }) => {
      const characters = Array.from(text);
      const slices = [];
      for (let index = 0; index < characters.length; index += maximumTokens) {
        const slice = characters.slice(index, index + maximumTokens).join("");
        slices.push({ text: slice, tokenCount: Array.from(slice).length });
      }
      return slices;
    },
  };
}

function approximateTokenizer(): TokenizerPort {
  return {
    count: (text) => Math.ceil(Array.from(text).length / 4),
    split: ({ text, maximumTokens }) => {
      const characters = Array.from(text);
      const size = maximumTokens * 4;
      const slices = [];
      for (let index = 0; index < characters.length; index += size) {
        const slice = characters.slice(index, index + size).join("");
        slices.push({ text: slice, tokenCount: Math.ceil(Array.from(slice).length / 4) });
      }
      return slices;
    },
  };
}

const whitespaceSegmenter: ChineseSegmenterPort = {
  segment: (text) => text.split(/\s+/),
};

async function readVaultSources(): Promise<readonly VaultSourceInput[]> {
  const files = await markdownFiles(vaultRoot);
  return Promise.all(files.map(async (path) => ({
    path: relative(vaultRoot, path).split("\\").join("/"),
    content: await readFile(path),
  })));
}

async function readVaultAssets(sources: readonly VaultSourceInput[]) {
  const declarations = collectKnowledgeStorageDeclarations(sources.map((source) => ({
    relativePath: source.path,
    raw: normalizeMarkdownInput(source.content),
  })));
  expect(declarations.issues).toEqual([]);
  // Keep large raw assets outside source candidates; the committed snapshot supplies clean-source metadata.
  const configuredStorageRoot = process.env.KNOWLEDGE_STORAGE_ROOT?.trim();
  if (configuredStorageRoot) {
    return readVerifiedVaultAssets(declarations.assets, resolve(configuredStorageRoot));
  }
  if (await isDirectory(storageRoot)) {
    return readVerifiedVaultAssets(declarations.assets, storageRoot);
  }
  return readVaultAssetClosureFixture(declarations.assets);
}

async function readVerifiedVaultAssets(
  declarations: ReturnType<typeof collectKnowledgeStorageDeclarations>["assets"],
  root: string,
) {
  return Promise.all(declarations.map(async (declaration) => {
    const absolutePath = resolve(root, declaration.path.slice("storage/".length));
    const fileStats = await stat(absolutePath);
    const linkStats = await lstat(absolutePath);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) digest.update(chunk);
    return {
      ...declaration,
      mediaType: knowledgeStorageMediaType(declaration.path),
      byteSize: fileStats.size,
      sha256: digest.digest("hex"),
      symbolicLink: linkStats.isSymbolicLink(),
    };
  }));
}

async function readVaultAssetClosureFixture(
  declarations: ReturnType<typeof collectKnowledgeStorageDeclarations>["assets"],
) {
  const fixture = JSON.parse(await readFile(storageAssetClosureFixture, "utf8")) as KnowledgeAssetClosureFixture;
  expect(fixture.schema).toBe("workbench.knowledge-asset-closure.v1");
  expect(fixture.assets).toHaveLength(declarations.length);
  expect([...fixture.assets].map((asset) => asset.path)).toEqual(declarations.map((asset) => asset.path));
  expect(fixture.assets.reduce((total, asset) => total + asset.byteSize, 0)).toBe(fixture.totalBytes);

  const metadataByPath = new Map(fixture.assets.map((asset) => [asset.path, asset]));
  return declarations.map((declaration) => {
    const metadata = metadataByPath.get(declaration.path);
    expect(metadata).toBeDefined();
    return {
      ...declaration,
      mediaType: metadata!.mediaType,
      byteSize: metadata!.byteSize,
      sha256: metadata!.sha256,
      symbolicLink: metadata!.symbolicLink,
    };
  });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

interface KnowledgeAssetClosureFixture {
  readonly schema: "workbench.knowledge-asset-closure.v1";
  readonly totalBytes: number;
  readonly assets: readonly KnowledgeAssetClosureFixtureAsset[];
}

interface KnowledgeAssetClosureFixtureAsset {
  readonly path: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly symbolicLink: boolean;
}

async function markdownFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  }));
  return files.flat().sort((left, right) => left.localeCompare(right, "en"));
}
