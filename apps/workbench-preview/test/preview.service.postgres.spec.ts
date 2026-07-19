import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { PrismaClient } from "@workbench/workbench-db";
import { createPreviewToken } from "@workbench/workbench-preview-token";
import { describe, expect, it, vi } from "vitest";
import { PreviewService } from "../src/preview.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("PreviewService PostgreSQL authorization", () => {
  it("serves release-less ProjectPreview output and invalidates the token after membership revocation", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const rollback = new Error("ROLLBACK_PREVIEW_SERVICE_POSTGRES_TEST");
    const secret = Buffer.alloc(32, 19);
    const html = Buffer.from("<!doctype html><html><head></head><body>private preview</body></html>");
    const sha256 = createHash("sha256").update(html).digest("hex");
    let verified = false;

    try {
      await db.$transaction(async (tx) => {
        const owner = await tx.principal.create({
          data: { issuer: `preview-service-${suffix}`, subject: `owner-${suffix}` },
        });
        const viewer = await tx.principal.create({
          data: { issuer: `preview-service-${suffix}`, subject: `viewer-${suffix}` },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `preview-service-${suffix}`,
            name: "Preview capability authorization",
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
            title: "Private Preview",
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
        const blob = await tx.blob.create({
          data: {
            sha256,
            storageKey: `preview-service/${suffix}`,
            mediaType: "text/html; charset=utf-8",
            byteSize: BigInt(html.byteLength),
            status: "ready",
            verifiedAt: new Date(),
          },
        });
        const requestHash = "a".repeat(64);
        const idempotencyKey = `preview-${suffix}`.slice(0, 128);
        const exportJob = await tx.exportJob.create({
          data: {
            releaseId: null,
            createdById: viewer.id,
            idempotencyKey: `preview:${idempotencyKey}`,
            requestHash,
            format: "html",
            packaging: "single_file",
            purpose: "preview",
            selectionKind: "release",
            options: {},
          },
        });
        const boardSnapshot = {
          id: board.id,
          projectId: project.id,
          revision: board.revision,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
        };
        const boardChecksum = "b".repeat(64);
        const manifest = {
          protocol: "workbench.project-release.v1",
          projectId: project.id,
          releaseVersion: 1,
          board: {
            id: board.id,
            revision: board.revision,
            checksum: boardChecksum,
          },
          artifacts: [],
        };
        const projectPreview = await tx.projectPreview.create({
          data: {
            projectId: project.id,
            boardId: board.id,
            boardRevision: board.revision,
            boardSnapshot,
            boardChecksum,
            manifest,
            manifestSha256: "c".repeat(64),
            exportJobId: exportJob.id,
            createdById: viewer.id,
            idempotencyKey,
            requestHash,
            expiresAt: new Date(Date.now() + 5 * 60_000),
          },
        });
        await tx.exportJob.update({
          where: { id: exportJob.id },
          data: {
            status: "running",
            startedAt: new Date(),
            revision: { increment: 1 },
          },
        });
        await tx.exportJob.update({
          where: { id: exportJob.id },
          data: {
            status: "succeeded",
            outputBlobId: blob.id,
            finishedAt: new Date(),
            revision: { increment: 1 },
          },
        });
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");

        const storage = {
          stageHtml: vi.fn(async () => ({
            byteSize: html.byteLength,
            inspection: { headEndOffset: 27, scriptSha256: [], styleSha256: [] },
            injectedStream: (markup: string) => ({
              body: Readable.from([]),
              byteSize: html.byteLength + Buffer.byteLength(markup),
            }),
            dispose: vi.fn(async () => undefined),
          })),
        };
        const service = new PreviewService(tx as never, storage as never, {
          tokenSecret: secret,
          tokenMaximumTtlSeconds: 60,
          maximumHtmlBytes: 1024 * 1024,
          webOrigin: "https://workbench.example.com",
        });
        const token = createPreviewToken({
          exportJobId: exportJob.id,
          expiresAt: new Date(Date.now() + 60_000),
        }, secret);

        const rendered = await service.get(token);
        expect(rendered).toMatchObject({
          etag: expect.stringMatching(/^"[a-f0-9]{64}"$/),
        });
        await rendered.dispose();
        expect(storage.stageHtml).toHaveBeenCalledOnce();

        await tx.projectMember.delete({
          where: {
            projectId_principalId: {
              projectId: project.id,
              principalId: viewer.id,
            },
          },
        });
        await expect(service.get(token)).rejects.toThrow("PREVIEW_NOT_FOUND");
        expect(await tx.projectRelease.count({ where: { projectId: project.id } })).toBe(0);
        expect(projectPreview.exportJobId).toBe(exportJob.id);

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
