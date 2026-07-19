import { sha256 } from "./checksum.js";
import { vaultLocator } from "./path.js";

export type KnowledgeRetrievalMode = "lexical" | "hybrid";
export type KnowledgeRetrievalRouteScope = "production" | "source_lookup";
export type QueryableKnowledgeRoute = "production" | "source_lookup";

export interface KnowledgeRetrievalPolicy {
  readonly lexicalCandidateLimit: number;
  readonly denseCandidateLimit: number;
  readonly reciprocalRankK: number;
  readonly rerankCandidateLimit: number;
  readonly finalResultLimit: number;
}

export interface KnowledgeRrfCandidate {
  readonly id: string;
}

export interface KnowledgeRrfResult {
  readonly id: string;
  readonly score: number;
  readonly bestRank: number;
  readonly lexicalRank: number | null;
  readonly denseRank: number | null;
}

export function reciprocalRankFusion(
  lexical: readonly KnowledgeRrfCandidate[],
  dense: readonly KnowledgeRrfCandidate[],
  k: number,
): readonly KnowledgeRrfResult[] {
  positiveSafeInteger(k, "k");
  const lexicalRanks = firstRanks(lexical, "lexical");
  const denseRanks = firstRanks(dense, "dense");
  const ids = new Set([...lexicalRanks.keys(), ...denseRanks.keys()]);
  return [...ids].map((id) => {
    const lexicalRank = lexicalRanks.get(id) ?? null;
    const denseRank = denseRanks.get(id) ?? null;
    return {
      id,
      score: (lexicalRank === null ? 0 : 1 / (k + lexicalRank))
        + (denseRank === null ? 0 : 1 / (k + denseRank)),
      bestRank: Math.min(lexicalRank ?? Number.MAX_SAFE_INTEGER, denseRank ?? Number.MAX_SAFE_INTEGER),
      lexicalRank,
      denseRank,
    };
  }).sort(compareRrfResults);
}

export function routesForKnowledgeScope(scope: KnowledgeRetrievalRouteScope): readonly QueryableKnowledgeRoute[] {
  return scope === "source_lookup" ? ["production", "source_lookup"] : ["production"];
}

export interface KnowledgeCitationLocator {
  readonly sourceLocator: string;
  readonly headingPath: readonly string[];
  readonly chunkSequence: number;
}

export interface KnowledgeCitation {
  readonly schema: "workbench.knowledge-citation.v1";
  readonly id: string;
  readonly release: {
    readonly id: string;
    readonly key: string;
    readonly version: number;
  };
  readonly embeddingProfile: {
    readonly id: string;
    readonly specSha256: string;
    readonly dimension: number;
  };
  readonly documentId: string;
  readonly chunkId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly route: QueryableKnowledgeRoute;
  readonly quote: string;
  readonly locator: KnowledgeCitationLocator;
}

export interface KnowledgeCitationInput {
  readonly release: KnowledgeCitation["release"];
  readonly embeddingProfile: KnowledgeCitation["embeddingProfile"];
  readonly documentId: string;
  readonly chunkId: string;
  readonly sourcePath: string;
  readonly sourceLocator?: string;
  readonly title: string;
  readonly route: QueryableKnowledgeRoute;
  readonly headingPath: readonly string[];
  readonly chunkSequence: number;
  readonly content: string;
}

export function createKnowledgeCitation(input: KnowledgeCitationInput): KnowledgeCitation {
  nonEmpty(input.release.id, "release.id");
  nonEmpty(input.release.key, "release.key");
  nonEmpty(input.embeddingProfile.id, "embeddingProfile.id");
  if (!/^[0-9a-f]{64}$/u.test(input.embeddingProfile.specSha256)) {
    throw new TypeError("embeddingProfile.specSha256 must be a lowercase SHA-256 digest");
  }
  positiveSafeInteger(input.release.version, "release.version");
  positiveSafeInteger(input.embeddingProfile.dimension, "embeddingProfile.dimension");
  nonEmpty(input.documentId, "documentId");
  nonEmpty(input.chunkId, "chunkId");
  nonEmpty(input.sourcePath, "sourcePath");
  nonEmpty(input.title, "title");
  if (!Number.isSafeInteger(input.chunkSequence) || input.chunkSequence < 0) {
    throw new TypeError("chunkSequence must be a non-negative safe integer");
  }
  const quote = truncateCodePoints(input.content.trim(), 2_000);
  nonEmpty(quote, "content");
  const sourceLocator = nonEmpty(input.sourceLocator ?? vaultLocator(input.sourcePath), "sourceLocator");
  return {
    schema: "workbench.knowledge-citation.v1",
    id: `knowledge_${sha256(`${input.release.id}\0${input.chunkId}`)}`,
    release: { ...input.release },
    embeddingProfile: { ...input.embeddingProfile },
    documentId: input.documentId,
    chunkId: input.chunkId,
    sourcePath: input.sourcePath,
    title: input.title,
    route: input.route,
    quote,
    locator: {
      sourceLocator,
      headingPath: [...input.headingPath],
      chunkSequence: input.chunkSequence,
    },
  };
}

function firstRanks(candidates: readonly KnowledgeRrfCandidate[], name: string): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    const id = nonEmpty(candidate.id, `${name}[${index}].id`);
    if (!ranks.has(id)) ranks.set(id, index + 1);
  });
  return ranks;
}

function compareRrfResults(left: KnowledgeRrfResult, right: KnowledgeRrfResult): number {
  return right.score - left.score
    || left.bestRank - right.bestRank
    || nullableRank(left.lexicalRank) - nullableRank(right.lexicalRank)
    || nullableRank(left.denseRank) - nullableRank(right.denseRank)
    || compareCodePoints(left.id, right.id);
}

function nullableRank(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonEmpty(value: string, name: string): string {
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty trimmed string without NUL`);
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = [...value];
  return points.length <= maximum ? value : points.slice(0, maximum).join("");
}
