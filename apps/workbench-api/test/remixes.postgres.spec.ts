import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { boardNodeProtocol, canonicalJson } from "@workbench/workbench-contracts";
import { hashShareToken, RemixesService } from "../src/modules/remixes/remixes.service.js";
import { seedPrototypeRelease } from "./prototype-release.fixture.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value as never)).digest("hex");
}

function shareToken(value: string) {
  return `wbs_${createHash("sha256").update(value).digest("base64url")}`;
}

async function seedRemixRaceFixture(db: PrismaClient, token: string, suffix: string) {
  return db.$transaction(async (tx) => {
    const sourceOwner = await tx.principal.create({
      data: { issuer: `remix-race-${suffix}`, subject: `source-owner-${suffix}` },
    });
    const requester = await tx.principal.create({
      data: { issuer: `remix-race-${suffix}`, subject: `requester-${suffix}` },
    });
    const sourceWorkspace = await tx.workspace.create({
      data: {
        slug: `remix-source-${suffix}`,
        name: "Remix source",
        createdById: sourceOwner.id,
      },
    });
    const targetWorkspace = await tx.workspace.create({
      data: {
        slug: `remix-target-${suffix}`,
        name: "Remix target",
        createdById: requester.id,
      },
    });
    await tx.workspaceMember.createMany({
      data: [
        { workspaceId: sourceWorkspace.id, principalId: sourceOwner.id, role: "owner" },
        { workspaceId: targetWorkspace.id, principalId: requester.id, role: "owner" },
      ],
    });
    const sourceProject = await tx.project.create({
      data: {
        workspaceId: sourceWorkspace.id,
        createdById: sourceOwner.id,
        title: "Remix race source",
      },
    });
    await tx.projectMember.create({
      data: {
        projectId: sourceProject.id,
        workspaceId: sourceWorkspace.id,
        principalId: sourceOwner.id,
        role: "owner",
      },
    });
    const board = await tx.board.create({
      data: { projectId: sourceProject.id, viewport: { x: 0, y: 0, zoom: 1 } },
    });
    const release = await seedPrototypeRelease(tx, sourceProject.id, sourceOwner.id, board.id);
    const share = await tx.shareGrant.create({
      data: {
        projectId: sourceProject.id,
        releaseId: release.id,
        artifactVersionId: release.artifactVersionId,
        createdById: sourceOwner.id,
        idempotencyKey: `share-rotate:${suffix}`,
        requestHash: "f".repeat(64),
        tokenHash: hashShareToken(token),
        scope: "view",
      },
    });
    return {
      requesterId: requester.id,
      targetWorkspaceId: targetWorkspace.id,
      shareId: share.id,
      token,
    };
  });
}

