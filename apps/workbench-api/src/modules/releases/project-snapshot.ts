import { Prisma } from "@workbench/workbench-db";
import {
  projectReleaseArtifactPinSchema,
  projectReleaseBoardSnapshotSchema,
  type ProjectReleaseArtifactPin,
} from "@workbench/workbench-contracts";

import {
  notFoundProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { artifactVersionScreenIds } from "../artifacts/artifact-screen-reference.js";
import { mapBoard } from "../boards/board.mapper.js";
import { canonicalSha256 } from "./release.mapper.js";

export async function loadPinnedProjectSnapshot(
  tx: Prisma.TransactionClient,
  projectId: string,
  boardId: string,
  expectedBoardRevision: number,
) {
  const boards = await tx.$queryRaw<Array<{ id: string; revision: number }>>(
    Prisma.sql`
      SELECT "id", "revision"
      FROM "boards"
      WHERE "id" = ${boardId} AND "project_id" = ${projectId}
      FOR SHARE
    `,
  );
  const lockedBoard = boards[0];
  if (!lockedBoard) throw notFoundProblem("Project board");
  if (lockedBoard.revision !== expectedBoardRevision) throw revisionConflictProblem();

  const board = await tx.board.findUniqueOrThrow({
    where: { id: lockedBoard.id },
    include: {
      nodes: { orderBy: { nodeKey: "asc" } },
      edges: { orderBy: { edgeKey: "asc" } },
    },
  });
  const boardSnapshot = projectReleaseBoardSnapshotSchema.parse(mapBoard(board));
  const boardChecksum = canonicalSha256(boardSnapshot);
  const artifacts = await tx.$queryRaw<Array<{
    id: string;
    title: string;
    currentVersionId: string | null;
  }>>(Prisma.sql`
    SELECT "id", "title", "current_version_id" AS "currentVersionId"
    FROM "artifacts"
    WHERE "project_id" = ${projectId}
    ORDER BY "id"
    FOR SHARE
  `);
  const artifactPins = await buildProjectArtifactPins(tx, projectId, boardSnapshot, artifacts);
  return { board, boardSnapshot, boardChecksum, artifactPins };
}

export async function buildProjectArtifactPins(
  tx: Prisma.TransactionClient,
  projectId: string,
  board: ReturnType<typeof projectReleaseBoardSnapshotSchema.parse>,
  artifacts: Array<{ id: string; title: string; currentVersionId: string | null }>,
): Promise<ProjectReleaseArtifactPin[]> {
  const boardVersions = new Map<string, string>();
  for (const node of board.nodes) {
    if (node.artifactId === null || node.artifactVersionId === null) continue;
    const previous = boardVersions.get(node.artifactId);
    if (previous && previous !== node.artifactVersionId) {
      throw validationProblem(`Board references more than one version of Artifact ${node.artifactId}`);
    }
    boardVersions.set(node.artifactId, node.artifactVersionId);
  }
  const knownArtifactIds = new Set(artifacts.map((artifact) => artifact.id));
  for (const artifactId of boardVersions.keys()) {
    if (!knownArtifactIds.has(artifactId)) {
      throw validationProblem("Board contains an Artifact outside the Project");
    }
  }

  const selected = artifacts.flatMap((artifact) => {
    const artifactVersionId = boardVersions.get(artifact.id) ?? artifact.currentVersionId;
    return artifactVersionId
      ? [{ artifactId: artifact.id, artifactVersionId, title: artifact.title }]
      : [];
  });
  if (!selected.length) return [];
  const versions = await tx.artifactVersion.findMany({
    where: { id: { in: selected.map((item) => item.artifactVersionId) } },
    include: {
      artifact: { select: { projectId: true, kind: true } },
      assets: {
        orderBy: { assetId: "asc" },
        include: { blob: { select: { id: true, status: true, deletedAt: true } } },
      },
    },
  });
  const byId = new Map(versions.map((version) => [version.id, version]));
  const screenIdsByVersion = new Map<string, ReadonlySet<string> | null>();
  for (const node of board.nodes) {
    if (
      node.artifactId === null
      || node.artifactVersionId === null
      || node.data.nodeType !== "artifact"
    ) continue;
    const version = byId.get(node.artifactVersionId);
    if (!version || version.artifact.kind !== node.data.artifactKind) {
      throw validationProblem(`Board node ${node.id} does not match its pinned Artifact kind`);
    }
    if (node.data.screenId === undefined) continue;
    let screenIds = screenIdsByVersion.get(version.id);
    if (screenIds === undefined) {
      screenIds = artifactVersionScreenIds(version);
      screenIdsByVersion.set(version.id, screenIds);
    }
    if (!screenIds?.has(node.data.screenId)) {
      throw validationProblem(`Board node ${node.id} references a screen outside its pinned Artifact version`);
    }
  }
  return selected
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    .map((selection, position) => {
      const version = byId.get(selection.artifactVersionId);
      if (
        !version
        || version.status !== "ready"
        || version.artifactId !== selection.artifactId
        || version.projectId !== projectId
        || version.artifact.projectId !== projectId
      ) {
        throw validationProblem(`Artifact ${selection.artifactId} does not have a releasable pinned version`);
      }
      return projectReleaseArtifactPinSchema.parse({
        position,
        artifactId: selection.artifactId,
        artifactVersionId: version.id,
        title: selection.title,
        kind: version.artifact.kind,
        version: version.version,
        schemaVersion: version.schemaVersion,
        checksum: version.checksum,
        assets: version.assets.map((asset) => {
          if (
            asset.artifactVersionId !== version.id
            || asset.artifactId !== version.artifactId
            || asset.projectId !== projectId
            || asset.blob.id !== asset.blobId
            || asset.blob.status !== "ready"
            || asset.blob.deletedAt !== null
          ) {
            throw validationProblem(`Artifact ${selection.artifactId} has an invalid binary asset pin`);
          }
          const byteSize = Number(asset.byteSize);
          if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
            throw validationProblem(`Artifact ${selection.artifactId} has an invalid binary asset size`);
          }
          return {
            assetId: asset.assetId,
            kind: asset.kind,
            blobId: asset.blobId,
            mediaType: asset.mediaType,
            byteSize,
            sha256: asset.sha256,
            metadata: asset.metadata,
          };
        }),
      });
    });
}
