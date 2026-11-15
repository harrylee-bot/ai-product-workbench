import { PrismaClient } from "@workbench/workbench-db";
import { createSourcePrototypePreviewToken } from "@workbench/workbench-preview-token";
import { PreviewService } from "../../workbench-preview/src/preview.service.js";
import { preparePreviewResponse } from "../../workbench-preview/src/preview-request.js";
import { seedPrototypeRelease } from "./prototype-release.fixture.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Current artifact prototype preview PostgreSQL", () => {
  it("binds public preview to an immutable released version and rechecks expiration, revocation and membership", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const rollback = new Error("ROLLBACK_ARTIFACT_PREVIEW_TEST");
    let verified = false;
    try {
      await db.$transaction(
        async (tx) => {
          const owner = await tx.principal.create({
            data: { issuer: `artifact-preview-${suffix}`, subject: "owner" },
          });
          const viewer = await tx.principal.create({
            data: { issuer: `artifact-preview-${suffix}`, subject: "viewer" },
          });
          const workspace = await tx.workspace.create({
            data: {
              slug: `artifact-preview-${suffix}`,
              name: "Artifact preview",
              createdById: owner.id,
            },
          });
          await tx.workspaceMember.create({
            data: {
              workspaceId: workspace.id,
              principalId: owner.id,
              role: "owner",
            },
          });
          const project = await tx.project.create({
            data: {
              workspaceId: workspace.id,
              createdById: owner.id,
              title: "Released prototype",
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
          const release = await seedPrototypeRelease(
            tx,
            project.id,
            owner.id,
            board.id,
          );
          const version = await tx.artifactVersion.findUniqueOrThrow({
            where: { id: release.artifactVersionId },
          });
          const share = await tx.shareGrant.create({
            data: {
              projectId: project.id,
              releaseId: release.id,
              artifactVersionId: version.id,
              createdById: owner.id,
              idempotencyKey: `preview-${suffix}`,
              requestHash: "a".repeat(64),
              tokenHash: "b".repeat(64),
              scope: "view",
              status: "active",
              expiresAt: new Date(Date.now() + 30_000),
            },
          });
          await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
          await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
          const secret = Buffer.alloc(32, 21);
          const service = new PreviewService(tx as never, {} as never, {
            tokenSecret: secret,
            tokenMaximumTtlSeconds: 60,
            maximumHtmlBytes: 2 * 1024 * 1024,
            webOrigin: "https://workbench.example.test",
          });
          const identity = {
            artifactId: version.artifactId,
            artifactVersionId: version.id,
            checksum: version.checksum,
            expiresAt: new Date(Date.now() + 60_000),
          };
          const publicToken = createSourcePrototypePreviewToken(
            { ...identity, shareId: share.id, shareRevision: share.revision },
            secret,
          );
          const privateToken = createSourcePrototypePreviewToken(
            { ...identity, principalId: viewer.id },
            secret,
          );
          const first = await preparePreviewResponse(service, {
            token: publicToken,
            method: "GET",
          });
          if (first.status !== 200 || first.head)
            throw new Error("Expected rendered released prototype");
          const chunks = [];
          for await (const chunk of first.preview.body)
            chunks.push(Buffer.from(chunk));
          expect(Buffer.concat(chunks).toString()).toContain(
            'data-wb-screen="screen-a"',
          );
          await first.preview.dispose();
          await expect(service.resolve(privateToken)).resolves.toHaveProperty(
            "sourceHtml",
          );
          vi.useFakeTimers();
          vi.setSystemTime(new Date(Date.now() + 31_000));
          await expect(
            preparePreviewResponse(service, {
              token: publicToken,
              method: "GET",
              ifNoneMatch: first.etag,
            }),
          ).rejects.toThrow("PREVIEW_NOT_FOUND");
          vi.useRealTimers();
          await tx.shareGrant.update({
            where: { id: share.id },
            data: {
              status: "revoked",
              revokedAt: new Date(),
              revision: { increment: 1 },
            },
          });
          await expect(service.resolve(publicToken)).rejects.toThrow(
            "PREVIEW_NOT_FOUND",
          );
          await tx.projectMember.delete({
            where: {
              projectId_principalId: {
                projectId: project.id,
                principalId: viewer.id,
              },
            },
          });
          await expect(service.resolve(privateToken)).rejects.toThrow(
            "PREVIEW_NOT_FOUND",
          );
          expect(
            (
              await tx.artifactVersion.findUniqueOrThrow({
                where: { id: version.id },
              })
            ).checksum,
          ).toBe(version.checksum);
          verified = true;
          throw rollback;
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      vi.useRealTimers();
      await db.$disconnect();
    }
    expect(verified).toBe(true);
  }, 40_000);
});
