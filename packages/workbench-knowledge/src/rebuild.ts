import { canonicalJson, sha256 } from "./checksum.js";
import type {
  JsonValue,
  KnowledgeReleaseBundle,
  KnowledgeRoute,
} from "./types.js";

/**
 * A full rebuild is a new immutable snapshot of the same logical knowledge
 * base.  It deliberately carries the path diff and route counts so a caller
 * cannot mistake a surface document edit for a complete source replacement.
 */
export interface KnowledgeRebuildCurrentRelease {
  readonly releaseKey: string;
  readonly releaseVersion: number;
  readonly documents: readonly {
    readonly sourcePath: string;
    readonly route?: KnowledgeRoute;
  }[];
}

export interface KnowledgeRebuildPlanV1 {
  readonly schema: "workbench.knowledge-rebuild-plan.v1";
  readonly mode: "full-content-rebuild";
  readonly releaseKey: string;
  readonly currentReleaseVersion: number;
  readonly candidateReleaseVersion: number;
  readonly currentDocumentCount: number;
  readonly candidateDocumentCount: number;
  readonly preservedPaths: readonly string[];
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly routeCounts: Readonly<Record<KnowledgeRoute, number>>;
  readonly routeTransitions: readonly {
    readonly sourcePath: string;
    readonly currentRoute: KnowledgeRoute | null;
    readonly candidateRoute: KnowledgeRoute;
  }[];
  readonly sourceClosure: {
    readonly sourceSnapshotSha256: string;
    readonly chunkCount: number;
    readonly referencedAssetCount: number;
    readonly referencedBytes: number;
    readonly manifestChecksum: string;
  };
  readonly invariants: {
    readonly sameLogicalKnowledgeBase: true;
    readonly historyPreserved: true;
    readonly sourceLookupExcludedFromProduction: true;
    readonly incrementalParentRelease: null;
  };
  readonly planSha256: string;
}

export interface KnowledgeRebuildPlanInput {
  readonly current: KnowledgeRebuildCurrentRelease;
  readonly candidate: KnowledgeReleaseBundle;
  readonly candidateReleaseVersion?: number;
}

export class KnowledgeRebuildPlanError extends TypeError {
  readonly code = "KNOWLEDGE_REBUILD_PLAN_INVALID";
}

