import { createHash } from "node:crypto";
import {
  canonicalJson,
  projectReleaseSchema,
  publicProjectReleaseSchema,
  type ProjectRelease,
  type PublicProjectRelease,
} from "@workbench/workbench-contracts";

export const orderedReleaseArtifactPins = {
  orderBy: { position: "asc" as const },
  include: {
    artifactVersion: {
      include: {
        artifact: { select: { id: true, projectId: true } },
        assets: {
          orderBy: { assetId: "asc" as const },
          include: {
            blob: { select: { id: true, status: true, deletedAt: true } },
          },
        },
      },
    },
  },
} as const;

export type ReleaseRecord = {
  id: string;
  projectId: string;
  version: number;
  status: "building" | "ready" | "failed";
  createdById: string;
  boardId: string;
  boardRevision: number;
  boardSnapshot: unknown;
  boardChecksum: string;
  manifest: unknown;
  manifestSha256: string;
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  updatedAt: Date;
  artifactPins: Array<{
    position: number;
    artifactId: string;
    artifactVersionId: string;
    title: string;
    kind: string;
    artifactVersion: {
      id: string;
      artifactId: string;
      projectId: string;
      version: number;
      schemaVersion: number;
      status: string;
      checksum: string;
      artifact: { id: string; projectId: string };
      assets: Array<{
        artifactVersionId: string;
        artifactId: string;
        projectId: string;
        assetId: string;
        kind: string;
        blobId: string;
        mediaType: string;
        byteSize: bigint;
        sha256: string;
        metadata: unknown;
        blob: { id: string; status: string; deletedAt: Date | null };
      }>;
    };
  }>;
};

export function canonicalSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function mapProjectRelease(record: ReleaseRecord): ProjectRelease {
  for (const pin of record.artifactPins) {
    if (
      pin.artifactVersion.id !== pin.artifactVersionId
      || pin.artifactVersion.artifactId !== pin.artifactId
      || pin.artifactVersion.projectId !== record.projectId
      || pin.artifactVersion.artifact.id !== pin.artifactId
      || pin.artifactVersion.artifact.projectId !== record.projectId
      || pin.artifactVersion.status !== "ready"
    ) {
      throw new Error("PROJECT_RELEASE_ARTIFACT_PIN_MISMATCH");
    }
    for (const asset of pin.artifactVersion.assets) {
      if (
        asset.artifactVersionId !== pin.artifactVersionId
        || asset.artifactId !== pin.artifactId
        || asset.projectId !== record.projectId
        || asset.blob.id !== asset.blobId
        || asset.blob.status !== "ready"
        || asset.blob.deletedAt !== null
      ) {
        throw new Error("PROJECT_RELEASE_ARTIFACT_ASSET_PIN_MISMATCH");
      }
    }
  }
  const artifactPins = record.artifactPins.map((pin) => ({
    position: pin.position,
    artifactId: pin.artifactId,
    artifactVersionId: pin.artifactVersionId,
    title: pin.title,
    kind: pin.kind,
    version: pin.artifactVersion.version,
    schemaVersion: pin.artifactVersion.schemaVersion,
    checksum: pin.artifactVersion.checksum,
    assets: pin.artifactVersion.assets.map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      blobId: asset.blobId,
      mediaType: asset.mediaType,
      byteSize: safeReleaseAssetByteSize(asset.byteSize),
      sha256: asset.sha256,
      metadata: asset.metadata,
    })),
  }));

  if (canonicalSha256(record.boardSnapshot) !== record.boardChecksum) {
    throw new Error("PROJECT_RELEASE_BOARD_CHECKSUM_MISMATCH");
  }
  if (canonicalSha256(record.manifest) !== record.manifestSha256) {
    throw new Error("PROJECT_RELEASE_MANIFEST_CHECKSUM_MISMATCH");
  }

  return projectReleaseSchema.parse({
    id: record.id,
    projectId: record.projectId,
    version: record.version,
    status: record.status,
    createdById: record.createdById,
    boardId: record.boardId,
    boardRevision: record.boardRevision,
    boardSnapshot: record.boardSnapshot,
    boardChecksum: record.boardChecksum,
    artifactPins,
    manifest: record.manifest,
    manifestSha256: record.manifestSha256,
    failure: record.failureCode === null
      ? null
      : { code: record.failureCode, detail: record.failureDetail },
    createdAt: record.createdAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function mapPublicProjectRelease(record: ReleaseRecord): PublicProjectRelease {
  return projectPublicProjectRelease(mapProjectRelease(record));
}

export function projectPublicProjectRelease(release: ProjectRelease): PublicProjectRelease {
  const artifactPins = release.artifactPins.map(({ assets: _assets, ...pin }) => pin);
  const manifestArtifacts = release.manifest.artifacts.map(({ assets: _assets, ...pin }) => pin);
  const { createdById: _createdById, ...publicRelease } = release;
  const boardSnapshot = sanitizePublicJson(publicRelease.boardSnapshot);
  const boardChecksum = canonicalSha256(boardSnapshot);
  const manifest = {
    ...publicRelease.manifest,
    board: { ...publicRelease.manifest.board, checksum: boardChecksum },
    artifacts: manifestArtifacts,
  };
  return publicProjectReleaseSchema.parse({
    ...publicRelease,
    boardSnapshot,
    boardChecksum,
    artifactPins,
    manifest,
    manifestSha256: canonicalSha256(manifest),
  });
}

export function projectPrototypeShareRelease(release: ProjectRelease, versionId: string): ProjectRelease {
  const pin = release.artifactPins.find((candidate) => candidate.artifactVersionId === versionId && candidate.kind === "prototype");
  if (!pin) throw new Error("PROTOTYPE_SHARE_PIN_INVALID");
  const artifactPins = [{ ...pin, position: 0 }];
  // Retain only the selected artifact. Frames, notes and edges may contain private project text.
  const nodes = release.boardSnapshot.nodes.filter((node) => node.artifactVersionId === versionId)
    .map((node, index) => ({ ...node, parentNodeId: null, order: index }));
  const boardSnapshot = { ...release.boardSnapshot, nodes, edges: [] };
  const boardChecksum = canonicalSha256(boardSnapshot);
  const manifest = { ...release.manifest, board: { ...release.manifest.board, checksum: boardChecksum }, artifacts: artifactPins };
  return projectReleaseSchema.parse({
    ...release, boardSnapshot, boardChecksum, artifactPins, manifest, manifestSha256: canonicalSha256(manifest),
  });
}

export function releaseDigestEtag(release: Pick<ProjectRelease, "manifestSha256">) {
  return `"${release.manifestSha256}"`;
}

function safeReleaseAssetByteSize(value: bigint) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("PROJECT_RELEASE_ARTIFACT_ASSET_BYTE_SIZE_INVALID");
  }
  return parsed;
}

export function sanitizePublicJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sanitizePublicJson) as T;
  if (value !== null && typeof value === "object") {
    const forbidden = new Set(["blobId", "contentBlobId", "storageKey", "tokenHash", "createdById"]);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !forbidden.has(key))
        .map(([key, child]) => [key, sanitizePublicJson(child)]),
    ) as T;
  }
  return value;
}
