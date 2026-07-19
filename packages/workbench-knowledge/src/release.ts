import { canonicalJson, sha256 } from "./checksum.js";
import { chunkKnowledgeDocument } from "./chunker.js";
import type { ChineseSegmenterPort, TokenizerPort } from "./ports.js";
import { projectKnowledgeChunk } from "./projection.js";
import { parseKnowledgeSources } from "./parser.js";
import { sortIssues } from "./references.js";
import {
  collectKnowledgeStorageDeclarations,
  knowledgeStorageMediaType,
  KNOWLEDGE_STORAGE_ALLOWED_CATEGORIES,
  normalizeKnowledgeStorageReference,
  validateKnowledgeStorageIntegrity,
  type KnowledgeStorageAssetDeclaration,
} from "./storage-asset-policy.mjs";
import type {
  JsonValue,
  KnowledgeChunk,
  KnowledgeReleaseBundle,
  KnowledgeReleaseDocumentManifest,
  KnowledgeReleaseManifest,
  KnowledgeReleaseProfile,
  ParsedKnowledgeDocument,
  VaultStorageAssetInput,
  VaultSourceInput,
} from "./types.js";

export interface BuildKnowledgeReleaseInput {
  readonly releaseKey: string;
  readonly releaseVersion: number;
  readonly vaultRoot?: string;
  readonly sources: readonly VaultSourceInput[];
  readonly assets: readonly VaultStorageAssetInput[];
  readonly tokenizer: TokenizerPort;
  readonly segmenter?: ChineseSegmenterPort;
  readonly profile: KnowledgeReleaseProfile;
}