export function buildKnowledgeRebuildPlan(
  input: KnowledgeRebuildPlanInput,
): KnowledgeRebuildPlanV1 {
  const currentKey = identifier(input.current.releaseKey, "current.releaseKey");
  const currentVersion = positiveInteger(input.current.releaseVersion, "current.releaseVersion");
  const candidateManifest = input.candidate.manifest;
  if (candidateManifest.releaseKey !== currentKey) {
    fail("candidate.manifest.releaseKey", "must reuse the current release key");
  }
  const candidateVersion = input.candidateReleaseVersion
    ?? candidateManifest.releaseVersion;
  if (candidateManifest.releaseVersion !== candidateVersion) {
    fail("candidate.manifest.releaseVersion", "must match candidateReleaseVersion");
  }
  if (candidateVersion !== currentVersion + 1) {
    fail("candidateReleaseVersion", "must be the next immutable version after the current release");
  }

  const currentDocuments = normalizeCurrentDocuments(input.current.documents);
  const candidateDocuments = [...candidateManifest.documents]
    .map((document) => ({ sourcePath: document.sourcePath, route: document.route }))
    .sort((left, right) => compareCodePoints(left.sourcePath, right.sourcePath));
  const candidatePaths = uniquePaths(candidateDocuments.map((document) => document.sourcePath), "candidate");
  const currentPaths = uniquePaths(currentDocuments.map((document) => document.sourcePath), "current");
  const currentSet = new Set(currentPaths);
  const candidateSet = new Set(candidatePaths);
  const preservedPaths = currentPaths.filter((path) => candidateSet.has(path));
  const addedPaths = candidatePaths.filter((path) => !currentSet.has(path));
  const removedPaths = currentPaths.filter((path) => !candidateSet.has(path));
  const currentByPath = new Map(currentDocuments.map((document) => [document.sourcePath, document.route ?? null]));
  const routeCounts = routeCount(candidateDocuments);
  const routeTransitions = candidateDocuments.map((document) => ({
    sourcePath: document.sourcePath,
    currentRoute: currentByPath.get(document.sourcePath) ?? null,
    candidateRoute: document.route,
  }));

  const planWithoutHash = {
    schema: "workbench.knowledge-rebuild-plan.v1" as const,
    mode: "full-content-rebuild" as const,
    releaseKey: currentKey,
    currentReleaseVersion: currentVersion,
    candidateReleaseVersion: candidateVersion,
    currentDocumentCount: currentPaths.length,
    candidateDocumentCount: candidatePaths.length,
    preservedPaths,
    addedPaths,
    removedPaths,
    routeCounts,
    routeTransitions,
    sourceClosure: {
      sourceSnapshotSha256: sha256(canonicalJson({
        documents: candidateManifest.documents.map((document) => ({
          sourcePath: document.sourcePath,
          sourceChecksum: document.sourceChecksum,
          route: document.route,
        })),
        assets: candidateManifest.assetClosure.assets.map((asset) => ({
          path: asset.path,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
        })),
      } as unknown as JsonValue)),
      chunkCount: input.candidate.chunks.length,
      referencedAssetCount: candidateManifest.assetClosure.referencedAssetCount,
      referencedBytes: candidateManifest.assetClosure.referencedBytes,
      manifestChecksum: input.candidate.manifestChecksum,
    },
    invariants: {
      sameLogicalKnowledgeBase: true as const,
      historyPreserved: true as const,
      sourceLookupExcludedFromProduction: true as const,
      incrementalParentRelease: null,
    },
  } satisfies Omit<KnowledgeRebuildPlanV1, "planSha256">;
  const planSha256 = sha256(canonicalJson(planWithoutHash as unknown as JsonValue));
  return deepFreeze({ ...planWithoutHash, planSha256 });
}

function normalizeCurrentDocuments(
  documents: readonly KnowledgeRebuildCurrentRelease["documents"][number][],
) {
  return [...documents]
    .map((document) => ({
      sourcePath: normalizePath(document.sourcePath, "current.documents.sourcePath"),
      ...(document.route ? { route: document.route } : {}),
    }))
    .sort((left, right) => compareCodePoints(left.sourcePath, right.sourcePath));
}

function uniquePaths(paths: readonly string[], name: string): readonly string[] {
  const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
  if (duplicates.length > 0) fail(name, `contains duplicate source path ${duplicates[0]}`);
  return [...paths].sort(compareCodePoints);
}

function routeCount(
  documents: readonly { readonly route: KnowledgeRoute }[],
): Readonly<Record<KnowledgeRoute, number>> {
  const counts: Record<KnowledgeRoute, number> = {
    production: 0,
    source_lookup: 0,
    excluded: 0,
    quarantine: 0,
  };
  for (const document of documents) counts[document.route] += 1;
  return counts;
}

function normalizePath(value: string, name: string): string {
  if (!value || value !== value.trim() || value.includes("\\") || value.startsWith("/") || value.includes("\0")) {
    fail(name, "must be a trimmed relative POSIX path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fail(name, "must not contain empty, dot, or parent path segments");
  }
  return value.normalize("NFC");
}

function identifier(value: string, name: string): string {
  if (!value || value !== value.trim() || value.includes("\0")) fail(name, "must be non-empty and trimmed");
  return value.normalize("NFC");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) fail(name, "must be a positive safe integer");
  return value;
}

function fail(path: string, message: string): never {
  throw new KnowledgeRebuildPlanError(`${path}: ${message}`);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
