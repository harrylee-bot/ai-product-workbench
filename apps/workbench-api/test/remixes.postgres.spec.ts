import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { boardNodeProtocol, canonicalJson } from "@workbench/workbench-contracts";
import { hashShareToken } from "../src/modules/shares/shares.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value as never)).digest("hex");
}

describeWithPostgres("Read-only share PostgreSQL constraints", () => {
  it("rejects a whole-project remix grant even when its release graph is complete", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const token = `wbs_${"B".repeat(43)}`;
    const rollback = new Error("ROLLBACK_REMIX_POSTGRES_TEST");
    let verified = false;

    try {
      await db.$transaction(async (tx) => {
        const principal = await tx.principal.create({
          data: { issuer: `remix-test-${suffix}`, subject: `principal-${suffix}` },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `remix-${suffix}`,
            name: "Remix integration",
            createdById: principal.id,
          },
        });
        await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, principalId: principal.id, role: "owner" },
        });
        const sourceProject = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: principal.id,
            title: "Source",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: sourceProject.id,
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        const sourceBoard = await tx.board.create({
          data: {
            projectId: sourceProject.id,
            viewport: { x: 4, y: 5, zoom: 1 },
          },
        });
        const sourceArtifact = await tx.artifact.create({
          data: { projectId: sourceProject.id, kind: "data", title: "Pinned data" },
        });
        const sourceVersion = await tx.artifactVersion.create({
          data: {
            artifactId: sourceArtifact.id,
            projectId: sourceProject.id,
            version: 1,
            schemaVersion: 1,
            status: "ready",
            content: { rows: [1, 2, 3] },
            checksum: "c".repeat(64),
            citations: [],
          },
        });
        await tx.artifact.update({
          where: { id: sourceArtifact.id },
          data: { currentVersionId: sourceVersion.id },
        });
        await tx.boardNode.create({
          data: {
            boardId: sourceBoard.id,
            projectId: sourceProject.id,
            nodeKey: "source-node",
            sortOrder: 0,
            kind: "artifact",
            position: { x: 10, y: 20 },
            artifactId: sourceArtifact.id,
            artifactVersionId: sourceVersion.id,
            data: {
              protocol: boardNodeProtocol,
              nodeType: "artifact",
              title: "Pinned data",
              artifactKind: "data",
              route: `/versions/${sourceVersion.id}`,
            },
          },
        });
        const sourceBoardRevision = (await tx.board.findUniqueOrThrow({
          where: { id: sourceBoard.id },
          select: { revision: true },
        })).revision;

        const boardSnapshot = {
          id: sourceBoard.id,
          projectId: sourceProject.id,
          revision: sourceBoardRevision,
          viewport: { x: 4, y: 5, zoom: 1 },
          nodes: [{
            id: "source-node",
            kind: "artifact",
            parentNodeId: null,
            order: 0,
            position: { x: 10, y: 20 },
            size: null,
            artifactId: sourceArtifact.id,
            artifactVersionId: sourceVersion.id,
            data: {
              protocol: boardNodeProtocol,
              nodeType: "artifact",
              title: "Pinned data",
              artifactKind: "data",
              route: `/versions/${sourceVersion.id}`,
            },
          }],
          edges: [],
        };
        const boardChecksum = sha256(boardSnapshot);
        const manifest = {
          protocol: "workbench.project-release.v1",
          projectId: sourceProject.id,
          releaseVersion: 1,
          board: { id: sourceBoard.id, revision: sourceBoardRevision, checksum: boardChecksum },
          artifacts: [{
            position: 0,
            artifactId: sourceArtifact.id,
            artifactVersionId: sourceVersion.id,
            title: "Pinned data",
            kind: "data",
            version: 1,
            schemaVersion: 1,
            checksum: sourceVersion.checksum,
            assets: [],
          }],
        };
        const release = await tx.projectRelease.create({
          data: {
            projectId: sourceProject.id,
            version: 1,
            createdById: principal.id,
            idempotencyKey: `remix-test:${suffix}`,
            requestHash: "d".repeat(64),
            boardId: sourceBoard.id,
            boardRevision: sourceBoardRevision,
            boardSnapshot: boardSnapshot as Prisma.InputJsonValue,
            boardChecksum,
            manifest: manifest as Prisma.InputJsonValue,
            manifestSha256: sha256(manifest),
          },
        });
        await tx.releaseArtifactVersion.create({
          data: {
            releaseId: release.id,
            projectId: sourceProject.id,
            position: 0,
            artifactId: sourceArtifact.id,
            artifactVersionId: sourceVersion.id,
            title: "Pinned data",
            kind: "data",
          },
        });
        await tx.projectRelease.update({
          where: { id: release.id },
          data: { status: "ready", finishedAt: new Date() },
        });
        await expect(tx.shareGrant.create({
          data: {
            projectId: sourceProject.id,
            releaseId: release.id,
            createdById: principal.id,
            idempotencyKey: `share-rotate:${suffix}`,
            requestHash: "f".repeat(64),
            tokenHash: hashShareToken(token),
            scope: "remix",
          },
        })).rejects.toThrow(/PROTOTYPE_SHARE_PIN_REQUIRED/u);
        verified = true;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$disconnect();
    }
    expect(verified).toBe(true);
  }, 20_000);

});
