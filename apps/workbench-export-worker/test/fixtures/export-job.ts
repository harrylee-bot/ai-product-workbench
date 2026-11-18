import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@workbench/workbench-contracts";
import type { PrismaClient } from "@workbench/workbench-db";

export function digest(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function seedExport(db: PrismaClient, title: string) {
  const suffix = randomUUID();
  return db.$transaction(async (tx) => {
    const { id: ownerId } = await tx.principal.create({ data: { issuer: "export-integration-test", subject: suffix }, select: { id: true } });
    const { id: workspaceId } = await tx.workspace.create({
      data: { slug: "export-test-" + suffix, name: title, createdById: ownerId }, select: { id: true },
    });
    await tx.workspaceMember.create({ data: { workspaceId, principalId: ownerId, role: "owner" } });
    const { id: projectId } = await tx.project.create({
      data: { workspaceId, createdById: ownerId, title }, select: { id: true },
    });
    await tx.projectMember.create({ data: { projectId, workspaceId, principalId: ownerId, role: "owner" } });
    const viewport = { x: 0, y: 0, zoom: 1 };
    const board = await tx.board.create({ data: { projectId, viewport }, select: { id: true, revision: true } });
    const boardSnapshot = { id: board.id, projectId, revision: board.revision, viewport, nodes: [], edges: [] };
    const boardChecksum = digest(canonicalJson(boardSnapshot));
    const manifest = {
      protocol: "workbench.project-release.v1", projectId, releaseVersion: 1,
      board: { id: board.id, revision: board.revision, checksum: boardChecksum }, artifacts: [],
    };
    const { id: releaseId } = await tx.projectRelease.create({
      data: {
        projectId, version: 1, createdById: ownerId, idempotencyKey: suffix,
        requestHash: digest(suffix), boardId: board.id, boardRevision: board.revision,
        boardSnapshot, boardChecksum, manifest, manifestSha256: digest(canonicalJson(manifest)),
      },
      select: { id: true },
    });
    await tx.projectRelease.update({ where: { id: releaseId }, data: { status: "ready", finishedAt: new Date() }, select: { id: true } });
    const { id: exportJobId } = await tx.exportJob.create({
      data: {
        releaseId, createdById: ownerId, idempotencyKey: suffix, requestHash: digest(suffix + ":export"),
        format: "html", packaging: "single_file", selectionKind: "release", options: {},
      },
      select: { id: true },
    });
    return { ownerId, projectId, releaseId, exportJobId };
  });
}