export function buildKnowledgeRelease(input: BuildKnowledgeReleaseInput): KnowledgeReleaseBundle {
  const releaseKey = input.releaseKey.trim().normalize("NFC");
  if (!releaseKey) throw new TypeError("releaseKey must be non-empty");
  if (!Number.isSafeInteger(input.releaseVersion) || input.releaseVersion < 1) {
    throw new RangeError("releaseVersion must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.profile.tokenizer.maximumTokens) || input.profile.tokenizer.maximumTokens < 1) {
    throw new RangeError("profile.tokenizer.maximumTokens must be a positive safe integer");
  }
  if (Boolean(input.segmenter) !== Boolean(input.profile.segmenter)) {
    throw new TypeError("segmenter and profile.segmenter must either both be present or both be absent");
  }

  const vaultRoot = (input.vaultRoot ?? "knowledge-vault").trim().normalize("NFC");
  if (!vaultRoot || vaultRoot.includes("/") || vaultRoot.includes("\\")) {
    throw new TypeError("vaultRoot must be a single non-empty path segment");
  }

  const documents = parseKnowledgeSources(input.sources, { vaultRoot });
  const storageDeclarations = collectKnowledgeStorageDeclarations(documents.map((document) => ({
    relativePath: document.sourcePath,
    raw: document.normalizedMarkdown,
  })));
  if (storageDeclarations.issues.length > 0) {
    const issue = storageDeclarations.issues[0]!;
    throw new TypeError(`invalid Knowledge storage closure at ${issue.file}:${issue.line}: ${issue.detail}`);
  }
  const assets = normalizeAssets(input.assets, storageDeclarations.assets, documents);
  const referencedBytes = assets.reduce((total, asset) => total + asset.byteSize, 0);
  if (!Number.isSafeInteger(referencedBytes)) throw new RangeError("storage asset closure byte size exceeds safe integer range");
  const chunks = documents.flatMap((document) => chunkKnowledgeDocument(document, input.tokenizer, {
    maximumTokens: input.profile.tokenizer.maximumTokens,
  }));
  const projections = chunks.map((chunk) => projectKnowledgeChunk(chunk, input.segmenter));
  const issues = sortIssues(documents.flatMap((document) => document.issues));
  const manifest: KnowledgeReleaseManifest = {
    schema: "workbench.knowledge-release.v1",
    releaseKey,
    releaseVersion: input.releaseVersion,
    vaultRoot,
    algorithms: {
      sourceNormalization: "utf8-nfc-lf-v1",
      markdown: "unified-remark-gfm-wikilink-v1",
      routing: "vault-path-status-v1",
      chunking: "heading-atomic-greedy-v1",
      projection: "mdast-retrieval-v1",
      assetClosure: "storage-explicit-reference-v1",
      canonicalJson: "rfc8785-jcs",
      checksum: "sha256",
    },
    profile: normalizeProfile(input.profile),
    documents: documents.map((document) => documentManifest(document, chunks)),
    assetClosure: {
      policy: {
        allowedCategories: [...KNOWLEDGE_STORAGE_ALLOWED_CATEGORIES],
        directoryReferencesExpand: false,
        declaredIntegrityRequiredToMatch: true,
      },
      directoryReferences: storageDeclarations.directoryReferences,
      referencedAssetCount: assets.length,
      referencedBytes,
      assets,
    },
    issues,
  };
  const manifestCanonicalJson = canonicalJson(manifest as unknown as JsonValue);
  return deepFreeze({
    manifest,
    manifestCanonicalJson,
    manifestChecksum: sha256(manifestCanonicalJson),
    documents,
    chunks,
    projections,
  });
}

function normalizeAssets(
  inputs: readonly VaultStorageAssetInput[],
  expectedDeclarations: readonly KnowledgeStorageAssetDeclaration[],
  documents: readonly ParsedKnowledgeDocument[],
): readonly VaultStorageAssetInput[] {
  const sourcePaths = new Set(documents.map((document) => document.sourcePath));
  const seen = new Set<string>();
  const assets = [...inputs]
    .sort((left, right) => compareCodePoints(left.path, right.path))
    .map((input) => {
      const normalized = normalizeKnowledgeStorageReference(input.path);
      if (!normalized.ok || normalized.directory || normalized.logicalPath !== input.path) {
        throw new TypeError(`asset path is not a canonical allowlisted storage file: ${input.path}`);
      }
      if (seen.has(input.path)) throw new TypeError(`duplicate storage asset path: ${input.path}`);
      seen.add(input.path);
      if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
        throw new RangeError(`asset byteSize must be a non-negative safe integer: ${input.path}`);
      }
      const sha256 = input.sha256.trim().toLocaleLowerCase("en-US");
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError(`asset SHA-256 is invalid: ${input.path}`);
      if (input.mediaType !== knowledgeStorageMediaType(input.path)) {
        throw new TypeError(`asset media type does not match its canonical path: ${input.path}`);
      }
      if (typeof input.symbolicLink !== "boolean") throw new TypeError(`asset symbolicLink must be boolean: ${input.path}`);

      const references = uniqueJson(input.references)
        .sort(compareSourceLocations)
        .map((reference) => {
          if (!sourcePaths.has(reference.file)) {
            throw new TypeError(`asset reference does not point to a release source: ${reference.file}`);
          }
          if (!Number.isSafeInteger(reference.line) || reference.line < 1) {
            throw new RangeError(`asset reference line must be a positive safe integer: ${input.path}`);
          }
          if (!["inline-code", "markdown-link", "frontmatter", "bare"].includes(reference.kind)) {
            throw new TypeError(`asset reference kind is invalid: ${input.path}`);
          }
          return { file: reference.file, line: reference.line, kind: reference.kind };
        });
      if (references.length < 1) throw new TypeError(`asset must have at least one Markdown reference: ${input.path}`);

      const declaredIntegrity = {
        sha256: uniqueStrings(input.declaredIntegrity.sha256.map((value) => value.toLocaleLowerCase("en-US"))).sort(compareCodePoints),
        byteSize: [...new Set(input.declaredIntegrity.byteSize)].sort((left, right) => left - right),
        sources: uniqueJson(input.declaredIntegrity.sources).sort(compareSourceLocations),
      };
      const normalizedAsset: VaultStorageAssetInput = {
        path: input.path,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        sha256,
        symbolicLink: input.symbolicLink,
        references,
        declaredIntegrity,
      };
      const integrityIssues = validateKnowledgeStorageIntegrity(normalizedAsset, normalizedAsset);
      if (
        declaredIntegrity.sha256.length > 1
        || declaredIntegrity.byteSize.length > 1
        || integrityIssues.length > 0
      ) {
        throw new TypeError(`asset integrity declaration does not match its verified snapshot: ${input.path}`);
      }
      return normalizedAsset;
    });
  if (assets.length !== expectedDeclarations.length) {
    throw new TypeError("verified storage assets do not match the Markdown reference closure");
  }
  for (const [index, expected] of expectedDeclarations.entries()) {
    const asset = assets[index];
    if (
      asset?.path !== expected.path
      || canonicalJson({
        references: asset.references,
        declaredIntegrity: asset.declaredIntegrity,
      } as unknown as JsonValue) !== canonicalJson({
        references: expected.references,
        declaredIntegrity: expected.declaredIntegrity,
      } as unknown as JsonValue)
    ) {
      throw new TypeError(`verified storage asset does not match its Markdown declaration: ${expected.path}`);
    }
  }
  return assets;
}

