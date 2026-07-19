import { PrismaClient } from "@workbench/workbench-db";
import { AccessService } from "../src/modules/access/access.service.js";
import { ReleasesService } from "../src/modules/releases/releases.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Project release PostgreSQL transaction", () => {
  it("creates an artifact pin through the parent release composite relation", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      const fixture = await db.$transaction(async (tx) => {
        const principal = await tx.principal.create({
          data: { issuer: `release-${suffix}`, subject: `owner-${suffix}` },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `release-${suffix}`,
            name: "Release integration",
            createdById: principal.id,
          },
        });
        await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, principalId: principal.id, role: "owner" },
        });
        const project = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: principal.id,
            title: "Release integration",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: project.id,
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        const board = await tx.board.create({
          data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } },
        });
        const artifact = await tx.artifact.create({
          data: { projectId: project.id, kind: "data", title: "Pinned artifact" },
        });
        const artifactVersion = await tx.artifactVersion.create({
          data: {
            artifactId: artifact.id,
            projectId: project.id,
            version: 1,
            schemaVersion: 1,
            status: "ready",
            content: { rows: [{ value: 1 }] },
            checksum: "a".repeat(64),
            citations: [],
          },
        });
        await tx.artifact.update({
          where: { id: artifact.id },
          data: { currentVersionId: artifactVersion.id },
        });
        return {
          principalId: principal.id,
          projectId: project.id,
          boardId: board.id,
          artifactId: artifact.id,
          artifactVersionId: artifactVersion.id,
        };
      });
      const service = new ReleasesService(
        db as never,
        new AccessService(db as never),
      );

      const release = await service.create(
        fixture.principalId,
        fixture.projectId,
        0,
        `release:create:${suffix}`,
        { boardId: fixture.boardId, boardRevision: 0 },
      );
      const stored = await db.projectRelease.findUniqueOrThrow({
        where: { id: release.id },
        include: { artifactPins: true },
      });

      expect(release).toMatchObject({ status: "ready", version: 1 });
      expect(stored.projectId).toBe(fixture.projectId);
      expect(stored.artifactPins).toEqual([
        expect.objectContaining({
          releaseId: release.id,
          projectId: fixture.projectId,
          artifactId: fixture.artifactId,
          artifactVersionId: fixture.artifactVersionId,
          position: 0,
        }),
      ]);
    } finally {
      await db.$disconnect();
    }
  }, 20_000);
});
