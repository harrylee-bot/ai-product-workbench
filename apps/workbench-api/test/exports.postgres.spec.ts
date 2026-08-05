import { PrismaClient } from "@workbench/workbench-db";
import { AccessService } from "../src/modules/access/access.service.js";
import { ExportsService } from "../src/modules/exports/exports.service.js";
import { canonicalSha256 } from "../src/modules/releases/release.mapper.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Project Preview PostgreSQL transaction", () => {
  it("lets a viewer preview a persisted Board without any ProjectRelease", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const rollback = new Error("ROLLBACK_PROJECT_PREVIEW_POSTGRES_TEST");
    let verified = false;

    try {
      await db.$transaction(async (tx) => {
        const owner = await tx.principal.create({
          data: { issuer: `preview-test-${suffix}`, subject: `owner-${suffix}` },
        });
        const viewer = await tx.principal.create({
          data: { issuer: `preview-test-${suffix}`, subject: `viewer-${suffix}` },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `preview-test-${suffix}`,
            name: "Project Preview integration",
            createdById: owner.id,
          },
        });
        await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
        });
        const project = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Preview without Release",
          },
        });
        await tx.projectMember.createMany({
          data: [
            {
              projectId: project.id,
              workspaceId: workspace.id,
              principalId: owner.id,
              role: "owner",
            },
            {
              projectId: project.id,
              workspaceId: workspace.id,
              principalId: viewer.id,
              role: "viewer",
            },
          ],
        });
        const board = await tx.board.create({
          data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } },
        });
        const artifact = await tx.artifact.create({
          data: {
            projectId: project.id,
            kind: "data",
            title: "Preview metrics",
          },
        });
        const artifactContent = {
          protocol: "workbench.data.v1",
          rows: [{ metric: "activation", value: 0.73 }],
        };
        const artifactVersion = await tx.artifactVersion.create({
          data: {
            artifactId: artifact.id,
            projectId: project.id,
            version: 1,
            schemaVersion: 1,
            status: "staging",
            content: artifactContent,
            checksum: canonicalSha256(artifactContent),
            citations: [],
          },
        });
        await tx.artifactVersion.update({
          where: { id: artifactVersion.id },
          data: { status: "ready" },
        });
        await tx.artifact.update({
          where: { id: artifact.id },
          data: { currentVersionId: artifactVersion.id },
        });

        // ExportsService owns its transaction in production. This adapter keeps
        // that boundary while nesting the call in the test rollback transaction.
        const transactionalDb = new Proxy(tx as object, {
          get(target, property, receiver) {
            if (property === "$transaction") {
              return async (callback: (client: typeof tx) => unknown) => callback(tx);
            }
            return Reflect.get(target, property, receiver);
          },
        });
        const queue = {
          sendInTransaction: vi.fn().mockResolvedValue("preview-build-job"),
        };
        const service = new ExportsService(
          transactionalDb as never,
          new AccessService(transactionalDb as never),
          queue as never,
          {} as never,
          {} as never,
          { catalog: () => ({ formats: [] }) } as never,
        );

        const preview = await service.createPreview(
          viewer.id,
          project.id,
          `viewer-preview:${suffix}`,
          {
            boardId: board.id,
            boardRevision: board.revision,
            selection: { kind: "release" },
            initialScreenId: null,
          },
        );

        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "project_previews_complete_snapshot_guard" IMMEDIATE',
        );
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "project_previews_complete_snapshot_guard" DEFERRED',
        );

        expect(preview).toMatchObject({
          projectId: project.id,
          boardId: board.id,
          boardRevision: board.revision,
          initialScreenId: null,
          status: "queued",
        });
        expect(await tx.projectRelease.count({ where: { projectId: project.id } })).toBe(0);
        const persisted = await tx.projectPreview.findUniqueOrThrow({
          where: { id: preview.id },
          include: {
            exportJob: true,
            artifactPins: { orderBy: { position: "asc" } },
          },
        });
        expect(persisted.exportJob).toMatchObject({
          purpose: "preview",
          releaseId: null,
          format: "html",
          createdById: viewer.id,
        });
        expect(persisted.artifactPins).toEqual([
          expect.objectContaining({
            previewId: preview.id,
            projectId: project.id,
            position: 0,
            artifactId: artifact.id,
            artifactVersionId: artifactVersion.id,
            title: "Preview metrics",
            kind: "data",
          }),
        ]);
        expect(persisted.boardChecksum).toBe(canonicalSha256(persisted.boardSnapshot));
        expect(persisted.manifestSha256).toBe(canonicalSha256(persisted.manifest));
        expect(persisted.manifest).toMatchObject({
          projectId: project.id,
          board: {
            id: board.id,
            revision: board.revision,
            checksum: persisted.boardChecksum,
          },
          artifacts: [expect.objectContaining({
            artifactId: artifact.id,
            artifactVersionId: artifactVersion.id,
            checksum: artifactVersion.checksum,
          })],
        });
        expect(await tx.workspaceMember.count({
          where: { workspaceId: workspace.id, principalId: viewer.id },
        })).toBe(0);
        await expect(service.getPreview(viewer.id, preview.id)).resolves.toMatchObject({
          id: preview.id,
          status: "queued",
        });
        await expect(service.list(owner.id, project.id)).resolves.toEqual({
          items: [],
          nextCursor: null,
        });
        await expect(service.get(owner.id, persisted.exportJob.id))
          .rejects.toMatchObject({ status: 404 });
        await expect(service.getContent(owner.id, persisted.exportJob.id))
          .rejects.toMatchObject({ status: 404 });
        await expect(service.cancel(owner.id, persisted.exportJob.id, 0))
          .rejects.toMatchObject({ status: 404 });
        await expect(service.list(viewer.id, project.id)).rejects.toMatchObject({ status: 404 });
        await tx.projectMember.delete({
          where: {
            projectId_principalId: {
              projectId: project.id,
              principalId: viewer.id,
            },
          },
        });
        await expect(service.getPreview(viewer.id, preview.id))
          .rejects.toMatchObject({ status: 404 });
        expect(queue.sendInTransaction).toHaveBeenCalledTimes(1);

        verified = true;
        throw rollback;
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$disconnect();
    }

    expect(verified).toBe(true);
  }, 40_000);
});
