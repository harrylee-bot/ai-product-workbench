import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { canonicalJson } from "@workbench/workbench-contracts";
import { canonicalSha256 } from "../src/modules/releases/release.mapper.js";
import { hashShareToken, SharesService } from "../src/modules/shares/shares.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function objectStorage() {
  return { getObject: vi.fn() };
}

async function seedShareProject(db: PrismaClient, suffix: string) {
  return db.$transaction(async (tx) => {
    const owner = await tx.principal.create({
      data: { issuer: `share-rotation-${suffix}`, subject: `owner-${suffix}` },
    });
    const workspace = await tx.workspace.create({
      data: {
        slug: `share-rotation-${suffix}`,
        name: "Share rotation",
        createdById: owner.id,
      },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
    });
    const project = await tx.project.create({
      data: { workspaceId: workspace.id, createdById: owner.id, title: "Share rotation" },
    });
    await tx.projectMember.create({
      data: {
        projectId: project.id,
        workspaceId: workspace.id,
        principalId: owner.id,
        role: "owner",
      },
    });
    const board = await tx.board.create({
      data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } },
    });
    const boardSnapshot = {
      id: board.id,
      projectId: project.id,
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    };
    const manifest = {
      protocol: "workbench.project-release.v1",
      projectId: project.id,
      releaseVersion: 1,
      board: { id: board.id, revision: 0, checksum: canonicalSha256(boardSnapshot) },
      artifacts: [],
    };
    const release = await tx.projectRelease.create({
      data: {
        projectId: project.id,
        version: 1,
        createdById: owner.id,
        idempotencyKey: `release:${suffix}`,
        requestHash: createHash("sha256").update(canonicalJson({ suffix })).digest("hex"),
        boardId: board.id,
        boardRevision: 0,
        boardSnapshot: boardSnapshot as Prisma.InputJsonValue,
        boardChecksum: canonicalSha256(boardSnapshot),
        manifest: manifest as Prisma.InputJsonValue,
        manifestSha256: canonicalSha256(manifest),
      },
    });
    await tx.projectRelease.update({
      where: { id: release.id },
      data: { status: "ready", finishedAt: new Date() },
    });
    return { ownerId: owner.id, projectId: project.id, releaseId: release.id };
  });
}

describeWithPostgres("Share rotation PostgreSQL transaction", () => {
  it("serializes concurrent rotations and leaves exactly one active bearer token", async () => {
    const setup = new PrismaClient({ datasourceUrl: databaseUrl });
    const left = new PrismaClient({ datasourceUrl: databaseUrl });
    const right = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const fixture = await seedShareProject(setup, suffix);
    const request = { releaseId: fixture.releaseId, scope: "remix" as const, expiresAt: null };
    const leftService = new SharesService(left as never, {} as never, objectStorage() as never);
    const rightService = new SharesService(right as never, {} as never, objectStorage() as never);

    try {
      const results = await Promise.all([
        leftService.rotate(fixture.ownerId, fixture.projectId, `share:left:${suffix}`, request),
        rightService.rotate(fixture.ownerId, fixture.projectId, `share:right:${suffix}`, request),
      ]);
      const grants = await setup.shareGrant.findMany({
        where: { projectId: fixture.projectId },
        orderBy: { createdAt: "asc" },
      });
      const active = grants.filter((grant) => grant.status === "active");

      expect(grants).toHaveLength(2);
      expect(active).toHaveLength(1);
      expect(grants.filter((grant) => grant.status === "revoked")).toHaveLength(1);
      expect(results.some((result) => hashShareToken(result.token) === active[0]?.tokenHash)).toBe(true);
      await expect(setup.$executeRaw`
        INSERT INTO "share_grants" (
          "id", "project_id", "release_id", "created_by_id", "idempotency_key",
          "request_hash", "token_hash", "scope", "status", "revision", "created_at", "updated_at"
        ) VALUES (
          ${`share_duplicate_${suffix}`}, ${fixture.projectId}, ${fixture.releaseId}, ${fixture.ownerId},
          ${`share:duplicate:${suffix}`}, ${"a".repeat(64)}, ${"b".repeat(64)},
          'view', 'active', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).rejects.toMatchObject({ code: "P2010" });
    } finally {
      await Promise.all([setup.$disconnect(), left.$disconnect(), right.$disconnect()]);
    }
  }, 20_000);

  it("retries a lost response by rotating to a fresh token under the same request identity", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const fixture = await seedShareProject(db, suffix);
    const service = new SharesService(db as never, {} as never, objectStorage() as never);
    const request = { releaseId: fixture.releaseId, scope: "view" as const, expiresAt: null };
    const key = `share:retry:${suffix}`;

    try {
      const first = await service.rotate(fixture.ownerId, fixture.projectId, key, request);
      const retry = await service.rotate(fixture.ownerId, fixture.projectId, key, request);
      const grants = await db.shareGrant.findMany({
        where: { projectId: fixture.projectId, idempotencyKey: key },
        orderBy: { createdAt: "asc" },
      });

      expect(retry.token).not.toBe(first.token);
      expect(retry.share.id).not.toBe(first.share.id);
      expect(retry.revokedGrantCount).toBe(1);
      expect(grants.map((grant) => grant.status).sort()).toEqual(["active", "revoked"]);
      expect(new Set(grants.map((grant) => grant.requestHash))).toEqual(new Set([
        createHash("sha256").update(canonicalJson(request)).digest("hex"),
      ]));
      await expect(service.getPublic(first.token)).rejects.toMatchObject({ status: 404 });
      await expect(service.getPublic(retry.token)).resolves.toMatchObject({
        share: { shareId: retry.share.id },
      });
    } finally {
      await db.$disconnect();
    }
  }, 20_000);
});