describeWithPostgres("Project remix PostgreSQL transaction", () => {
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

  it("does not turn a read-only Prototype share into a copy of the entire Project", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      const fixture = await seedRemixRaceFixture(db, shareToken(suffix), suffix);
      const service = new RemixesService(db as never);
      await expect(service.create(fixture.requesterId, fixture.token, `remix:${suffix}`, {
        workspaceId: fixture.targetWorkspaceId, title: "Forbidden copy",
      })).rejects.toMatchObject({ status: 404 });
      expect(await db.project.count({ where: { workspaceId: fixture.targetWorkspaceId } })).toBe(0);
      expect(await db.projectLineage.count({ where: { sourceShareId: fixture.shareId } })).toBe(0);
    } finally {
      await db.$disconnect();
    }
  }, 20_000);

  it("does not remix a Share revoked while the command waits for its lock", async () => {
    const setup = new PrismaClient({ datasourceUrl: databaseUrl });
    const revoker = new PrismaClient({ datasourceUrl: databaseUrl });
    const remixer = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const fixture = await seedRemixRaceFixture(setup, shareToken(`share-revoke:${suffix}`), suffix);
    let releaseRevoker: (() => void) | undefined;
    let revokerLocked: (() => void) | undefined;
    let remixAttempted: (() => void) | undefined;
    const releaseFence = new Promise<void>((resolve) => { releaseRevoker = resolve; });
    const lockHeld = new Promise<void>((resolve) => { revokerLocked = resolve; });
    const remixWaiting = new Promise<void>((resolve) => { remixAttempted = resolve; });

    try {
      const revokePromise = revoker.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "share_grants" WHERE "id" = ${fixture.shareId} FOR UPDATE
        `;
        revokerLocked?.();
        await releaseFence;
        await tx.shareGrant.update({
          where: { id: fixture.shareId },
          data: {
            status: "revoked",
            revokedAt: new Date(),
            revision: { increment: 1 },
          },
        });
      });
      await lockHeld;

      const fencedDb = {
        projectLineage: remixer.projectLineage,
        $transaction: (callback: (tx: unknown) => unknown) => remixer.$transaction(async (tx) => {
          let firstLock = true;
          const fenced = new Proxy(tx as object, {
            get(target, property, receiver) {
              if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
              return async (...args: unknown[]) => {
                if (firstLock) {
                  firstLock = false;
                  remixAttempted?.();
                }
                return (tx.$queryRaw as (...values: unknown[]) => Promise<unknown>)(...args);
              };
            },
          });
          return callback(fenced);
        }),
      };
      const service = new RemixesService(fencedDb as never);
      let remixSettled = false;
      const remixPromise = service.create(
        fixture.requesterId,
        fixture.token,
        `remix-revoke:${suffix}`,
        { workspaceId: fixture.targetWorkspaceId },
      ).finally(() => { remixSettled = true; });
      await remixWaiting;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(remixSettled).toBe(false);

      releaseRevoker?.();
      await revokePromise;
      await expect(remixPromise).rejects.toMatchObject({ status: 404 });
      expect(await setup.project.count({ where: { workspaceId: fixture.targetWorkspaceId } })).toBe(0);
      expect(await setup.projectLineage.count({ where: { sourceShareId: fixture.shareId } })).toBe(0);
    } finally {
      releaseRevoker?.();
      await Promise.all([setup.$disconnect(), revoker.$disconnect(), remixer.$disconnect()]);
    }
  }, 20_000);

  it("does not remix after target Workspace membership is removed while waiting", async () => {
    const setup = new PrismaClient({ datasourceUrl: databaseUrl });
    const revoker = new PrismaClient({ datasourceUrl: databaseUrl });
    const remixer = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const fixture = await seedRemixRaceFixture(setup, shareToken(`member-revoke:${suffix}`), suffix);
    let releaseRevoker: (() => void) | undefined;
    let revokerLocked: (() => void) | undefined;
    let membershipAttempted: (() => void) | undefined;
    const releaseFence = new Promise<void>((resolve) => { releaseRevoker = resolve; });
    const lockHeld = new Promise<void>((resolve) => { revokerLocked = resolve; });
    const membershipWaiting = new Promise<void>((resolve) => { membershipAttempted = resolve; });

    try {
      const revokePromise = revoker.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "principal_id"
          FROM "workspace_members"
          WHERE "workspace_id" = ${fixture.targetWorkspaceId}
            AND "principal_id" = ${fixture.requesterId}
          FOR UPDATE
        `;
        revokerLocked?.();
        await releaseFence;
        await tx.workspaceMember.delete({
          where: {
            workspaceId_principalId: {
              workspaceId: fixture.targetWorkspaceId,
              principalId: fixture.requesterId,
            },
          },
        });
      });
      await lockHeld;

      const fencedDb = {
        projectLineage: remixer.projectLineage,
        $transaction: (callback: (tx: unknown) => unknown) => remixer.$transaction(async (tx) => {
          let queryCount = 0;
          const fenced = new Proxy(tx as object, {
            get(target, property, receiver) {
              if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
              return async (...args: unknown[]) => {
                queryCount += 1;
                if (queryCount === 2) membershipAttempted?.();
                return (tx.$queryRaw as (...values: unknown[]) => Promise<unknown>)(...args);
              };
            },
          });
          return callback(fenced);
        }),
      };
      const service = new RemixesService(fencedDb as never);
      let remixSettled = false;
      const remixPromise = service.create(
        fixture.requesterId,
        fixture.token,
        `remix-member-revoke:${suffix}`,
        { workspaceId: fixture.targetWorkspaceId },
      ).finally(() => { remixSettled = true; });
      await membershipWaiting;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(remixSettled).toBe(false);

      releaseRevoker?.();
      await revokePromise;
      await expect(remixPromise).rejects.toMatchObject({ status: 404 });
      expect(await setup.project.count({ where: { workspaceId: fixture.targetWorkspaceId } })).toBe(0);
      expect(await setup.projectLineage.count({ where: { sourceShareId: fixture.shareId } })).toBe(0);
    } finally {
      releaseRevoker?.();
      await Promise.all([setup.$disconnect(), revoker.$disconnect(), remixer.$disconnect()]);
    }
  }, 20_000);
});