function uniqueJson<T>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareSourceLocations(
  left: { readonly file: string; readonly line: number },
  right: { readonly file: string; readonly line: number },
): number {
  return compareCodePoints(left.file, right.file) || left.line - right.line;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function documentManifest(
  document: ParsedKnowledgeDocument,
  chunks: readonly KnowledgeChunk[],
): KnowledgeReleaseDocumentManifest {
  return {
    sourcePath: document.sourcePath,
    sourceLocator: document.sourceLocator,
    sourceChecksum: document.sourceChecksum,
    title: document.title,
    route: document.route,
    ...(document.frontmatter ? { status: document.frontmatter.status } : {}),
    tags: document.frontmatter?.tags ?? [],
    references: document.references,
    chunks: chunks
      .filter((chunk) => chunk.sourceLocator === document.sourceLocator)
      .map((chunk) => ({
        id: chunk.id,
        checksum: chunk.checksum,
        sequence: chunk.sequence,
        headingPath: chunk.headingPath,
        tokenCount: chunk.tokenCount,
      })),
    issues: document.issues,
  };
}

function normalizeProfile(profile: KnowledgeReleaseProfile): KnowledgeReleaseProfile {
  return {
    tokenizer: {
      id: requiredProfileValue(profile.tokenizer.id, "tokenizer.id"),
      version: requiredProfileValue(profile.tokenizer.version, "tokenizer.version"),
      maximumTokens: profile.tokenizer.maximumTokens,
    },
    retrieval: {
      id: requiredProfileValue(profile.retrieval.id, "retrieval.id"),
      specSha256: normalizeProfileChecksum(profile.retrieval.specSha256, "retrieval.specSha256"),
    },
    ...(profile.segmenter ? {
      segmenter: {
        id: requiredProfileValue(profile.segmenter.id, "segmenter.id"),
        version: requiredProfileValue(profile.segmenter.version, "segmenter.version"),
        ...(profile.segmenter.dictionaryChecksum ? {
          dictionaryChecksum: normalizeProfileChecksum(profile.segmenter.dictionaryChecksum, "segmenter.dictionaryChecksum"),
        } : {}),
        ...(profile.segmenter.stopwordsChecksum ? {
          stopwordsChecksum: normalizeProfileChecksum(profile.segmenter.stopwordsChecksum, "segmenter.stopwordsChecksum"),
        } : {}),
      },
    } : {}),
    ...(profile.embedding ? {
      embedding: {
        id: requiredProfileValue(profile.embedding.id, "embedding.id"),
        specSha256: normalizeProfileChecksum(profile.embedding.specSha256, "embedding.specSha256"),
      },
    } : {}),
  };
}

function requiredProfileValue(value: string, field: string): string {
  const normalized = value.trim().normalize("NFC");
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function normalizeProfileChecksum(value: string, field: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new TypeError(`${field} must be a SHA-256 hex digest`);
  return normalized;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
